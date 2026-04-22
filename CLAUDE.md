# Flight Viewer — Architecture

Real-time **North America** flight tracker rendered on a 3D globe. Aircraft appear to sit on top of Earth; positions glide smoothly via client-side dead-reckoning between server updates.

The scope was pivoted from worldwide → North America during deployment because Railway's egress CIDR is blocked by OpenSky's firewall (TLS handshakes time out). adsb.lol — the free community ADS-B aggregator — is reachable and became the primary data source. OpenSky client code still lives in `apps/worker/src/opensky.ts` for anyone running the worker on a non-blocked host.

## High-level flow

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  adsb.lol               │        │  airplanes.live          │
│  /v2/point/{lat}/{lon}/ │        │  /v2/point/{lat}/{lon}/  │
│  {radius_nm} — 1 req/3s │        │  {radius} — ~1 Hz        │
└───────────┬─────────────┘        └────────────┬─────────────┘
            │                                    │
            ▼                                    ▼
   ┌────────────────────────┐      ┌──────────────────────────┐
   │ apps/worker            │      │ apps/web /api/viewport   │
   │ Railway                │      │ (Vercel serverless)      │
   │ Node.js, round-robins  │      │ Proxies airplanes.live,  │
   │ 20 NA tiles, 1 tile/3s │      │ 1.5s TTL cache, IP throttle
   │ → full NA every ~60s   │      └────────────┬─────────────┘
   └────────┬───────────────┘                   │
            │ service role                      │ passthrough JSON
            ▼                                    │
   ┌──────────────────────────────┐             │
   │ Supabase Postgres            │             │
   │  ├─ aircraft_states (world)  │             │
   │  ├─ user_preferences (RLS)   │             │
   │  └─ Realtime publication     │             │
   └────────────┬─────────────────┘             │
                │ postgres_changes              │
                ▼                                ▼
           ┌──────────────────────────────────────────┐
           │ apps/web — Next.js 15 + react-globe.gl   │
           │  ├─ Supabase Realtime subscription       │
           │  ├─ Viewport overrides from /api/viewport│
           │  └─ Dead-reckoning at 60fps              │
           └──────────────────────────────────────────┘
                          ▲
                          │ Clerk↔Supabase native third-party auth
                          │ (accessToken callback, not JWT template)
                   ┌──────┴───────┐
                   │    Clerk     │
                   └──────────────┘
```

## Data sources

- **adsb.lol (worker, Railway)**: free, no auth, soft dynamic rate limit that empirically allows 1 req/3s from datacenter IPs. The worker rotates through 20 predefined North American hub tiles (see `apps/worker/src/tiles.ts`) at 1 tile / 3s → full continent refreshes every ~60s. Each tile is 250 nm radius.
- **airplanes.live (frontend, Vercel)**: used by the Next.js `/api/viewport` route at 1 Hz when the user picks a hub. Vercel's serverless egress IPs get higher rate limits than datacenter IPs like Railway's, so it works fine there.
- **Why split**: we tested airplanes.live from Railway — it rate-limited us to ~1 req/30s (much stricter than documented), so we stick to adsb.lol for the worker. Both return identical readsb/tar1090 JSON, so swapping sources is a one-line import change if either provider ever changes terms.
- **OpenSky (dormant)**: client code at `apps/worker/src/opensky.ts` stays in the repo. Railway's IP can't reach it (TCP handshake times out). A non-Railway deploy (Fly.io, local, VPS) can re-enable it by re-importing `fetchStatesAll` in `poller.ts`.

Two tiers — "sparse baseline via adsb.lol tile rotation" + "dense viewport via airplanes.live" — together give FR24-style feel across NA airspace.

## Why dead-reckoning

Server-side cadence is ~1 s (viewport) to ~60 s (per-tile Railway refresh). Client extrapolates each aircraft's lat/lon/alt every animation frame using velocity + true_track + vertical_rate + (now − last_contact). This lets the globe render at 60 fps and makes even a 60 s per-plane refresh look live. Interpolation is capped at **300 s** (`MAX_HORIZON_S`) — enough to ride out a burst of adsb.lol 429s without whole hubs winking out, tight enough that planes that truly disappeared from the feed drop within 5 min.

## Plane rendering (FR24-style 2D icons)

Each aircraft is a flat `THREE.PlaneGeometry` (~0.47 × 0.47 units on a radius-100 globe; `PLANE_SIZE = 1.4 / 3`) textured with `apps/web/public/plane.svg` — a white airliner silhouette with a black outline, nose pointing up at rotation=0. The mesh is oriented **tangent to the globe surface**: a local basis is built at the aircraft's lat/lng (east, north, up) from two nearby `globe.getCoords` samples, then the mesh rotates by `-true_track` around its local Z (surface normal) so the nose points in the direction of travel. Color-tints the texture via `MeshBasicMaterial.color` — precedence (highest wins):

- **selected** → cyan (`#22d3ee`), 1.8× scale, raycast disabled so clicks pass through to neighbors for one-click selection switching
- **hovered** → white, 1.35× scale
- **emergency** (`emergency` field set or squawk 7500/7600/7700) → red
- **live** (icao24 in the current `/api/viewport` response) → emerald-400 (`#34d399`), same green as the "N live (1 Hz)" HUD label for palette consistency
- baseline → speed band (red→orange→yellow→lime→green from 0 m/s to >250 m/s)

