/**
 * North America airspace tiles — major airport hubs with 250 nm radius.
 * 250 nm ≈ 463 km ≈ tile covers roughly a 926 km diameter circle.
 * 20 tiles × 1 req/sec (adsb.lol soft rate) = full-continent refresh every 20s.
 *
 * Selection prioritizes coverage over traffic volume: spread across CONUS,
 * Canada's southern border, Alaska, and northern Mexico so the globe view
 * looks populated from coast to coast rather than just the biggest hubs.
 */
export interface Tile {
  name: string;
  lat: number;
  lon: number;
  /** Radius in nautical miles. adsb.lol caps at 250. */
  radius: number;
}

export const NA_TILES: Tile[] = [
  // US West Coast
  { name: "Los Angeles", lat: 33.94, lon: -118.41, radius: 250 },
  { name: "San Francisco", lat: 37.62, lon: -122.38, radius: 250 },
  { name: "Seattle", lat: 47.45, lon: -122.31, radius: 250 },
  { name: "Salt Lake City", lat: 40.79, lon: -111.98, radius: 250 },
  { name: "Phoenix", lat: 33.43, lon: -112.01, radius: 250 },
  // US Mountain / Plains
  { name: "Denver", lat: 39.86, lon: -104.67, radius: 250 },
  { name: "Minneapolis", lat: 44.88, lon: -93.22, radius: 250 },
  { name: "Kansas City", lat: 39.3, lon: -94.71, radius: 250 },
  // US South
  { name: "Dallas–Fort Worth", lat: 32.9, lon: -97.04, radius: 250 },
  { name: "Houston", lat: 29.98, lon: -95.34, radius: 250 },
  { name: "Atlanta", lat: 33.64, lon: -84.43, radius: 250 },
  { name: "Miami", lat: 25.8, lon: -80.29, radius: 250 },
  // US East / Midwest
  { name: "Chicago", lat: 41.98, lon: -87.91, radius: 250 },
  { name: "Detroit", lat: 42.21, lon: -83.35, radius: 250 },
  { name: "New York", lat: 40.64, lon: -73.78, radius: 250 },
  { name: "Boston", lat: 42.37, lon: -71.01, radius: 250 },
  // Canada
  { name: "Toronto", lat: 43.68, lon: -79.63, radius: 250 },
  { name: "Vancouver", lat: 49.19, lon: -123.18, radius: 250 },
  // Alaska (dense general-aviation coverage, not just one hub)
  { name: "Anchorage", lat: 61.17, lon: -149.99, radius: 250 },
  // Mexico
  { name: "Mexico City", lat: 19.44, lon: -99.07, radius: 250 },
];
