import type { AircraftState } from "shared";

const R_EARTH_M = 6_371_000;

/** Drop aircraft once server data is more than this stale.
 *
 * Was 120s but that's the same order of magnitude as one complete NA tile
 * rotation (20 tiles × 3s = 60s). A short burst of adsb.lol 429s stretches
 * the rotation to 120-200s via error backoff, causing every plane for a
 * hub to fall past 120s and visibly vanish. 300s comfortably absorbs a
 * few minutes of transient upstream pain; extrapolation error at 250 m/s
 * × 300s is ~75 km which is tolerable at regional+ zoom. Prune TTL on the
 * server side is 900s so DB still holds the rows. */
export const MAX_HORIZON_S = 300;

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
 * Altitude-based keep-fraction — linearly interpolated between breakpoints so
 * the count doesn't pop when crossing a band. Breakpoints:
 *
 *   altitude 0.05 → 100%
 *   altitude 0.12 → 95%
 *   altitude 0.20 → 85%
 *   altitude 0.30 → 75%
 *   altitude 0.40 → 65%
 *   altitude 0.50 → 55%
 *   altitude 0.60 → 50%   ← baseline
 *   altitude 0.90 → 35%
 *   altitude 1.30 → 20%
 *   altitude 1.80 → 10%
 *   altitude 2.50 → 5%
 *   altitude ∞    → 2%
 *
 * Below 0.05 clamps to 100%. Within a band we lerp so a 0.01 zoom nudge moves
 * the keep a tiny amount, never a sudden 15% jump.
 */
const LOD_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0.05, 1.0],
  [0.12, 0.95],
  [0.2, 0.85],
  [0.3, 0.75],
  [0.4, 0.65],
  [0.5, 0.55],
  [0.6, 0.5],
  [0.9, 0.35],
  [1.3, 0.2],
  [1.8, 0.1],
  [2.5, 0.05],
  [4.0, 0.02],
];

export function lodKeepFraction(altitude: number): number {
  if (altitude <= LOD_BANDS[0]![0]) return LOD_BANDS[0]![1];
  for (let i = 1; i < LOD_BANDS.length; i++) {
    const [hiAlt, hiKeep] = LOD_BANDS[i]!;
    if (altitude <= hiAlt) {
      const [loAlt, loKeep] = LOD_BANDS[i - 1]!;
      const t = (altitude - loAlt) / (hiAlt - loAlt);
      return loKeep + t * (hiKeep - loKeep);
    }
  }
  return LOD_BANDS[LOD_BANDS.length - 1]![1];
}

/**
 * Concentric-ring density falloff relative to view center.
 * `normalizedDist` = angularDistance(plane, center) / visibleRadius
 *   0.0 → plane is directly at camera target (full focus)
 *   1.0 → plane is at the horizon of the visible cap
 *   1.2 → plane is in the 20% soft-cull margin
 *
 * Used only when base density ≤ 0.5 (see `combinedKeepFraction`). Above
 * 50% the combining function handles the falloff differently — focus zone
 * gets the high base, rest stays at 50% × this multiplier.
 */
export function ringKeepMultiplier(normalizedDist: number): number {
  if (normalizedDist <= 0.25) return 1.0; // focus zone — full base density
  if (normalizedDist <= 0.5) return 0.6; // inner ring
  if (normalizedDist <= 0.8) return 0.3; // outer ring
  return 0.12; // edge / margin
}

/**
 * Combines the altitude-based `lodKeepFraction` with distance-from-view-
 * center to produce the effective keep fraction for a single plane.
 *
 * Rule:
 * - If the altitude base is ≤ 50%: use the existing ring falloff straight
 *   across — base × ringKeepMultiplier(normalizedDist).
 * - If the altitude base is > 50% (zoomed in hard): the extra density only
 *   applies inside a small focus radius at the center of the view. Outside
 *   that focus zone, density fades to the 50% baseline, and beyond the fade
 *   band it uses the normal 50% × ring falloff.
 *
 * Net effect: at a deep zoom, the center of your view gets the rich density
 * (up to 100%) while the surrounding visible area stays at the comfortable
 * 50% baseline so nearby traffic is still visible without overwhelming
 * the scene.
 */
export function combinedKeepFraction(
  altitudeBase: number,
  normalizedDist: number,
): number {
  if (altitudeBase <= 0.5) {
    return altitudeBase * ringKeepMultiplier(normalizedDist);
  }
  const FOCUS_END = 0.2;
  const FADE_END = 0.4;
  if (normalizedDist <= FOCUS_END) return altitudeBase;
  if (normalizedDist <= FADE_END) {
    const t = (normalizedDist - FOCUS_END) / (FADE_END - FOCUS_END);
    return altitudeBase + (0.5 - altitudeBase) * t;
  }
  return 0.5 * ringKeepMultiplier(normalizedDist);
}

/**
 * Angular radius (in radians) of the ground cap the camera can actually see.
 *
 * Returns `min(horizon radius, FOV-constrained radius)`. The horizon is the
 * "behind the curve" cutoff at acos(1/(1+h)). At low altitudes that's much
 * wider than the camera actually shows — e.g. at h=0.15 the horizon is ~30°
 * but a 50° vertical FOV camera only renders ~4° of ground. Using the
 * horizon alone kept ~7× too many planes in the spatial cull at low zoom,
 * which the user observed as "3000 flights despite small focused zoom."
 *
 * FOV-constrained radius solves sin(θ)/((1+h) − cos(θ)) = tan(fov/2) for θ.
 * The quadratic gives cos(θ) = [t²d + √(1 + t²(1 − d²))] / (1 + t²) where
 * d = 1 + h, t = tan(fov/2). Real solution only when h is small enough that
 * the FOV doesn't already contain the whole hemisphere — above that altitude
 * the discriminant flips negative and we fall back to the horizon.
 */
const HALF_VERTICAL_FOV_RAD = (50 / 2) * (Math.PI / 180); // three.js default = 50° vertical
const TAN_HALF_FOV = Math.tan(HALF_VERTICAL_FOV_RAD);
const TAN_HALF_FOV_SQ = TAN_HALF_FOV * TAN_HALF_FOV;

export function visibleAngularRadiusRad(altitude: number): number {
  const h = Math.max(0.001, altitude);
  const d = 1 + h;
  const thetaHorizon = Math.acos(Math.min(1, 1 / d));

  const disc = 1 + TAN_HALF_FOV_SQ * (1 - d * d);
  if (disc <= 0) return thetaHorizon; // FOV sees past the horizon anyway

  const cosThetaFov =
    (TAN_HALF_FOV_SQ * d + Math.sqrt(disc)) / (1 + TAN_HALF_FOV_SQ);
  const clamped = Math.max(-1, Math.min(1, cosThetaFov));
  const thetaFov = Math.acos(clamped);
  return Math.min(thetaFov, thetaHorizon);
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
