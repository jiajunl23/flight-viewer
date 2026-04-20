import { z } from "zod";

const nonEmpty = z.string().min(1);

export const webEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty.optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: nonEmpty,
  CLERK_SECRET_KEY: nonEmpty.optional(),
});

export const workerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  OPENSKY_CLIENT_ID: nonEmpty,
  OPENSKY_CLIENT_SECRET: nonEmpty,
  POLL_INTERVAL_MS: z
    .string()
    .default("90000")
    .transform((v) => Number.parseInt(v, 10)),
  STALE_TTL_SECONDS: z
    .string()
    .default("900")
    .transform((v) => Number.parseInt(v, 10)),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
