import { workerEnvSchema } from "shared";
import { Poller } from "./poller.js";
import { supabaseService } from "./supabase.js";

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
poller.start();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[worker] ${signal} — shutting down`);
  await poller.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
