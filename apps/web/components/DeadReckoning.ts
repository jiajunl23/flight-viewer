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
 * Altitude-based BASE keep-fraction — sets the ceiling for density at the
 * current zoom level. Multiplied per-plane by `ringKeepMultiplier` based on
 * how close the plane is to the view center (see below), so the final
 * effective density is `base × ring`.
 *
 * 100% only at very low altitude (true zoomed-in hub/airport view). At
 * everything else, even the inner ring caps below 100% so the page stays
 * performant.
 */
export function lodKeepFraction(altitude: number): number {
  if (altitude <= 0.3) return 1.0; // airport/hub — fully zoomed in
  if (altitude <= 0.6) return 0.7;
  if (altitude <= 1.0) return 0.5;
  if (altitude <= 1.4) return 0.3;
  if (altitude <= 1.8) return 0.2;
  if (altitude <= 2.4) return 0.12;
  if (altitude <= 3.0) return 0.08;
  return 0.05;
}

/**
 * Concentric-ring density falloff relative to view center.
 * `normalizedDist` = angularDistance(plane, center) / visibleRadius
 *   0.0 → plane is directly at camera target (full focus)
 *   1.0 → plane is at the horizon of the visible cap
 *   1.2 → plane is in the 20% soft-cull margin
 *
 * Result is a multiplier applied to the altitude-based base density. The net
 * effect: planes near where you're looking render densely, planes further out
 * thin out progressively.
 */
export function ringKeepMultiplier(normalizedDist: number): number {
  if (normalizedDist <= 0.25) return 1.0; // focus zone — full base density
  if (normalizedDist <= 0.5) return 0.6; // inner ring
  if (normalizedDist <= 0.8) return 0.3; // outer ring
  return 0.12; // edge / margin
}

/**
 * Angular radius (in radians) of the spherical cap visible from a camera at
 * the given altitude above a unit-radius globe. Derived from simple tangent
 * geometry: cos(α) = R / (R + h), R = 1. So α = acos(1 / (1 + altitude)).
 *
 * Planes outside this cap are literally behind the horizon and wouldn't be
 * visible even without culling — dropping them saves per-frame work.
 */
export function visibleAngularRadiusRad(altitude: number): number {
  const clamped = Math.max(0.001, altitude);
  return Math.acos(Math.min(1, 1 / (1 + clamped)));
}

/**
 * Great-circle angular distance in radians between two lat/lng points
 * (haversine). Used for the spatial LOD filter.
 */
export function angularDistanceRad(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const Δφ = (lat2 - lat1) * toRad;
  const Δλ = (lng2 - lng1) * toRad;
  const sΔφ = Math.sin(Δφ / 2);
  const sΔλ = Math.sin(Δλ / 2);
  const a = sΔφ * sΔφ + Math.cos(φ1) * Math.cos(φ2) * sΔλ * sΔλ;
  return 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
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
