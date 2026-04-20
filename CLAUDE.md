# Flight Viewer — Architecture

Real-time worldwide flight tracker rendered on a 3D globe. Aircraft appear to sit on top of Earth; positions glide smoothly via client-side dead-reckoning between server updates.

## High-level flow

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  OpenSky Network        │        │  airplanes.live          │
│  /states/all (worldwide)│        │  /v2/point/{lat}/{lon}/  │
│  OAuth2, ~90s cadence   │        │  {radius} — 1 Hz         │
└───────────┬─────────────┘        └────────────┬─────────────┘
            │                                    │
            ▼                                    ▼
   ┌────────────────┐              ┌──────────────────────────┐
   │ apps/worker    │              │ apps/web /api/viewport   │
   │ Railway        │              │ (Vercel serverless)      │
   │ Node.js        │              │ Proxies airplanes.live,  │
   │ upserts world  │              │ 1s TTL cache, IP bucket  │
   │ state every 90s│              └────────────┬─────────────┘
   └────────┬───────┘                           │
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
                          │ JWT (Clerk → Supabase template "supabase")
                          │
                   ┌──────┴───────┐
                   │    Clerk     │
                   └──────────────┘
```

## Why two data sources

- **OpenSky /states/all** is the only free API with a worldwide snapshot endpoint. 4,000 credits/day = one worldwide call every ~90s. Great for the "globe full of planes" baseline.
- **airplanes.live** is free with a 1 req/sec rate limit but only supports point+radius queries. Perfect for the user's focused viewport at up to 1 Hz.

The hybrid mimics FlightRadar24's "sparse global baseline + dense local refresh" UX.

## Why dead-reckoning

Server-side cadence is 5–90s depending on source. Client extrapolates each aircraft's lat/lon/alt every animation frame using velocity + true_track + vertical_rate + (now − last_contact). This lets the globe render at 60fps and makes even the 90s OpenSky cadence look live. Interpolation is capped at 120s to avoid "ghost planes."

## Packages

### apps/web (Vercel)

Next.js 15 App Router, Tailwind v4, Clerk auth, `@supabase/supabase-js`, `react-globe.gl` (three.js).

Routes:
- `/` — globe view (public; signed-out users see data read-only)
- `/preferences` — settings panel (auth-gated)
- `/api/viewport` — server-side proxy to airplanes.live
- `/api/preferences` — GET/PUT authenticated user prefs

### apps/worker (Railway)

Single long-running Node.js process. Every 90s:
1. Get/refresh OpenSky OAuth2 token (cached in memory, 30-min TTL).
2. GET `/states/all` worldwide (4 credits).
3. Parse state vectors into typed rows.
4. Upsert into `aircraft_states` by `icao24` PK, only if incoming `last_contact >= stored.last_contact`.
5. Every 5 min: prune rows with `last_contact < now − 900s`.

### packages/shared

Shared TypeScript: `AircraftState` type, OpenSky state-vector parser, zod-validated env, typed Supabase client factories.

## Database

See `supabase/migrations/0001_init.sql`.

- `aircraft_states` — one row per aircraft, keyed on `icao24`. Public `select`, service-role-only `insert/update/delete`. In `supabase_realtime` publication so clients receive live upsert events.
- `user_preferences` — keyed on Clerk `user_id` (string). RLS: users can read/write only their own row. Checked via `auth.jwt() ->> 'sub' = user_id`.

## Auth flow

1. User signs in via Clerk `<SignInButton>` / `<SignUpButton>`.
2. Frontend components use `@clerk/nextjs` helpers (e.g. `<Show when="signed-in">`) to gate UI.
3. For Supabase reads/writes against RLS-protected tables, the frontend (or API route) fetches a JWT from Clerk's `supabase` template and passes it as the Supabase auth header.
4. Supabase validates the JWT (Clerk configured as a JWT issuer in Supabase Auth settings) and enforces RLS against the `sub` claim.

## Dead-reckoning math

```
now_ms          = Date.now()
elapsed_s       = clamp((now_ms / 1000) - last_contact, 0, 120)
speed_m_per_s   = velocity
heading_rad     = true_track * π / 180
lat_new         = lat + (speed * cos(heading) * elapsed / R_earth) * (180/π)
lon_new         = lon + (speed * sin(heading) * elapsed / (R_earth * cos(lat_rad))) * (180/π)
alt_new         = clamp(baro_altitude + vertical_rate * elapsed, 0, 20000)
```

Runs in a `requestAnimationFrame` loop, updating three.js object positions in-place.

## Scale

Designed for 1–10 concurrent users. At that scale:
- OpenSky cost is fixed (one worker).
- airplanes.live 1 req/sec is sufficient.
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
