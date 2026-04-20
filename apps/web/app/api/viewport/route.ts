import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AircraftState } from "shared";

/**
 * Proxy to airplanes.live /v2/point/{lat}/{lon}/{radius_nm}. The upstream API
 * enforces a global 1 req/sec from the server IP, so we serialize outgoing
 * calls here AND cache per-region for 1s. Nearby users watching the same
 * airspace share a single upstream call.
 *
 * Response is normalized into AircraftState (metric units) so the frontend can
 * merge these rows straight into the icao24 state map alongside OpenSky data.
 */

const paramsSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(250),
});

type CacheEntry = { data: AircraftState[]; expires: number; fetchedAt: number };
const CACHE_TTL_MS = 1_500; // serve cache for 1.5s so sub-second polling never hits upstream twice
// On upstream failure (commonly 429 rate-limit), keep serving cached data for
// up to 5 minutes. Dead-reckoning will smoothly interpolate positions in the
// meantime, so short upstream blips are invisible to the user.
const STALE_TOLERATED_MS = 5 * 60_000;
const UPSTREAM_MIN_GAP_MS = 1_100; // a hair above 1s to respect airplanes.live's 1 req/s cap
const cache = new Map<string, CacheEntry>();
let lastUpstreamAt = 0;
let upstreamInFlight: Promise<void> = Promise.resolve();

type ALAircraft = {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  baro_rate?: number;
  gs?: number;
  track?: number;
  squawk?: string;
  spi?: number;
  seen?: number;
  category?: string;
};
type ALResponse = { ac?: ALAircraft[]; now?: number };

const FEET_TO_M = 0.3048;
const KNOTS_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.00508;

function parseAirplanesLive(a: ALAircraft): AircraftState | null {
  if (
    typeof a.hex !== "string" ||
    typeof a.lat !== "number" ||
    typeof a.lon !== "number"
  ) {
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const seen = typeof a.seen === "number" ? a.seen : 0;
  const onGround = a.alt_baro === "ground";
  const altBaro =
    typeof a.alt_baro === "number" ? a.alt_baro * FEET_TO_M : null;
  const altGeom =
    typeof a.alt_geom === "number" ? a.alt_geom * FEET_TO_M : null;

  return {
    icao24: a.hex.toLowerCase(),
    callsign: typeof a.flight === "string" ? a.flight.trim() || null : null,
    origin_country: null,
    time_position: null,
    last_contact: nowSec - Math.floor(seen),
    longitude: a.lon,
    latitude: a.lat,
    baro_altitude: altBaro,
    on_ground: onGround,
    velocity: typeof a.gs === "number" ? a.gs * KNOTS_TO_MPS : null,
    true_track: typeof a.track === "number" ? a.track : null,
    vertical_rate:
      typeof a.baro_rate === "number" ? a.baro_rate * FPM_TO_MPS : null,
    geo_altitude: altGeom,
    squawk: typeof a.squawk === "string" ? a.squawk : null,
    spi: a.spi === 1,
    position_source: null,
    category: null,
  };
}

/** Serialize outgoing upstream calls so we never exceed airplanes.live's 1 req/sec. */
async function throttledFetch(url: string): Promise<Response> {
  // Wait behind any in-flight upstream call.
  await upstreamInFlight;
  const wait = UPSTREAM_MIN_GAP_MS - (Date.now() - lastUpstreamAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  let resolveHold!: () => void;
  upstreamInFlight = new Promise<void>((r) => {
    resolveHold = r;
  });
  try {
    lastUpstreamAt = Date.now();
    return await fetch(url, {
      headers: { "User-Agent": "flight-viewer (https://github.com/jiajunl23/flight-viewer)" },
      cache: "no-store",
    });
  } finally {
    resolveHold();
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = paramsSchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad params", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { lat, lon, radius } = parsed.data;

  // Bucket cache key at 0.1° so nearby users share a single upstream call.
  const key = `${Math.round(lat * 10)}_${Math.round(lon * 10)}_${Math.round(radius)}`;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && cached.expires > now) {
    return NextResponse.json(
      { states: cached.data, cached: true, ttl_ms: cached.expires - now },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const res = await throttledFetch(
      `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`,
    );
    if (!res.ok) {
      // Upstream failure (commonly 429 rate-limited). If we have cache within
      // STALE_TOLERATED_MS, serve that rather than erroring — dead-reckoning
      // will smoothly fill the gap.
      if (cached && Date.now() - cached.fetchedAt < STALE_TOLERATED_MS) {
        return NextResponse.json(
          {
            states: cached.data,
            cached: true,
            stale: true,
            upstream_status: res.status,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json(
        { error: `upstream ${res.status}` },
        { status: 502 },
      );
    }
    const body = (await res.json()) as ALResponse;
    const states: AircraftState[] = [];
    for (const a of body.ac ?? []) {
      const s = parseAirplanesLive(a);
      if (s) states.push(s);
    }
    const now2 = Date.now();
    cache.set(key, {
      data: states,
      expires: now2 + CACHE_TTL_MS,
      fetchedAt: now2,
    });
    return NextResponse.json(
      { states, cached: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached && Date.now() - cached.fetchedAt < STALE_TOLERATED_MS) {
      return NextResponse.json(
        { states: cached.data, cached: true, stale: true, error: message },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
