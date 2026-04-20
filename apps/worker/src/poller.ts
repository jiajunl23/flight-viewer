import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTile } from "./airplaneslive.js";
import { pruneStale, upsertAircraftStates } from "./supabase.js";
import { NA_TILES } from "./tiles.js";

export interface PollerConfig {
  tileIntervalMs: number;
  staleTtlSeconds: number;
  supabase: SupabaseClient;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Rotates through NA_TILES at one tile per tileIntervalMs. Each tick hits one
 * adsb.lol point+radius endpoint and upserts the returned aircraft. A full
 * continental refresh happens every `NA_TILES.length * tileIntervalMs`
 * (default 20s at 1 req/s).
 */
export class Poller {
  private stopped = false;
  private currentTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private errorBackoffMs = 2_000;
  private tileIndex = 0;
  private readonly intervalMs: number;

  constructor(private readonly cfg: PollerConfig) {
    // airplanes.live's rate limit is stricter than their documented 1 req/sec
    // when hit continuously from a datacenter IP — sustained 1/s polling gets
    // ~75% 429s. 3s/tile is the empirical floor where 429s stop.
    this.intervalMs = Math.max(3_000, cfg.tileIntervalMs);
    if (this.intervalMs !== cfg.tileIntervalMs) {
      console.warn(
        `[poller] tile interval ${cfg.tileIntervalMs}ms below 3000ms floor; using ${this.intervalMs}ms`,
      );
    }
  }

  start(): void {
    void this.tick();
    this.pruneTimer = setInterval(() => void this.prune(), 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.currentTimer) clearTimeout(this.currentTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    const tile = NA_TILES[this.tileIndex % NA_TILES.length];
    if (!tile) {
      // Tiles array should never be empty, but satisfy TS and fail loudly.
      console.error("[poller] no tiles configured");
      this.scheduleNext(this.intervalMs);
      return;
    }

    const start = Date.now();
    try {
      const states = await fetchTile(tile.lat, tile.lon, tile.radius);
      const written = await upsertAircraftStates(this.cfg.supabase, states);
      const elapsed = Date.now() - start;
      console.log(
        `[poller] tile=${tile.name} fetched=${states.length} upserted=${written} elapsed=${elapsed}ms`,
      );
      this.errorBackoffMs = 2_000;
      this.tileIndex += 1;
      this.scheduleNext(this.intervalMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && "cause" in err && err.cause
          ? ` (cause: ${(err.cause as { code?: string }).code ?? ""} ${(err.cause as { message?: string }).message ?? String(err.cause)})`
          : "";
      // Never reschedule faster than the rate-limit floor, even on error.
      const delay = Math.max(this.intervalMs, this.errorBackoffMs);
      console.error(
        `[poller] error tile=${tile.name}: ${message}${cause} — next in ${delay}ms`,
      );
      // Advance past the failing tile so one bad region doesn't stall the cycle.
      this.tileIndex += 1;
      this.scheduleNext(delay);
      this.errorBackoffMs = Math.min(this.errorBackoffMs * 3, MAX_BACKOFF_MS);
    }
  }

  private scheduleNext(ms: number): void {
    if (this.stopped) return;
    this.currentTimer = setTimeout(() => void this.tick(), ms);
  }

  private async prune(): Promise<void> {
    if (this.stopped) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - this.cfg.staleTtlSeconds;
      const removed = await pruneStale(this.cfg.supabase, cutoff);
      if (removed > 0) console.log(`[poller] pruned ${removed} stale rows`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[poller] prune error: ${message}`);
    }
  }
}
