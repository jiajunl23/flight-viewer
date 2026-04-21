import type { AircraftState } from "shared";

const R_EARTH_M = 6_371_000;

/** Drop aircraft once server data is more than this stale. */
export const MAX_HORIZON_S = 120;

export interface Reckoned {
  lat: number;
  lng: number;
  alt: number;
  stale: boolean;
}

/**
 * Advance an AircraftState to `nowMs` using its velocity + true_track +
 * vertical_rate. Returns null for rows without a position.
 *
 * Cap at MAX_HORIZON_S so we don't extrapolate forever and create ghost planes.
 */
export function reckon(s: AircraftState, nowMs: number): Reckoned | null {
  if (s.latitude == null || s.longitude == null) return null;

  const dtRaw = nowMs / 1000 - s.last_contact;
  const dt = Math.min(Math.max(dtRaw, 0), MAX_HORIZON_S);
  const stale = dtRaw > MAX_HORIZON_S;

  const v = s.velocity ?? 0;
  const trackRad = (s.true_track ?? 0) * (Math.PI / 180);
  const latRad = s.latitude * (Math.PI / 180);

  const dLatDeg =
    (v * Math.cos(trackRad) * dt) / R_EARTH_M * (180 / Math.PI);
  const dLonDeg =
    (v * Math.sin(trackRad) * dt) /
    (R_EARTH_M * Math.cos(latRad)) *
    (180 / Math.PI);

  const baseAlt = s.baro_altitude ?? s.geo_altitude ?? 0;
  const vRate = s.vertical_rate ?? 0;

  return {
    lat: s.latitude + dLatDeg,
    lng: s.longitude + dLonDeg,
    alt: Math.max(0, Math.min(baseAlt + vRate * dt, 20_000)),
    stale,
  };
}

export function altitudeColorHex(altMeters: number, onGround: boolean): number {
  if (onGround) return 0x4ade80; // green
  if (altMeters < 3000) return 0xfbbf24; // amber (climb/descent)
  if (altMeters < 8000) return 0xfb923c; // orange mid
  return 0xf87171; // red cruise
}

/**
 * Speed-based color ramp: red (slow) → yellow (mid) → green (fast).
 * Anchored to typical airliner cruise of 250 m/s; anything >= 250 is max green.
 *
 * Bands:
 *  0-30 m/s: red (parked / taxiing)
 *  30-100 m/s: orange (light aircraft, helicopters)
 *  100-180 m/s: yellow (turboprops, regional)
 *  180-250 m/s: yellow-green (jets climbing/descending)
 *  250+ m/s: green (cruise)
 */
export function speedColorHex(mps: number): number {
  if (mps < 30) return 0xef4444; // red
  if (mps < 100) return 0xf97316; // orange
  if (mps < 180) return 0xeab308; // yellow
  if (mps < 250) return 0x84cc16; // lime
  return 0x22c55e; // green
}

/** Emergency squawks that trigger a red-halo override. */
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

export function isEmergency(
  emergency: string | null | undefined,
  squawk: string | null | undefined,
): boolean {
  if (emergency && emergency !== "none") return true;
  if (squawk && EMERGENCY_SQUAWKS.has(squawk)) return true;
  return false;
}

/**
 * Stable hash of an icao24 hex string into [0, 1). Used for density-based
 * LOD: planes with hash(icao24) < keepFraction stay rendered at low zoom
 * levels. Because hash is deterministic per icao24, the sampled subset
 * doesn't flicker frame-to-frame and the spatial distribution stays
 * roughly uniform (ICAO addresses aren't correlated with current position).
 */
export function icao24Hash(icao24: string): number {
  const n = Number.parseInt(icao24.slice(0, 6), 16);
  if (Number.isNaN(n)) return 0;
  return n / 0xffffff;
}

/**
 * Discrete LOD buckets keyed on camera altitude. Maps to a keep-fraction for
 * hash-based subsampling. A bucketed approach (rather than continuous) means
 * planes don't flicker in and out with tiny zoom changes; they only shift
 * populations when the user crosses a bucket boundary.
 */
export function lodKeepFraction(altitude: number): number {
  if (altitude <= 0.4) return 1.0; // zoomed into a city — render everything
  if (altitude <= 0.8) return 0.5;
  if (altitude <= 1.3) return 0.25;
  if (altitude <= 2.0) return 0.12;
  return 0.06; // zoomed all the way out
}

/**
 * Scale multiplier by ADS-B emitter category. Heavy jets (A5) render bigger,
 * light GA (A1) smaller. Helicopters (A7) small because they're short-range
 * and usually below airliners on the globe.
 */
export function categoryScale(category: string | null | undefined): number {
  if (!category) return 1.0;
  switch (category) {
    case "A1":
      return 0.7; // light (<15,500 lbs)
    case "A2":
      return 0.9; // small (15,500-75,000)
    case "A3":
      return 1.05; // large (75,000-300,000)
    case "A4":
      return 1.15; // high vortex
    case "A5":
      return 1.35; // heavy (>300,000 — 747, A380)
    case "A6":
      return 1.0; // high performance (fighters)
    case "A7":
      return 0.6; // rotorcraft
    default:
      return 1.0;
  }
}
