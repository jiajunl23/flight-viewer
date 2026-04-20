import { Agent, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { Poller } from "./poller.js";
import { supabaseService } from "./supabase.js";

// Generous timeouts — adsb.lol is fast but Railway network cold-starts can be
// slower than Node's 10s default.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 20_000 },
    headersTimeout: 20_000,
    bodyTimeout: 30_000,
  }),
);

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TILE_INTERVAL_MS: z
    .string()
    .default("3000")
    .transform((v) => Number.parseInt(v, 10)),
  STALE_TTL_SECONDS: z
    .string()
    .default("900")
    .transform((v) => Number.parseInt(v, 10)),
});
const env = envSchema.parse(process.env);

const supabase = supabaseService(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

// Clamp tile interval to >= 3000ms. airplanes.live's rate limit is stricter
// than their docs suggest when hit from datacenter IPs — 1 req/sec sustained
// triggers ~75% 429s; 1 req / 3s empirically clears.
const tileInterval = Math.max(3_000, env.TILE_INTERVAL_MS);

const poller = new Poller({
  tileIntervalMs: tileInterval,
  staleTtlSeconds: env.STALE_TTL_SECONDS,
  supabase,
});

console.log(
  `[worker] starting — data=airplanes.live tile_interval=${tileInterval}ms stale_ttl=${env.STALE_TTL_SECONDS}s`,
);
if (process.env.NODE_ENV !== "production") {
  console.warn(
    "[worker] LOCAL DEV — if a Railway worker is also live, you are DOUBLE-POLLING adsb.lol from the same origin. The cap is per-IP, so you'll trip rate limits faster.",
  );
}
poller.start();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[worker] ${signal} — shutting down`);
  await poller.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
