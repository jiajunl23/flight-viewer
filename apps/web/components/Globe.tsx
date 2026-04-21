"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";
import type { GlobeMethods } from "react-globe.gl";
import type { AircraftState } from "shared";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  angularDistanceRad,
  categoryScale,
  icao24Hash,
  isEmergency,
  lodKeepFraction,
  MAX_HORIZON_S,
  reckon,
  ringKeepMultiplier,
  speedColorHex,
  visibleAngularRadiusRad,
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
import FavoritesPanel from "./FavoritesPanel";
import { aircraftMatches } from "@/lib/prefs";
import { useRoutes } from "@/lib/useRoutes";
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
  isSelected: boolean,
): void {
  const r = reckon(state, nowMs);
  if (!r || r.stale || !globe) {
    // Three.js's Raycaster does NOT skip invisible meshes by default — it
    // only tests against the layer mask. Disable all layers on hidden meshes
    // so they can't steal clicks from visible ones below/around them.
    mesh.visible = false;
    mesh.layers.disableAll();
    return;
  }
  mesh.visible = true;
  mesh.layers.enable(0);

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
  // Selected aircraft get an additional 1.8× boost so they stand out.
  const scale = categoryScale(state.category) * (isSelected ? 1.8 : 1);
  mesh.scale.setScalar(scale);

  // Color: selected → cyan (most prominent), emergency → red, otherwise speed band.
  const colorHex = isSelected
    ? 0x22d3ee
    : isEmergency(state.emergency, state.squawk)
      ? 0xff0000
      : speedColorHex(state.velocity ?? 0);
  if (mesh.__lastColor !== colorHex) {
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
    mesh.__lastColor = colorHex;
  }
  mesh.renderOrder = isSelected ? 2 : 1;
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
  // Density LOD + spatial culling — reduces rendered plane count when zoomed
  // out AND when planes are outside the visible cap. Updates in a 400ms
  // interval so tiny zoom/pan wiggles don't flicker the mesh set.
  const [lodKeep, setLodKeep] = useState<number>(1.0);
  const [viewCenter, setViewCenter] = useState<{ lat: number; lng: number }>({
    lat: 39,
    lng: -97,
  });
  // Angular radius of the visible spherical cap around viewCenter, in radians.
  // Start at π so on first render nothing is culled.
  const [viewRadius, setViewRadius] = useState<number>(Math.PI);
  useEffect(() => {
    const interval = setInterval(() => {
      const pov = globeRef.current?.pointOfView();
      if (!pov) return;
      const targetKeep = lodKeepFraction(pov.altitude);
      const targetRadius = visibleAngularRadiusRad(pov.altitude);
      setLodKeep((prev) =>
        Math.abs(prev - targetKeep) > 0.001 ? targetKeep : prev,
      );
      setViewRadius((prev) =>
        Math.abs(prev - targetRadius) > 0.02 ? targetRadius : prev,
      );
      setViewCenter((prev) => {
        // Pan threshold: re-snap only when POV has meaningfully moved so the
        // liveData recompute doesn't run on every 400ms tick.
        if (
          Math.abs(prev.lat - pov.lat) > 1 ||
          Math.abs(prev.lng - pov.lng) > 1
        ) {
          return { lat: pov.lat, lng: pov.lng };
        }
        return prev;
      });
    }, 400);
    return () => clearInterval(interval);
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  // Guard so onGlobeReady doesn't snap the camera back to the default view on
  // later re-mounts / Strict-Mode double invocations. The initial pan is a
  // one-time "open the app on North America" gesture.
  const didInitialPanRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { isSignedIn } = useUser();
  const { getToken: _getToken } = useAuth();
  const { routes, fetchRoute } = useRoutes();

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

    // Batch Realtime events to one setSnapshot per 500ms — at peak the worker
    // upserts hundreds of rows per tile tick, and one render per row was
    // causing the visible glitching.
    const pendingUpserts = new Map<string, AircraftState>();
    const pendingDeletes = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      flushTimer = null;
      if (pendingUpserts.size === 0 && pendingDeletes.size === 0) return;
      const upserts = Array.from(pendingUpserts.values());
      const deletes = Array.from(pendingDeletes);
      pendingUpserts.clear();
      pendingDeletes.clear();
      setSnapshot((prev) => {
        const next = new Map(prev);
        for (const s of upserts) next.set(s.icao24, s);
        for (const id of deletes) next.delete(id);
        return next;
      });
    };

    const schedule = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, 500);
    };

    const channel = supa
      .channel("aircraft_states_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "aircraft_states" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            pendingDeletes.add((payload.old as AircraftState).icao24);
          } else {
            const state = payload.new as AircraftState;
            if (state.latitude != null && state.longitude != null) {
              pendingUpserts.set(state.icao24, state);
            }
          }
          schedule();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (flushTimer) clearTimeout(flushTimer);
      void supa.removeChannel(channel);
    };
  }, []);

  // Filter out stale rows once per data tick (not per-frame).
  //   1. Stale filter (last_contact past 120s horizon)
  //   2. User filters (country/airline/altitude/on-ground)
  //   3. Spatial cull — drop planes outside visibleRadius × 1.2 (behind the
  //      horizon); selected + favorited planes always kept.
  //   4. Concentric-ring density — effective keep fraction =
  //        lodKeep  (altitude-based base)
  //        ×  ringKeepMultiplier(dist / viewRadius)  (distance-based falloff)
  //      so planes near the camera's center render dense, planes near the
  //      edge of the visible cap thin out. 100% only happens when the user
  //      is zoomed deep AND the plane is within the center focus zone.
  const liveData = useMemo(() => {
    const now = Date.now() / 1000;
    const radiusLimit = Math.min(Math.PI, viewRadius * 1.2);
    const safeRadius = Math.max(0.01, viewRadius);
    return Array.from(snapshot.values()).filter((s) => {
      if (!s.last_contact) return false;
      if (now - s.last_contact > MAX_HORIZON_S) return false;
      if (!aircraftMatches(s, filters)) return false;

      const keptForUser =
        s.icao24 === selected || favorites.has(s.icao24);
      if (keptForUser) return true;
      if (s.latitude == null || s.longitude == null) return false;

      const d = angularDistanceRad(
        viewCenter.lat,
        viewCenter.lng,
        s.latitude,
        s.longitude,
      );
      if (d > radiusLimit) return false;

      // At city-level zoom (lodKeep=1) the visible cap is small enough that
      // the ring falloff becomes overkill — everything "nearby" is relevant.
      // Skip it so zoomed-in users actually see 100% of planes in view.
      const effectiveKeep =
        lodKeep >= 1
          ? 1
          : lodKeep * ringKeepMultiplier(d / safeRadius);
      if (effectiveKeep >= 1) return true;
      return icao24Hash(s.icao24) < effectiveKeep;
    });
  }, [
    snapshot,
    filters,
    lodKeep,
    viewCenter,
    viewRadius,
    selected,
    favorites,
  ]);

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
      else {
        next.add(icao24);
        // Fetch route for the newly-starred aircraft so the Tracking panel
        // can display src → dst.
        const state = snapshotRef.current.get(icao24);
        if (state?.callsign)
          fetchRoute(state.callsign, state.latitude, state.longitude);
      }
      return next;
    });
  };

  // Whenever the selected aircraft changes, lazily look up its route so the
  // popover can show src → dst. Cached per callsign.
  useEffect(() => {
    if (!selected) return;
    const s = snapshot.get(selected);
    if (s?.callsign) fetchRoute(s.callsign, s.latitude, s.longitude);
  }, [selected, snapshot, fetchRoute]);

  // On mount: fetch routes for any planes already in the favorites set (after
  // preferences load). Prevents an empty panel on page reload.
  useEffect(() => {
    for (const id of favorites) {
      const s = snapshot.get(id);
      if (s?.callsign) fetchRoute(s.callsign, s.latitude, s.longitude);
    }
  }, [favorites, snapshot, fetchRoute]);

  const selectFromPanel = (icao24: string): void => {
    selectedRef.current = icao24;
    setSelected(icao24);
    // Pan the camera to the plane so it's visible.
    const s = snapshot.get(icao24);
    if (s?.latitude != null && s?.longitude != null) {
      globeRef.current?.pointOfView(
        { lat: s.latitude, lng: s.longitude, altitude: 0.8 },
        900,
      );
    }
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

  // Keep `selected` reachable from the rAF loop without triggering re-renders.
  const selectedRef = useRef<string | null>(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Idle auto-recenter — if the user rotates away and then stops interacting
  // for IDLE_MS, smoothly animate back to home over RETURN_MS.
  // "Home" is the active region's hub (if picked) else the CONUS default.
  const lastInteractionRef = useRef<number>(Date.now());
  // Ref-copy of region so the setInterval callback always sees the latest.
  const regionRef = useRef<Region | null>(region);
  useEffect(() => {
    regionRef.current = region;
    // A region change IS a deliberate camera jump — reset idle so the user
    // has a moment to look around before auto-recenter kicks in again.
    lastInteractionRef.current = Date.now();
  }, [region]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const canvas = globe.renderer?.().domElement;
    if (!canvas) return;
    const mark = () => {
      lastInteractionRef.current = Date.now();
    };
    canvas.addEventListener("pointerdown", mark);
    canvas.addEventListener("wheel", mark, { passive: true });
    canvas.addEventListener("touchstart", mark, { passive: true });
    return () => {
      canvas.removeEventListener("pointerdown", mark);
      canvas.removeEventListener("wheel", mark);
      canvas.removeEventListener("touchstart", mark);
    };
  }, []);

  // Reminder banner when user rotates out of NA. Combined with the auto-
  // recenter interval so we only do one poll.
  const [outOfNA, setOutOfNA] = useState(false);
  const [naReminderDismissed, setNaReminderDismissed] = useState(false);

  // Re-arm the reminder once the user returns to NA — so if they rotate away
  // again later, it shows once more.
  useEffect(() => {
    if (!outOfNA) setNaReminderDismissed(false);
  }, [outOfNA]);

  useEffect(() => {
    const IDLE_MS = 15_000;
    const RETURN_MS = 3_000;

    // NA coverage bounds — matches the worker's tile spread (Anchorage to
    // Mexico City, east coast to Alaska). Used both for the reminder banner
    // and the auto-recenter. The altitude cap distinguishes "zoomed into a
    // specific city within NA" from "zoomed so far out you're viewing the
    // whole planet".
    const cameraSeesNA = (pov: {
      lat: number;
      lng: number;
      altitude: number;
    }): boolean => {
      const inLat = pov.lat >= 18 && pov.lat <= 62;
      const inLng = pov.lng >= -165 && pov.lng <= -55;
      const closeEnough = pov.altitude < 2.5;
      return inLat && inLng && closeEnough;
    };

    const check = setInterval(() => {
      const globe = globeRef.current;
      if (!globe) return;
      const pov = globe.pointOfView();
      const seesNA = cameraSeesNA(pov);
      setOutOfNA(!seesNA);

      // Auto-recenter ONLY fires when the user has been idle AND the camera
      // is NOT looking at NA. Panning within NA (e.g. zoomed in on Chicago)
      // should never trigger a jump.
      if (seesNA) return;
      if (Date.now() - lastInteractionRef.current < IDLE_MS) return;
      const home: { lat: number; lng: number; altitude: number } = regionRef
        .current
        ? { lat: regionRef.current.lat, lng: regionRef.current.lon, altitude: 0.45 }
        : { lat: 39, lng: -97, altitude: 1.1 };
      globe.pointOfView(home, RETURN_MS);
      lastInteractionRef.current = Date.now() + RETURN_MS;
    }, 2_000);
    return () => clearInterval(check);
  }, []);

  const recenterNow = (): void => {
    const home = regionRef.current
      ? { lat: regionRef.current.lat, lng: regionRef.current.lon, altitude: 0.45 }
      : { lat: 39, lng: -97, altitude: 1.1 };
    globeRef.current?.pointOfView(home, 1_200);
    lastInteractionRef.current = Date.now() + 1_200;
  };

  // Per-frame dead-reckoning: walk the scene on every rAF and extrapolate
  // each plane mesh from its last known state. react-globe.gl's
  // customThreeObjectUpdate only fires when data changes, not per frame.
  // Also tracks the selected aircraft's screen position so the popover can
  // follow it (CSS transform via ref — no React re-render).
  useEffect(() => {
    let rafId = 0;
    const projVec = new THREE.Vector3();
    const tick = () => {
      const globe = globeRef.current;
      const now = Date.now();
      const sel = selectedRef.current;
      if (globe) {
        const scene = globe.scene();
        let selectedMesh: PlaneMesh | null = null;
        scene.traverse((obj) => {
          const mesh = obj as PlaneMesh;
          const icao24 = mesh.__icao24;
          if (!icao24) return;
          const state = snapshotRef.current.get(icao24);
          if (!state) return;
          const isSel = icao24 === sel;
          updatePlaneMesh(mesh, state, globe, now, isSel);
          if (isSel) selectedMesh = mesh;
        });

        // Position popover near the selected aircraft.
        if (selectedMesh && popoverRef.current) {
          const m = selectedMesh as PlaneMesh;
          projVec.copy(m.position).project(globe.camera());
          const canvas = globe.renderer().domElement;
          const x = (projVec.x * 0.5 + 0.5) * canvas.clientWidth;
          const y = (-projVec.y * 0.5 + 0.5) * canvas.clientHeight;
          const behindCamera = projVec.z > 1; // plane is on the far side
          const offscreen =
            x < -300 || x > canvas.clientWidth + 300 ||
            y < -300 || y > canvas.clientHeight + 300;
          const hidden = behindCamera || offscreen;
          popoverRef.current.style.transform = `translate3d(${x + 16}px, ${y + 12}px, 0)`;
          popoverRef.current.style.opacity = hidden ? "0" : "1";
          popoverRef.current.style.pointerEvents = hidden ? "none" : "auto";
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden">
      <div className="absolute top-3 left-3 z-10 text-xs text-zinc-400 bg-black/50 backdrop-blur px-2 py-1 rounded space-y-0.5">
        <div>
          {visibleCount.toLocaleString()} aircraft
          {lodKeep < 1 && (
            <span className="ml-1 text-zinc-600">
              (of {snapshot.size.toLocaleString()}, {Math.round(lodKeep * 100)}%)
            </span>
          )}
        </div>
        {viewportCount !== null && region && (
          <div className="text-emerald-400">
            {region.name}: {viewportCount} live (1 Hz)
          </div>
        )}
      </div>

      {outOfNA && !naReminderDismissed && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-amber-900/85 border border-amber-500/60 backdrop-blur rounded px-3 py-2 text-xs text-amber-100 shadow-xl flex items-center gap-3 max-w-[520px]">
          <span aria-hidden className="text-base">🌎</span>
          <span>
            This tracker only covers <strong>North America</strong> — aircraft
            in other regions won&apos;t appear on the globe.
          </span>
          <button
            onClick={recenterNow}
            className="px-2 py-1 rounded bg-amber-200 text-amber-950 font-semibold hover:bg-amber-100 transition-colors"
          >
            Recenter
          </button>
          <button
            onClick={() => setNaReminderDismissed(true)}
            aria-label="Dismiss"
            className="text-amber-300 hover:text-amber-100 leading-none"
          >
            ✕
          </button>
        </div>
      )}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-2 items-end">
        <RegionPicker onChange={setRegion} />
        <div className="bg-black/60 backdrop-blur rounded px-2 py-1.5">
          <ThemeSwitcher value={theme} onChange={setTheme} />
        </div>
      </div>
      <FiltersPanel value={filters} onChange={setFilters} />
      {selectedState && (
        <div
          // Re-mount the popover each time the selected icao24 changes so the
          // initial transform starts off-screen rather than at the previous
          // plane's position. This is what eliminates the mid-air flash during
          // a rapid plane-to-plane switch.
          key={selectedState.icao24}
          ref={popoverRef}
          // Positioned via inline transform from the rAF loop (follows the
          // selected aircraft on screen). Initial off-screen + transparent;
          // the rAF loop reveals it on the first frame a valid screen
          // position is computed.
          style={{
            transform: "translate3d(-9999px, -9999px, 0)",
            opacity: 0,
            transition: "opacity 120ms ease-out",
          }}
          className={`absolute top-0 left-0 z-20 backdrop-blur rounded px-3 py-2 text-xs text-zinc-200 max-w-[280px] space-y-1 shadow-xl ${
            isEmergency(selectedState.emergency, selectedState.squawk)
              ? "bg-red-950/95 border border-red-500"
              : "bg-black/85 border border-cyan-500/60"
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
          {(() => {
            const callsignKey = selectedState.callsign?.trim().toUpperCase();
            const route = callsignKey ? routes.get(callsignKey) : undefined;
            if (!route?.src?.iata || !route?.dst?.iata) return null;
            return (
              <div className="text-cyan-300 text-[11px] font-mono">
                {route.src.iata} → {route.dst.iata}
                <span className="block text-zinc-500 font-sans">
                  {route.src.location} → {route.dst.location}
                </span>
              </div>
            );
          })()}
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
      {isSignedIn && (
        <FavoritesPanel
          favorites={favorites}
          snapshot={snapshot}
          routes={routes}
          selectedIcao24={selected}
          onSelect={selectFromPanel}
          onUnstar={toggleFavorite}
        />
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
            // Only run the pan once — Strict Mode or any later re-mount
            // shouldn't yank the user back to the default view.
            if (!didInitialPanRef.current) {
              didInitialPanRef.current = true;
              globeRef.current?.pointOfView(
                { lat: 39, lng: -97, altitude: 1.1 },
                0,
              );
            }
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
              }).__select = (id) => {
                selectedRef.current = id;
                setSelected(id);
              };
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
            // Sync-update the ref BEFORE scheduling the React state change so
            // the next rAF frame already reflects the new selection — avoids
            // the 1-2 frame flash where the old plane stays highlighted.
            selectedRef.current = state.icao24;
            setSelected(state.icao24);
          }}
          // Clicking empty globe surface clears the selected plane so the
          // popover dismisses. Clicks in the black background around the
          // globe are handled by the container's onClick below.
          onGlobeClick={() => {
            selectedRef.current = null;
            setSelected(null);
          }}
          customThreeObjectUpdate={(obj: object, d: object) => {
            // Fires once when the data row changes (e.g. new server tick).
            // Per-frame interpolation happens in the rAF loop below.
            const state = d as AircraftState;
            updatePlaneMesh(
              obj as PlaneMesh,
              state,
              globeRef.current,
              Date.now(),
              state.icao24 === selectedRef.current,
            );
          }}
        />
      )}
    </div>
  );
}