Size:

- per-aircraft: base × `categoryScale(emitter cat)` — heavies 1.35×, light GA 0.7×, rotorcraft 0.6×
- hover/selected boost above (1.35× / 1.8×)
- LOD boost: 1× down to `lodKeep` 0.5, then ramps piecewise (1.5× @ 0.5, 2× @ 0.4, 3× @ 0.2) so sparsely-sampled low-zoom views stay readable

Why not 3D meshes or sprites:
- **3D cones**: looked like blobs and didn't read as aircraft at globe scale (earlier iteration).
- **Billboarded sprites**: always face the camera, ignoring the globe curvature — pins float above the surface rather than lying on it.
- **Flat PlaneGeometry tangent to surface**: matches FlightRadar24's look — icons feel pinned to the Earth, rotation visibly tracks heading as you rotate the globe.

## Running locally — what's actually live

Three data layers, three different liveness requirements:

| Layer | Source | Live locally without Railway? |
|---|---|---|
| World baseline | `aircraft_states` table (populated by `apps/worker`) | ❌ Only live when the worker is running (locally or on Railway) |
| Viewport (region-focused) | `/api/viewport` → airplanes.live directly | ✅ Works with just `pnpm dev:web` — no worker needed |
| Dead-reckoning interpolation | Client-side rAF | ✅ Always on, smooths both layers |

**If you only run `pnpm dev:web`**, the globe starts empty if the table is cold (rows older than the 300 s dead-reckoning horizon get filtered out). Click any region preset → ~1 Hz airplanes.live data over that airspace renders immediately. **Open-ended viewport use needs nothing else.**

**To populate the world baseline without deploying**, run the worker briefly:
```
pnpm --filter shared build && pnpm --filter worker build
cd apps/worker && node dist/index.js
# first tile fires immediately, then one per 3 s. Ctrl-C after ~60 s to get
# one full NA sweep. adsb.lol has no API key / no credit cost.
```

**To test frontend work without burning credits**, seed synthetic rows via Supabase MCP:
```sql
insert into aircraft_states (icao24, callsign, last_contact, latitude, longitude,
  baro_altitude, on_ground, velocity, true_track, vertical_rate)
values ('TEST0001', 'SYN001', extract(epoch from now())::bigint,
        51.47, -0.46, 10000, false, 250, 90, 0);
-- ... etc
```
Rows go stale on the client after 300 s (`MAX_HORIZON_S`) — refresh `last_contact` or reseed as needed. `delete from aircraft_states where icao24 like 'TEST%';` to clean up.

## Packages

### apps/web (Vercel)

