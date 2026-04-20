import type { AircraftState, OpenSkyStateVector } from "shared";
import { parseOpenSkyState } from "shared";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

/**
 * Absolute minimum interval between worldwide /states/all calls.
 * Worldwide query = 4 credits, 4000-credit daily budget → 86.4s floor.
 * We clamp to 90s to leave a 160-credit safety margin.
 * Env POLL_INTERVAL_MS can only make this slower, never faster.
 */
export const MIN_INTERVAL_MS = 90_000;

/** Credits per worldwide /states/all call. */
export const CREDITS_PER_WORLD_CALL = 4;

/**
 * Daily hard-cap slightly under the 4000 quota so a misconfigured
 * loop can never blow through the whole day in one bad hour.
 */
export const DAILY_CREDIT_BUDGET = 3800;

type CachedToken = { access_token: string; expires_at: number };
let cached: CachedToken | null = null;

type Spend = { dayStartedAt: number; credits: number };
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
const spend: Spend = { dayStartedAt: startOfUtcDay(Date.now()), credits: 0 };

function rolloverIfNeeded(): void {
  const today = startOfUtcDay(Date.now());
  if (today !== spend.dayStartedAt) {
    spend.dayStartedAt = today;
    spend.credits = 0;
  }
}

/** Returns true if spending 4 more credits would exceed DAILY_CREDIT_BUDGET. */
export function wouldExceedBudget(): boolean {
  rolloverIfNeeded();
  return spend.credits + CREDITS_PER_WORLD_CALL > DAILY_CREDIT_BUDGET;
}

/** For logging. */
export function creditsUsedToday(): number {
  rolloverIfNeeded();
  return spend.credits;
}

async function fetchToken(
  clientId: string,
  clientSecret: string,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSky token ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
}

async function getToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  cached = await fetchToken(clientId, clientSecret);
  return cached.access_token;
}

export interface OpenSkyResponse {
  time: number;
  states: AircraftState[];
}

/**
 * Fetch the worldwide /states/all snapshot. Retries once on 401 (stale token).
 * Increments the credit meter on success (and on the 401-retry path too since
 * both attempts actually hit the API).
 */
export async function fetchStatesAll(
  clientId: string,
  clientSecret: string,
): Promise<OpenSkyResponse> {
  const token = await getToken(clientId, clientSecret);

  const res = await fetch(STATES_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    cached = null;
    // This first call still counted against the quota.
    rolloverIfNeeded();
    spend.credits += CREDITS_PER_WORLD_CALL;
    return fetchStatesAll(clientId, clientSecret);
  }
  if (res.status === 429) {
    throw new Error("OpenSky rate-limit exceeded (429)");
  }
  if (!res.ok) {
    throw new Error(`OpenSky /states/all ${res.status}`);
  }

  rolloverIfNeeded();
  spend.credits += CREDITS_PER_WORLD_CALL;

  const raw = (await res.json()) as {
    time: number;
    states: OpenSkyStateVector[] | null;
  };

  const states: AircraftState[] = (raw.states ?? [])
    .map(parseOpenSkyState)
    .filter(
      (s: AircraftState) => s.latitude != null && s.longitude != null,
    );

  return { time: raw.time, states };
}
