import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchStatesAll } from "./opensky.js";
import { pruneStale, upsertAircraftStates } from "./supabase.js";

export interface PollerConfig {
  clientId: string;
  clientSecret: string;
  pollIntervalMs: number;
  staleTtlSeconds: number;
  supabase: SupabaseClient;
}

const MAX_BACKOFF_MS = 60_000;

export class Poller {
  private stopped = false;
  private currentTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private errorBackoffMs = 2_000;

  constructor(private readonly cfg: PollerConfig) {}

  start(): void {
    // Immediate first tick, then every pollIntervalMs.
    void this.tick();
    // Prune every 5 minutes.
    this.pruneTimer = setInterval(() => void this.prune(), 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.currentTimer) clearTimeout(this.currentTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const start = Date.now();
    try {
      const { time, states } = await fetchStatesAll(
        this.cfg.clientId,
        this.cfg.clientSecret,
      );
      const written = await upsertAircraftStates(this.cfg.supabase, states);
      const elapsed = Date.now() - start;
      console.log(
        `[poller] t=${time} fetched=${states.length} upserted=${written} elapsed=${elapsed}ms`,
      );
      this.errorBackoffMs = 2_000; // reset on success
      this.scheduleNext(this.cfg.pollIntervalMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[poller] error: ${message} — backoff ${this.errorBackoffMs}ms`);
      this.scheduleNext(this.errorBackoffMs);
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
