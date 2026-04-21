import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy to adsb.lol's routeset endpoint (the only one that actually returns
 * route info — `/v2/route/...` returns 404 consistently). Needs callsign plus
 * the aircraft's current lat/lng to disambiguate overlapping numbers.
 *
 * Returns the origin + destination airports for a given callsign (when
 * known). Not all callsigns have routes (GA traffic, military, private) —
 * those come back as null.
 *
 * Aggressive 10-minute in-memory cache per callsign because routes are
 * stable within a day.
 */

type Airport = {
  iata: string | null;
  icao: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
};

export type RouteInfo = {
  callsign: string;
  src: Airport | null;
  dst: Airport | null;
};

const CACHE_TTL_MS = 10 * 60_000;
const FAIL_CACHE_TTL_MS = 60_000; // short cache on upstream errors
const cache = new Map<string, { data: RouteInfo | null; expires: number }>();

type UpstreamAirport = {
  iata?: string;
  icao?: string;
  location?: string;
  lat?: number;
  lon?: number;
};
type UpstreamRoute = {
  callsign?: string;
  _airports?: UpstreamAirport[] | null;
  _airport_codes_iata?: string | null;
};

function normAirport(a: UpstreamAirport | undefined): Airport | null {
  if (!a) return null;
  return {
    iata: a.iata ?? null,
    icao: a.icao ?? null,
    location: a.location ?? null,
    lat: typeof a.lat === "number" ? a.lat : null,
    lon: typeof a.lon === "number" ? a.lon : null,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ callsign: string }> },
): Promise<NextResponse> {
  const { callsign: raw } = await params;
  const callsign = raw.trim().toUpperCase();
  if (!callsign || callsign.length > 16) {
    return NextResponse.json({ error: "bad callsign" }, { status: 400 });
  }
  const latRaw = req.nextUrl.searchParams.get("lat");
  const lngRaw = req.nextUrl.searchParams.get("lng");
  const lat = latRaw != null ? Number(latRaw) : 0;
  const lng = lngRaw != null ? Number(lngRaw) : 0;

  const now = Date.now();
  const cached = cache.get(callsign);
  if (cached && cached.expires > now) {
    return NextResponse.json({ route: cached.data, cached: true });
  }

  try {
    const res = await fetch("https://api.adsb.lol/api/0/routeset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "flight-viewer (https://github.com/jiajunl23/flight-viewer)",
      },
      body: JSON.stringify({ planes: [{ callsign, lat, lng }] }),
    });
    if (!res.ok) {
      // Cache a null result briefly so transient 5xx from adsb.lol doesn't
      // cause every client to re-hit this route 60× per minute. The client
      // side also backs off but this is a defence in depth — even if a
      // buggy client spams us, we only hit upstream once per minute per
      // callsign.
      cache.set(callsign, { data: null, expires: now + FAIL_CACHE_TTL_MS });
      return NextResponse.json(
        { error: `upstream ${res.status}`, route: null },
        { status: 502 },
      );
    }
    const body = (await res.json()) as UpstreamRoute[];
    const entry = body?.[0];
    let info: RouteInfo | null = null;
    if (entry) {
      const airports = entry._airports ?? [];
      const src = normAirport(airports[0]);
      const last = airports[airports.length - 1];
      const dst =
        last && last !== airports[0] ? normAirport(last) : null;
      if (src || dst) {
        info = { callsign, src, dst };
      }
    }
    cache.set(callsign, { data: info, expires: now + CACHE_TTL_MS });
    return NextResponse.json({ route: info, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
