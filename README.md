# Flight Viewer

Real-time worldwide flight tracker with a 3D globe. Next.js frontend + Node.js background worker + Supabase + Clerk.

See [`CLAUDE.md`](./CLAUDE.md) for architecture.

## Quick start

```bash
pnpm install
cp .env.example .env.local   # fill in values
pnpm dev:web                 # http://localhost:3000
pnpm dev:worker              # background poller
```

## Monorepo layout

- `apps/web` — Next.js 15 (App Router) + Tailwind + Clerk + react-globe.gl
- `apps/worker` — Node.js TypeScript background worker, deployed to Railway
- `packages/shared` — shared types, env validation, Supabase clients
- `supabase/migrations` — SQL migrations applied via Supabase MCP

## Env vars

See `.env.example`. For production, set the same values in **Vercel** (web) and **Railway** (worker) dashboards.

### Where to get keys

- **Supabase**: [project dashboard](https://supabase.com/dashboard/project/kjzqpnshlojsjkxqkhmd) → Settings → API
- **Clerk**: [dashboard.clerk.com](https://dashboard.clerk.com) → API keys
- **OpenSky** (OAuth2 client credentials): [opensky-network.org/my-opensky/account](https://opensky-network.org/my-opensky/account) → API Client → Create new client

### Clerk ↔ Supabase native Third-Party Auth (one-time, required)

Until this is done, RLS-protected reads/writes to `user_preferences` from a signed-in user will return empty rows or fail silently. The **old "supabase" JWT template flow was deprecated April 2025** — use the native Third-Party Auth integration below.

1. **Clerk dashboard** → open https://dashboard.clerk.com/setup/supabase → click **Activate Supabase integration**. Clerk will show you a **Clerk domain** (looks like `https://<your-slug>.clerk.accounts.dev` or `https://clerk.<your-domain>`). Copy it.
2. **Supabase dashboard** → *Authentication* → *Sign in / Providers* → *Third Party Auth* → *Add provider* → **Clerk** → paste the Clerk domain → *Save*.
3. That's it — Supabase now verifies Clerk-issued session tokens. In code, `supabaseServer()` (see `apps/web/lib/supabase-server.ts`) uses Supabase's `accessToken` callback to forward the Clerk token on every request, so RLS policies using `auth.jwt() ->> 'sub'` match the Clerk user id automatically.

**Notes:**
- No JWT template needed; no shared secrets between Clerk and Supabase.
- Tokens are refreshed per-request, so there's no stale-token concern.
- If RLS still rejects requests after setup, double-check that the Clerk domain in Supabase matches the environment (dev/prod) your browser is signed into.

## Deploy

- **Vercel**: connect repo, root = `apps/web`, framework = Next.js, add env vars.
- **Railway**: connect repo, root = `apps/worker`, Dockerfile build, add env vars, restart = always.
