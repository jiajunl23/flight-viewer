import { Agent, setGlobalDispatcher } from "undici";
import { workerEnvSchema } from "shared";
import { diagnose } from "./diagnose.js";
import { Poller } from "./poller.js";
import { supabaseService } from "./supabase.js";

// Bump undici's default 10s connect timeout to 30s — OpenSky's auth endpoint
// is in Europe, and Railway cold connections can exceed 10s, which shows up
// as UND_ERR_CONNECT_TIMEOUT in the poller error log.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 30_000 },
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
  }),
);

const env = workerEnvSchema.parse(process.env);

const supabase = supabaseService(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

const poller = new Poller({
  clientId: env.OPENSKY_CLIENT_ID,
  clientSecret: env.OPENSKY_CLIENT_SECRET,
  pollIntervalMs: env.POLL_INTERVAL_MS,
  staleTtlSeconds: env.STALE_TTL_SECONDS,
  supabase,
});

console.log(
  `[worker] starting — poll=${env.POLL_INTERVAL_MS}ms stale_ttl=${env.STALE_TTL_SECONDS}s`,
);
if (process.env.NODE_ENV !== "production") {
  console.warn(
    "[worker] LOCAL DEV — if the Railway worker is also live, you are DOUBLE-POLLING OpenSky and burning credits twice.",
  );
}

// Run connectivity probe once at startup so prod logs tell us which layer
// (DNS / TCP / TLS / HTTPS) is blocking the poll. Safe to keep in — runs
// once, ~few seconds, and adds zero OpenSky credit cost (hits auth root
// which doesn't count against the states/all quota).
void diagnose().finally(() => poller.start());

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[worker] ${signal} — shutting down`);
  await poller.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
