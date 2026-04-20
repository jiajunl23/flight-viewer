"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";
import type { GlobeMethods } from "react-globe.gl";
import type { AircraftState } from "shared";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  categoryScale,
  isEmergency,
  MAX_HORIZON_S,
  reckon,
  speedColorHex,
} from "./DeadReckoning";
import RegionPicker, { type Region } from "./RegionPicker";
import FiltersPanel, {
  EMPTY_FILTERS,
  type Filters,
} from "./FiltersPanel";
import ThemeSwitcher, {
  THEME_TEXTURES,
  type Theme,
} from "./ThemeSwitcher";
import FavoritesStar from "./FavoritesStar";
import { aircraftMatches } from "@/lib/prefs";
import { useAuth, useUser } from "@clerk/nextjs";

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
 * Flat 2D plane silhouette lying tangent to the globe surface, nose pointing
 * in direction of travel. Mirrors FlightRadar24's look — icons feel pinned
 * to the Earth rather than floating above it as 3D cones did.
 *
 * Globe radius in three-globe is 100 units by default, so ~1.4 units is small
 * enough to be unobtrusive at global zoom and recognizable at region zoom.
 */
const PLANE_SIZE = 1.4;
const PLANE_GEOMETRY = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);

// TextureLoader uses `Image`, which only exists in the browser. `next/dynamic`
// with ssr:false only defers the COMPONENT render; the module still evaluates
// during SSR. Lazily initialize in the browser on first mesh creation.
let _planeTexture: THREE.Texture | null = null;
function getPlaneTexture(): THREE.Texture {
  if (_planeTexture) return _planeTexture;
  const t = new THREE.TextureLoader().load("/plane.svg");
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _planeTexture = t;
  return t;
}

type PlaneMesh = THREE.Mesh & {
  __lastColor?: number;
  __icao24?: string;
};