Next.js 15 App Router, Tailwind v4, Clerk auth, `@supabase/supabase-js`, `react-globe.gl` (three.js).

Routes:
- `/` — globe view. Public for signed-out users (data read-only, no persistence). Signed-in users get favorites + theme persistence loaded/saved via `/api/preferences`.
- `/api/viewport` — server-side proxy to airplanes.live (cached 1.5 s per 0.1° tile-bucket, upstream throttled to 1 req/1.1 s)
- `/api/preferences` — GET/PUT authenticated user prefs (favorites, theme)

### apps/worker (Railway)

Single long-running Node.js process. Every 3 seconds (configurable via `TILE_INTERVAL_MS`, floor 3000ms):
1. Pick the next tile from `NA_TILES` (round-robin, 20 hubs in North America, each 250 nm radius).
2. GET `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}` (no auth).
3. Parse aircraft array into normalized `AircraftState` (converting ft→m, knots→m/s, ft/min→m/s).
4. Upsert into `aircraft_states` by `icao24` PK.
5. On error: exponential backoff (2s → 6s → 10s cap). The 10 s ceiling means worst-case full rotation never exceeds 20 × 10 = 200 s, safely under the client's 300 s stale horizon.
6. Every 5 min: prune rows with `last_contact < now − STALE_TTL_SECONDS` (default 900s).

Full continent refresh every 60 s (20 tiles × 3 s). No auth, no token management.

### packages/shared

Shared TypeScript: `AircraftState` type, OpenSky state-vector parser (dormant — kept in case Railway egress is ever reachable from OpenSky again), zod-validated env, typed Supabase client factories.

## Database

See `supabase/migrations/0001_init.sql`.

- `aircraft_states` — one row per aircraft, keyed on `icao24`. Public `select`, service-role-only `insert/update/delete`. In `supabase_realtime` publication so clients receive live upsert events.
- `user_preferences` — keyed on Clerk `user_id` (string). RLS: users can read/write only their own row. Checked via `auth.jwt() ->> 'sub' = user_id`.

## Auth flow

1. User signs in via Clerk `<SignInButton>` / `<SignUpButton>`.
2. Frontend components use `@clerk/nextjs` helpers (e.g. `<Show when="signed-in">`) to gate UI.
3. For Supabase reads/writes against RLS-protected tables, the API route creates a Supabase client via `createClient(url, anonKey, { accessToken: async () => clerkAuth.getToken() })` — this is the **native Clerk↔Supabase third-party integration**, not the deprecated "supabase" JWT template. The token is read fresh on every request so RLS always sees the current user.
4. Supabase accepts the Clerk-issued JWT because Clerk is registered as a third-party auth provider in the Supabase dashboard, and RLS policies check `auth.jwt() ->> 'sub' = user_id`.

## Render filter pipeline

Every data tick (Realtime batch flush ~500 ms, or region viewport poll) rebuilds `liveData` — the actual array of planes fed to react-globe.gl — from `snapshot`. The filter chain runs in order:

1. **Stale** — drop rows where `now − last_contact > MAX_HORIZON_S` (300 s). This is the stale horizon deliberately kept well above the 60 s happy-path tile rotation so a burst of adsb.lol 429s doesn't make hubs vanish.
2. **Selected + favorited always kept.** These bypass everything below.
3. **Spatial cull** — drop planes outside `viewRadius × 1.2`. `viewRadius` is `min(horizon, FOV-constrained)`. The FOV-constrained radius solves `sin(θ)/((1+h) − cos(θ)) = tan(fov/2)` for θ (three.js default vertical FOV is 50°). At low altitudes the horizon is far wider than what the camera actually shows; using horizon alone kept ~7× too many planes, so the FOV-aware cap is the primary spatial filter below ~altitude 1.4.
4. **Density LOD** — `icao24Hash(s.icao24) < lodKeep`. `lodKeep = lodKeepFraction(altitude)` is linearly interpolated between breakpoints (100% at 0.05 → 50% at 0.6 → 35% at 0.9 → 20% at 1.3 → 5% at 2.5 → 2% global) so a zoom nudge shifts keep continuously instead of stepping. The icao24 hash is deterministic per plane so the visible subset is stable across frames — same subset as planes move (lets you watch motion without popping), different subset as you zoom.

