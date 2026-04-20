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
