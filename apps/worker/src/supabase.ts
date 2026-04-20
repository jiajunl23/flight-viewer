import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AircraftState } from "shared";

let cached: SupabaseClient | null = null;

export function supabaseService(url: string, serviceKey: string): SupabaseClient {
  if (cached) return cached;
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Upsert aircraft states in batches. Keyed on icao24 PK.
 * Writes `updated_at = now()` via the table default (not set here).
 */
export async function upsertAircraftStates(
  client: SupabaseClient,
  states: AircraftState[],
  batchSize = 1000,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < states.length; i += batchSize) {
    const batch = states.slice(i, i + batchSize).map((s) => ({
      ...s,
      updated_at: new Date().toISOString(),
    }));
    const { error, count } = await client
      .from("aircraft_states")
      .upsert(batch, { onConflict: "icao24", count: "exact" });
    if (error) throw new Error(`upsert batch ${i}: ${error.message}`);
    written += count ?? batch.length;
  }
  return written;
}

/**
 * Delete rows with last_contact older than cutoff (unix seconds).
 * Returns number of rows deleted.
 */
export async function pruneStale(
  client: SupabaseClient,
  olderThanUnixSec: number,
): Promise<number> {
  const { error, count } = await client
    .from("aircraft_states")
    .delete({ count: "exact" })
    .lt("last_contact", olderThanUnixSec);
  if (error) throw new Error(`prune: ${error.message}`);
  return count ?? 0;
}
