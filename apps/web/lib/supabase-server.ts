import { auth } from "@clerk/nextjs/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client that forwards the current Clerk user's JWT
 * (via the "supabase" JWT template) so RLS policies on user_preferences
 * can authorize against auth.jwt() ->> 'sub'.
 *
 * Returns null when the caller is not signed in — routes should respond 401.
 */
export async function supabaseServer(): Promise<SupabaseClient | null> {
  const { getToken, userId } = await auth();
  if (!userId) return null;
  const token = await getToken({ template: "supabase" });
  if (!token) return null;

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
}

/**
 * Service-role client for privileged server work (e.g. seeding, admin jobs).
 * Bypasses RLS — never expose results to the client without re-authorization.
 */
export function supabaseService(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
