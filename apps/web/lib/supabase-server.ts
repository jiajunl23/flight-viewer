import { auth } from "@clerk/nextjs/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client that uses Clerk's native Third-Party Auth
 * integration (the successor to the deprecated "supabase" JWT template).
 *
 * `accessToken` is read fresh on every request, so RLS policies can evaluate
 * auth.jwt() ->> 'sub' against the current Clerk user id.
 *
 * Requires: Clerk ↔ Supabase third-party auth integration configured in both
 * dashboards. See README.
 */
export function supabaseServer(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      accessToken: async () => {
        const { getToken } = await auth();
        return (await getToken()) ?? null;
      },
    },
  );
}

/**
 * Service-role client for privileged server work (seeds, admin jobs).
 * Bypasses RLS — never expose results to the client without re-authorization.
 */
export function supabaseService(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