The HUD counter shows `visibleCount / snapshot.size` (the *true* on-screen ratio) rather than `lodKeep`, because most of the reduction comes from spatial culling before LOD even runs.

## Click + hover interaction

react-globe.gl's raycaster fires events for both the custom layer (plane meshes) and the globe surface behind it. On a single click it can fire **both** `onCustomLayerClick` and `onGlobeClick`. Two guards keep selection reliable:

- `lastLayerClickAtRef` timestamp. Stamped in `onCustomLayerClick`. `onGlobeClick` early-returns if it fires within 200 ms, so the globe-surface fallback can't clobber a selection the layer-click just made.
- Hover-leave grace. `lastHoveredRef` + `lastHoverLeftAtRef` record the last plane the cursor left. If the user clicks the globe within 300 ms of leaving a plane (typical cursor jitter between mousedown and mouseup on a moving mesh), the click commits to that plane instead of deselecting.

The selected mesh also has `raycast = NO_RAYCAST` so clicks pass straight through to whatever plane is nearest underneath — one-click selection switching without having to click the globe surface first to deselect.

## Camera UX

- **Idle auto-recenter**: the canvas tracks `lastInteractionRef` on `pointerdown`. After ~15 s of no interaction, a 1.2 s tween returns the camera to "home" — the active region's hub if one is picked, otherwise the CONUS default (lat 39, lng -97, altitude 1.1). Stops users getting lost over the Pacific and forgetting how to get back.
- **Out-of-NA reminder**: if `pointOfView().lat/lng` falls outside the NA bounding box (`lat ∈ [18, 62]`, `lng ∈ [-165, -55]`) with altitude < 2.5, a dismissible toast prompts "You've panned outside North America — click to recenter." Data coverage is NA-only, so a view of the Pacific looks broken without this hint.
- **Region picker zoom**: picking a region flies to altitude 0.15 (airport-ish zoom) — tight enough that 250 m/s motion is perceptible as ~1 px/s on a 1000 px window. Altitude 0.45 (the original default) made flights look frozen.

## Dead-reckoning math

```
now_ms          = Date.now()
elapsed_s       = clamp((now_ms / 1000) - last_contact, 0, 300)    // MAX_HORIZON_S
speed_m_per_s   = velocity
heading_rad     = true_track * π / 180
lat_new         = lat + (speed * cos(heading) * elapsed / R_earth) * (180/π)
lon_new         = lon + (speed * sin(heading) * elapsed / (R_earth * cos(lat_rad))) * (180/π)
alt_new         = clamp(baro_altitude + vertical_rate * elapsed, 0, 20000)
```

Runs in a `requestAnimationFrame` loop, updating three.js object positions in-place.

## Scale

Designed for 1–10 concurrent users. At that scale:
- adsb.lol is free and holds up at 1 req/3 s from Railway.
- airplanes.live's 1 req/s cap is sufficient for all viewport polling.
- Supabase Realtime handles fan-out without tuning.

If concurrent users grow, mitigations (in priority order):
1. Tile-snap viewports and cache per tile (shared across users).
2. Swap Realtime → 30s cached snapshot polling at `/api/states`.
3. Add ADSBexchange RapidAPI as paid overflow for hot tiles.

## Env vars

See `.env.example` at repo root. Worker and web share the same `.env.local` in dev; in prod they live in Railway and Vercel respectively.

## Deploy

- **Vercel**: root `apps/web`. Framework auto-detects Next.js.
- **Railway**: root `apps/worker`. Uses Dockerfile. Restart policy always. Single instance.
- **Supabase**: migration applied via Supabase MCP (`.mcp.json` at repo root).

## MCP

Supabase MCP server configured in `.mcp.json`. Run `claude /mcp` → select `supabase` → Authenticate (interactive, one-time per machine).
