import type { AircraftState } from "shared";
import type { Filters } from "@/components/FiltersPanel";

export function aircraftMatches(
  s: AircraftState,
  filters: Filters,
): boolean {
  if (!filters.showOnGround && s.on_ground) return false;
  if (
    filters.countries.length > 0 &&
    (!s.origin_country || !filters.countries.includes(s.origin_country))
  ) {
    return false;
  }
  if (filters.airlines.length > 0) {
    const call = (s.callsign ?? "").toUpperCase();
    const matches = filters.airlines.some((prefix) => call.startsWith(prefix));
    if (!matches) return false;
  }
  const alt = s.baro_altitude ?? s.geo_altitude ?? 0;
  if (filters.altitudeMin !== null && alt < filters.altitudeMin) return false;
  if (filters.altitudeMax !== null && alt > filters.altitudeMax) return false;
  return true;
}