// Reused scratch vectors so the per-frame update doesn't allocate.
const _pos = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Vector3();
const _north = new THREE.Vector3();
const _east = new THREE.Vector3();
const _up = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function makePlaneMesh(icao24: string, initialColor = 0xff6b6b): PlaneMesh {
  const material = new THREE.MeshBasicMaterial({
    map: getPlaneTexture(),
    color: initialColor,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(PLANE_GEOMETRY, material) as PlaneMesh;
  mesh.renderOrder = 1; // draw planes after globe
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
  if (!r || r.stale || !globe) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;

  const altFrac = Math.min(r.alt / 800_000, 0.03);
  const coords = globe.getCoords(r.lat, r.lng, altFrac);
  _pos.set(coords.x, coords.y, coords.z);
  mesh.position.copy(_pos);

  // Build a tangent basis from two nearby surface points so we can lay the
  // plane mesh flat against the globe, +Y pointing to compass north.
  const nC = globe.getCoords(r.lat + 0.05, r.lng, altFrac);
  const eC = globe.getCoords(r.lat, r.lng + 0.05, altFrac);
  _n.set(nC.x - coords.x, nC.y - coords.y, nC.z - coords.z);
  _e.set(eC.x - coords.x, eC.y - coords.y, eC.z - coords.z);
  _north.copy(_n).normalize();
  _east.copy(_e).normalize();
  _up.crossVectors(_east, _north).normalize();

  _basis.makeBasis(_east, _north, _up);
  mesh.setRotationFromMatrix(_basis);

  // Compass heading 0=N,90=E (clockwise looking down) → rotate around +Z by -rad.
  const headingRad = (state.true_track ?? 0) * (Math.PI / 180);
  mesh.rotateZ(-headingRad);

  // Scale by ADS-B emitter category — heavies render bigger, helicopters smaller.
  const scale = categoryScale(state.category);
  mesh.scale.setScalar(scale);

  // Color: emergency overrides everything with bright red; otherwise speed band.
  const colorHex = isEmergency(state.emergency, state.squawk)
    ? 0xff0000
    : speedColorHex(state.velocity ?? 0);
  if (mesh.__lastColor !== colorHex) {
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
    mesh.__lastColor = colorHex;
  }
}

export default function Globe() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => new Map());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [visibleCount, setVisibleCount] = useState(0);
  const [region, setRegion] = useState<Region | null>(null);
  const [viewportCount, setViewportCount] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [theme, setTheme] = useState<Theme>("blue-marble");
  const [selected, setSelected] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const { isSignedIn } = useUser();
  const { getToken: _getToken } = useAuth();

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
  // Also apply user filters here — keeps client-side rendering predictable.
  const liveData = useMemo(() => {
    const now = Date.now() / 1000;
    return Array.from(snapshot.values()).filter(
      (s) =>
        s.last_contact &&
        now - s.last_contact <= MAX_HORIZON_S &&
        aircraftMatches(s, filters),
    );
  }, [snapshot, filters]);

  // Load preferences on sign-in; save when they change (debounced).
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/preferences", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          preferences: {
            favorites: string[];
            filter_countries: string[];
            filter_airlines: string[];
            altitude_min: number | null;
            altitude_max: number | null;
            show_on_ground: boolean;
            theme: Theme;
          } | null;
        };
        if (cancelled || !body.preferences) return;
        const p = body.preferences;
        setFavorites(new Set(p.favorites));
        setFilters({
          countries: p.filter_countries,
          airlines: p.filter_airlines,
          altitudeMin: p.altitude_min,
          altitudeMax: p.altitude_max,
          showOnGround: p.show_on_ground,
        });
        setTheme(p.theme);
      } catch (err) {
        console.warn("[prefs] load", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  // Persist on change (simple debounce so keystrokes don't flood).
  useEffect(() => {
    if (!isSignedIn) return;
    const t = setTimeout(() => {
      void fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          favorites: Array.from(favorites),
          filter_countries: filters.countries,
          filter_airlines: filters.airlines,
          altitude_min: filters.altitudeMin,
          altitude_max: filters.altitudeMax,
          show_on_ground: filters.showOnGround,
          theme,
        }),
      }).catch((err) => console.warn("[prefs] save", err));
    }, 500);
    return () => clearTimeout(t);
  }, [isSignedIn, favorites, filters, theme]);

  const toggleFavorite = (icao24: string): void => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(icao24)) next.delete(icao24);
      else next.add(icao24);
      return next;
    });
  };

  const selectedState =
    selected !== null ? snapshot.get(selected) ?? null : null;

  useEffect(() => {
    setVisibleCount(liveData.length);
  }, [liveData]);

  // Viewport polling: when the user has a focused region, hit /api/viewport
  // once per second and merge the fresher airplanes.live data into the state
  // map (viewport rows override world baseline because their last_contact is
  // always newer — icao24 conflicts win the MAX(last_contact) check).
  useEffect(() => {
    if (!region) {
      setViewportCount(null);
      return;
    }
    let cancelled = false;

    // Fly the camera to the region.
    globeRef.current?.pointOfView(
      { lat: region.lat, lng: region.lon, altitude: 0.45 },
      1200,
    );

    let backoffMs = 1000;
    const MIN_DELAY = 1000;
    const MAX_BACKOFF = 15_000;

    const loop = async () => {
      while (!cancelled) {
        const start = Date.now();
        let ok = false;
        try {
          const res = await fetch(
            `/api/viewport?lat=${region.lat}&lon=${region.lon}&radius=${region.radius}`,
            { cache: "no-store" },
          );
          if (res.ok) {
            const body = (await res.json()) as {
              states: AircraftState[];
              cached: boolean;
              stale?: boolean;
            };
            if (cancelled) return;
            setViewportCount(body.states.length);
            setSnapshot((prev) => {
              const next = new Map(prev);
              for (const s of body.states) next.set(s.icao24, s);
              return next;
            });
            // Success: reset backoff.
            backoffMs = MIN_DELAY;
            ok = true;
          }
        } catch (err) {
          console.warn("[viewport] poll error", err);
        }
        if (!ok) {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
        }
        const elapsed = Date.now() - start;
        const delay = Math.max(MIN_DELAY, backoffMs) - elapsed;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    };
    void loop();

    return () => {
      cancelled = true;
    };
  }, [region]);

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
      <div className="absolute top-3 left-3 z-10 text-xs text-zinc-400 bg-black/50 backdrop-blur px-2 py-1 rounded space-y-0.5">
        <div>{visibleCount.toLocaleString()} aircraft</div>
        {viewportCount !== null && region && (
          <div className="text-emerald-400">
            {region.name}: {viewportCount} live (1 Hz)
          </div>
        )}
      </div>
      <RegionPicker onChange={setRegion} />
      <div className="absolute top-[84px] right-3 z-10">
        <ThemeSwitcher value={theme} onChange={setTheme} />
      </div>
      <FiltersPanel value={filters} onChange={setFilters} />
      {selectedState && (
        <div
          className={`absolute bottom-3 right-3 z-10 backdrop-blur rounded px-3 py-2 text-xs text-zinc-200 max-w-[300px] space-y-1 ${
            isEmergency(selectedState.emergency, selectedState.squawk)
              ? "bg-red-950/90 border border-red-500"
              : "bg-black/70"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sm">
              {selectedState.callsign ?? selectedState.icao24}
              {selectedState.registration &&
                selectedState.registration !== selectedState.callsign && (
                  <span className="ml-1.5 text-zinc-500 font-normal">
                    ({selectedState.registration})
                  </span>
                )}
            </span>
            <div className="flex items-center gap-1">
              {isSignedIn && (
                <FavoritesStar
                  favored={favorites.has(selectedState.icao24)}
                  onToggle={() => toggleFavorite(selectedState.icao24)}
                />
              )}
              <button
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="text-zinc-500 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
          </div>
          {selectedState.aircraft_type && (
            <div className="text-zinc-400 text-[11px] uppercase tracking-wide">
              {selectedState.aircraft_type}
              {selectedState.category && (
                <span className="ml-2 text-zinc-600">
                  · cat {selectedState.category}
                </span>
              )}
            </div>
          )}
          {isEmergency(selectedState.emergency, selectedState.squawk) && (
            <div className="text-red-300 font-semibold">
              ⚠ EMERGENCY{" "}
              {selectedState.emergency && selectedState.emergency !== "none"
                ? selectedState.emergency.toUpperCase()
                : `SQ ${selectedState.squawk}`}
            </div>
          )}
          <div>
            Alt:{" "}
            {(selectedState.baro_altitude ?? selectedState.geo_altitude ?? 0).toFixed(0)}m
            {selectedState.on_ground && " (ground)"}
          </div>
          <div>
            Spd: {(selectedState.velocity ?? 0).toFixed(0)} m/s · Hdg:{" "}
            {(selectedState.true_track ?? 0).toFixed(0)}°
          </div>
          {selectedState.squawk && (
            <div className="text-zinc-500 text-[11px]">
              Sq {selectedState.squawk}
              {selectedState.spi && " · SPI"}
            </div>
          )}
        </div>
      )}
      {favorites.size > 0 && isSignedIn && (
        <div className="absolute bottom-3 left-[280px] z-10 bg-black/60 backdrop-blur rounded text-xs text-zinc-300 px-3 py-2 max-w-[240px]">
          <div className="text-zinc-400 mb-1">
            Favorites ({favorites.size})
          </div>
          <div className="flex flex-wrap gap-1">
            {Array.from(favorites)
              .slice(0, 12)
              .map((id) => {
                const s = snapshot.get(id);
                return (
                  <button
                    key={id}
                    onClick={() => setSelected(id)}
                    className="px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-200 hover:bg-yellow-800/60"
                  >
                    {s?.callsign ?? id}
                  </button>
                );
              })}
          </div>
        </div>
      )}
      {size.width > 0 && (
        <GlobeGL
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="#000"
          globeImageUrl={THEME_TEXTURES[theme]}
          bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
          showAtmosphere
          atmosphereColor="#5dade2"
          atmosphereAltitude={0.15}
          onGlobeReady={() => {
            // Default view: centered on continental US, altitude tuned so CONUS
            // fills most of the viewport while Canada + Mexico remain visible.
            globeRef.current?.pointOfView(
              { lat: 39, lng: -97, altitude: 1.1 },
              0,
            );
            // Expose to window for debugging / Playwright introspection only in dev.
            if (
              process.env.NODE_ENV !== "production" &&
              globeRef.current
            ) {
              (window as unknown as {
                __globe?: GlobeMethods;
                __select?: (icao24: string | null) => void;
              }).__globe = globeRef.current;
              (window as unknown as {
                __select?: (icao24: string | null) => void;
              }).__select = setSelected;
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
          onCustomLayerClick={(d: object) => {
            const state = d as AircraftState;
            setSelected(state.icao24);
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
