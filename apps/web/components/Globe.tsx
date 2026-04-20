"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";
import type { GlobeMethods } from "react-globe.gl";
import type { AircraftState } from "shared";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  altitudeColorHex,
  MAX_HORIZON_S,
  reckon,
} from "./DeadReckoning";

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
 * Shared geometry/material across every plane — three.js instancing via
 * custom objects isn't available through react-globe.gl's customLayer, but
 * reusing geometry across a few thousand meshes is still cheap.
 */
// Globe radius in three-globe is 100 units by default, so the cone must
// be ~1 unit tall to be visible at typical zoom.
const PLANE_GEOMETRY = new THREE.ConeGeometry(0.4, 1.6, 6);
// Cone defaults to +Y tip; rotate so the tip points along +X (direction of travel)
// before we re-orient tangent to the globe surface in the update callback.
PLANE_GEOMETRY.rotateZ(-Math.PI / 2);

type PlaneMesh = THREE.Mesh & {
  __lastColor?: number;
  __icao24?: string;
};

function makePlaneMesh(icao24: string, initialColor = 0xf87171): PlaneMesh {
  const material = new THREE.MeshBasicMaterial({ color: initialColor });
  const mesh = new THREE.Mesh(PLANE_GEOMETRY, material) as PlaneMesh;
  mesh.__lastColor = initialColor;
  mesh.__icao24 = icao24;
  return mesh;
}

function updatePlaneMesh(
  mesh: PlaneMesh,
  state: AircraftState,
  globe: GlobeMethods | undefined,
  nowMs: number,
): void {
  const r = reckon(state, nowMs);
  if (!r || r.stale) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;

  const coords = globe?.getCoords(
    r.lat,
    r.lng,
    Math.min(r.alt / 800_000, 0.03),
  );
  if (coords) mesh.position.set(coords.x, coords.y, coords.z);

  const up = mesh.position.clone().normalize();
  mesh.up.copy(up);
  mesh.lookAt(0, 0, 0);
  mesh.rotateX(Math.PI / 2);
  const heading = (state.true_track ?? 0) * (Math.PI / 180);
  mesh.rotateZ(-heading);

  const colorHex = altitudeColorHex(r.alt, state.on_ground);
  if (mesh.__lastColor !== colorHex) {
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
    mesh.__lastColor = colorHex;
  }
}

export default function Globe() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => new Map());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [visibleCount, setVisibleCount] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);

  // Keep the latest snapshot reachable from the per-frame update callback.
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

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

  useEffect(() => {
    const supa = supabaseBrowser();
    let cancelled = false;

    (async () => {
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

  // Filter out stale rows once per data tick (not per-frame). Dead-reckoning
  // still extrapolates each visible row every frame via customThreeObjectUpdate.
  const liveData = useMemo(() => {
    const now = Date.now() / 1000;
    return Array.from(snapshot.values()).filter(
      (s) => s.last_contact && now - s.last_contact <= MAX_HORIZON_S,
    );
  }, [snapshot]);

  useEffect(() => {
    setVisibleCount(liveData.length);
  }, [liveData]);

  // Per-frame dead-reckoning: walk the scene on every rAF and extrapolate
  // each plane mesh from its last known state. react-globe.gl's
  // customThreeObjectUpdate only fires when data changes, not per frame.
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const globe = globeRef.current;
      const now = Date.now();
      if (globe) {
        const scene = globe.scene();
        scene.traverse((obj) => {
          const mesh = obj as PlaneMesh;
          const icao24 = mesh.__icao24;
          if (!icao24) return;
          const state = snapshotRef.current.get(icao24);
          if (!state) return;
          updatePlaneMesh(mesh, state, globe, now);
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden">
      <div className="absolute top-3 left-3 z-10 text-xs text-zinc-400 bg-black/50 backdrop-blur px-2 py-1 rounded">
        {visibleCount.toLocaleString()} aircraft
      </div>
      {size.width > 0 && (
        <GlobeGL
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="#000"
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
          bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
          showAtmosphere
          atmosphereColor="#5dade2"
          atmosphereAltitude={0.15}
          onGlobeReady={() => {
            globeRef.current?.pointOfView(
              { lat: 45, lng: 10, altitude: 1.2 },
              0,
            );
            // Expose to window for debugging / Playwright introspection only in dev.
            if (
              process.env.NODE_ENV !== "production" &&
              globeRef.current
            ) {
              (window as unknown as { __globe?: GlobeMethods }).__globe =
                globeRef.current;
            }
          }}
          // Custom layer: one THREE.Mesh per aircraft. react-globe.gl handles
          // positioning on the sphere (lat/lng/alt → world coords) plus tangent
          // orientation. We add heading rotation inside the update callback.
          customLayerData={liveData}
          customThreeObject={(d: object) => {
            const state = d as AircraftState;
            return makePlaneMesh(state.icao24);
          }}
          customThreeObjectUpdate={(obj: object, d: object) => {
            // Fires once when the data row changes (e.g. new server tick).
            // Per-frame interpolation happens in the rAF loop below.
            updatePlaneMesh(
              obj as PlaneMesh,
              d as AircraftState,
              globeRef.current,
              Date.now(),
            );
          }}
        />
      )}
    </div>
  );
}
