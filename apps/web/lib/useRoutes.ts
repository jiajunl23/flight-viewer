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
  // Tracks callsigns we've already resolved (success or failure) plus a
  // cooldown timestamp for failures. Prevents a 500ms snapshot-triggered
  // useEffect from re-hammering the same callsign at 2+ req/sec.
  const triedAt = useRef<Map<string, number>>(new Map());
  const FAILURE_COOLDOWN_MS = 60_000; // retry at most once per minute per callsign

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
      const lastTry = triedAt.current.get(callsign);
      if (lastTry && Date.now() - lastTry < FAILURE_COOLDOWN_MS) return;

      inFlight.current.add(callsign);
      void (async () => {
        try {
          const qs = new URLSearchParams();
          if (lat != null) qs.set("lat", String(lat));
          if (lng != null) qs.set("lng", String(lng));
          const url = `/api/route/${encodeURIComponent(callsign)}${qs.size ? `?${qs}` : ""}`;
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) {
            // Mark as tried even on failure so we don't retry every 500ms.
            triedAt.current.set(callsign, Date.now());
            return;
          }
          const body = (await res.json()) as { route: RouteInfo | null };
          // Success: "tried far in the future" so this never re-fetches.
          triedAt.current.set(callsign, Date.now() + 365 * 24 * 3600_000);
          setRoutes((prev) => {
            const next = new Map(prev);
            next.set(callsign, body.route);
            return next;
          });
        } catch {
          triedAt.current.set(callsign, Date.now());
        } finally {
          inFlight.current.delete(callsign);
        }
      })();
    },
    [],
  );

  return { routes, fetchRoute };
}
