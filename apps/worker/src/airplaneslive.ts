import type { AircraftState } from "shared";

/**
 * Thin client for airplanes.live point+radius endpoint.
 * No auth. Hard 1 req/sec global rate limit per server IP — the poller
 * enforces that with its tileIntervalMs floor.
 * Response schema matches readsb/tar1090 (same as adsb.lol + adsb.fi).
 */

const BASE = "https://api.airplanes.live";

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
};
type ALResponse = { ac?: ALAircraft[]; now?: number };

const FEET_TO_M = 0.3048;
const KNOTS_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.00508;

function parseAircraft(a: ALAircraft): AircraftState | null {
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

/** Fetch all aircraft within `radius` nm of `(lat, lon)`. */
export async function fetchTile(
  lat: number,
  lon: number,
  radius: number,
): Promise<AircraftState[]> {
  const url = `${BASE}/v2/point/${lat}/${lon}/${radius}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "flight-viewer (https://github.com/jiajunl23/flight-viewer)",
    },
  });
  if (!res.ok) {
    throw new Error(
      `airplanes.live tile ${lat},${lon} r${radius} HTTP ${res.status}`,
    );
  }
  const body = (await res.json()) as ALResponse;
  const out: AircraftState[] = [];
  for (const a of body.ac ?? []) {
    const s = parseAircraft(a);
    if (s) out.push(s);
  }
  return out;
}
