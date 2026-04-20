"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { AircraftState } from "shared";
import { supabaseBrowser } from "@/lib/supabase-browser";

// react-globe.gl imports three.js, which has no SSR. Load client-only.
const GlobeGL = dynamic(() => import("react-globe.gl"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center text-zinc-500">
      Loading globe…
    </div>
  ),
});

type Snapshot = Map<string, AircraftState>;

/**
 * Phase 5: baseline globe. Shows every aircraft as a small colored point.
 * Subscribes to Supabase Realtime for live upserts + does an initial snapshot
 * fetch so we aren't staring at an empty globe while waiting for the first
 * worker tick.
 *
 * Phase 6 will replace the point layer with oriented 3D plane meshes +
 * client-side dead-reckoning interpolation.
 */
export default function Globe() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => new Map());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Track the container size for the globe canvas.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const resize = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initial snapshot + realtime subscription.
  useEffect(() => {
    const supa = supabaseBrowser();
    let cancelled = false;

    (async () => {
      // Paginate — the anon-key default row limit is 1000 per request.
      const all: AircraftState[] = [];
      const pageSize = 1000;
      for (let from = 0; from < 25000; from += pageSize) {
        const { data, error } = await supa
          .from("aircraft_states")
          .select("*")
          .not("latitude", "is", null)
          .range(from, from + pageSize - 1);
        if (error) {
          console.error("[globe] snapshot error", error);
          break;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as AircraftState[]));
        if (data.length < pageSize) break;
      }
      if (cancelled) return;
      const map = new Map(all.map((s) => [s.icao24, s]));
      console.log(`[globe] initial snapshot: ${map.size} aircraft`);
      setSnapshot(map);
    })();

    const channel = supa
      .channel("aircraft_states_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "aircraft_states" },
        (payload) => {
          setSnapshot((prev) => {
            const next = new Map(prev);
            if (payload.eventType === "DELETE") {
              next.delete((payload.old as AircraftState).icao24);
            } else {
              const state = payload.new as AircraftState;
              if (state.latitude != null && state.longitude != null) {
                next.set(state.icao24, state);
              }
            }
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supa.removeChannel(channel);
    };
  }, []);

  const points = useMemo(() => Array.from(snapshot.values()), [snapshot]);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden">
      <div className="absolute top-3 left-3 z-10 text-xs text-zinc-400 bg-black/50 backdrop-blur px-2 py-1 rounded">
        {points.length.toLocaleString()} aircraft
      </div>
      {size.width > 0 && (
        <GlobeGL
          width={size.width}
          height={size.height}
          backgroundColor="#000"
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
          bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
          showAtmosphere
          atmosphereColor="#5dade2"
          atmosphereAltitude={0.15}
          pointsData={points}
          pointLat={(d: object) => (d as AircraftState).latitude!}
          pointLng={(d: object) => (d as AircraftState).longitude!}
          pointAltitude={(d: object) => {
            const s = d as AircraftState;
            const alt = s.baro_altitude ?? s.geo_altitude ?? 0;
            // Scale altitude to a fraction of globe radius; airliners sit ~0.015.
            return Math.min(alt / 800_000, 0.03);
          }}
          pointColor={(d: object) => {
            const s = d as AircraftState;
            if (s.on_ground) return "#4ade80"; // green
            const alt = s.baro_altitude ?? 0;
            if (alt < 3000) return "#fbbf24"; // amber climbing/descending
            if (alt < 8000) return "#fb923c"; // orange mid
            return "#f87171"; // red cruise
          }}
          pointRadius={0.15}
          pointsMerge={false}
        />
      )}
    </div>
  );
}
