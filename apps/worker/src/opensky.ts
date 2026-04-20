import type { AircraftState, OpenSkyStateVector } from "shared";
import { parseOpenSkyState } from "shared";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

type CachedToken = { access_token: string; expires_at: number };
let cached: CachedToken | null = null;

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
    // Refresh 60s before actual expiry.
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
 * Returns normalized AircraftState[] (arrays → typed objects).
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
    return fetchStatesAll(clientId, clientSecret);
  }
  if (res.status === 429) {
    throw new Error("OpenSky rate-limit exceeded (429)");
  }
  if (!res.ok) {
    throw new Error(`OpenSky /states/all ${res.status}`);
  }

  const raw = (await res.json()) as {
    time: number;
    states: OpenSkyStateVector[] | null;
  };

  const states: AircraftState[] = (raw.states ?? [])
    .map(parseOpenSkyState)
    // Drop aircraft missing lat/lon — they're useless for the globe.
    .filter(
      (s: AircraftState) => s.latitude != null && s.longitude != null,
    );

  return { time: raw.time, states };
}
