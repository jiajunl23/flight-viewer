"use client";

import { useCallback, useRef, useState } from "react";

export interface RouteInfo {
  callsign: string;
  src: Airport | null;
  dst: Airport | null;
}

export interface Airport {
  iata: string | null;
  icao: string | null;
  location: string | null;
  lat: number | null;
  lon: number | null;
}

/**
 * Client-side cache + fetcher for callsign → route (src/dst airport) lookups.
 * Never re-fetches a callsign we already have (or already confirmed has no
 * route). Returns the current map + a `fetchRoute(callsign)` trigger.
 */
export function useRoutes(): {
  routes: Map<string, RouteInfo | null>;
  fetchRoute: (
    callsign: string | null | undefined,
    lat?: number | null,
    lng?: number | null,
  ) => void;
} {
  const [routes, setRoutes] = useState<Map<string, RouteInfo | null>>(
    () => new Map(),
  );
  const inFlight = useRef<Set<string>>(new Set());
  const knownRef = useRef<Set<string>>(new Set());

  const fetchRoute = useCallback(
    (
      callsignRaw: string | null | undefined,
      lat?: number | null,
      lng?: number | null,
    ) => {
      if (!callsignRaw) return;
      const callsign = callsignRaw.trim().toUpperCase();
      if (!callsign) return;
      if (inFlight.current.has(callsign)) return;
      if (knownRef.current.has(callsign)) return;

      inFlight.current.add(callsign);
      void (async () => {
        try {
          const qs = new URLSearchParams();
          if (lat != null) qs.set("lat", String(lat));
          if (lng != null) qs.set("lng", String(lng));
          const url = `/api/route/${encodeURIComponent(callsign)}${qs.size ? `?${qs}` : ""}`;
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) return;
          const body = (await res.json()) as { route: RouteInfo | null };
          knownRef.current.add(callsign);
          setRoutes((prev) => {
            const next = new Map(prev);
            next.set(callsign, body.route);
            return next;
          });
        } catch {
          // Swallow — we'll retry on next selection if needed.
        } finally {
          inFlight.current.delete(callsign);
        }
      })();
    },
    [],
  );

  return { routes, fetchRoute };
}
