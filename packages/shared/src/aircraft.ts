/**
 * Normalized aircraft state. Same shape regardless of source (OpenSky, airplanes.live).
 * Fields that may be missing from a given source are nullable.
 */
export interface AircraftState {
  icao24: string;
  callsign: string | null;
  origin_country: string | null;
  time_position: number | null;
  last_contact: number;
  longitude: number | null;
  latitude: number | null;
  baro_altitude: number | null;
  on_ground: boolean;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  geo_altitude: number | null;
  squawk: string | null;
  spi: boolean;
  position_source: number | null;
  /** ADS-B emitter category code: "A1"-"A7", "B0"-"B7", "C0"-"C4". */
  category: string | null;
  /** Tail registration e.g. "N336MC". */
  registration: string | null;
  /** ICAO aircraft type e.g. "B738", "A320", "C172". */
  aircraft_type: string | null;
  /** "none" | "general" | "lifeguard" | "minfuel" | "nordo" | "unlawful" | "downed" */
  emergency: string | null;
}

export type OpenSkyStateVector = [
  string,
  string | null,
  string,
  number | null,
  number,
  number | null,
  number | null,
  number | null,
  boolean,
  number | null,
  number | null,
  number | null,
  number[] | null,
  number | null,
  string | null,
  boolean,
  number,
  number?
];

export function parseOpenSkyState(v: OpenSkyStateVector): AircraftState {
  return {
    icao24: v[0],
    callsign: v[1]?.trim() || null,
    origin_country: v[2],
    time_position: v[3],
    last_contact: v[4],
    longitude: v[5],
    latitude: v[6],
    baro_altitude: v[7],
    on_ground: v[8],
    velocity: v[9],
    true_track: v[10],
    vertical_rate: v[11],
    geo_altitude: v[13],
    squawk: v[14],
    spi: v[15],
    position_source: v[16],
    // OpenSky encodes category as a small integer (0-20). Stringify so the
    // field type stays compatible with adsb.lol's "A1"-"C4" codes.
    category: v[17] != null ? String(v[17]) : null,
    registration: null, // OpenSky doesn't provide it
    aircraft_type: null, // OpenSky doesn't provide it
    emergency: null, // OpenSky doesn't provide it
  };
}
