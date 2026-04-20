import type { SupabaseClient } from "@supabase/supabase-js";
import {
  creditsUsedToday,
  DAILY_CREDIT_BUDGET,
  fetchStatesAll,
  MIN_INTERVAL_MS,
  wouldExceedBudget,
} from "./opensky.js";
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
  private readonly intervalMs: number;

  constructor(private readonly cfg: PollerConfig) {
    // Hard floor: env can only slow us down, never speed us up.
    this.intervalMs = Math.max(MIN_INTERVAL_MS, cfg.pollIntervalMs);
    if (this.intervalMs !== cfg.pollIntervalMs) {
      console.warn(
        `[poller] POLL_INTERVAL_MS=${cfg.pollIntervalMs} below ${MIN_INTERVAL_MS}ms floor; using ${this.intervalMs}ms`,
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

    if (wouldExceedBudget()) {
      console.warn(
        `[poller] daily credit budget reached (${creditsUsedToday()}/${DAILY_CREDIT_BUDGET}); skipping tick`,
      );
      this.scheduleNext(this.intervalMs);
      return;
    }

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
      console.log(
        `[opensky] credits today: ${creditsUsedToday()}/${DAILY_CREDIT_BUDGET} (budget 4000)`,
      );
      this.errorBackoffMs = 2_000;
      this.scheduleNext(this.intervalMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Node's undici wraps the real failure in err.cause — surface it so
      // "fetch failed" isn't the only thing we see.
      const cause =
        err instanceof Error && "cause" in err && err.cause
          ? ` (cause: ${(err.cause as { code?: string; message?: string; errno?: number }).code ?? ""} ${(err.cause as { message?: string }).message ?? String(err.cause)})`
          : "";
      const delay = Math.max(this.intervalMs, this.errorBackoffMs);
      console.error(
        `[poller] error: ${message}${cause} — next in ${delay}ms (backoff=${this.errorBackoffMs}ms, floor=${this.intervalMs}ms)`,
      );
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
