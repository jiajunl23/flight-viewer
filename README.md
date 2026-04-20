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

### Clerk ↔ Supabase JWT integration (one-time)

Until this is done, RLS-protected writes to `user_preferences` from a signed-in user will fail.

1. **Clerk dashboard** → *JWT Templates* → *New template* → name it **`supabase`**. Keep the default `sub` claim (it already maps to the Clerk user id). Save.
2. **Supabase dashboard** → *Authentication* → *Sign-in providers* → *Clerk* (third-party auth) → enable, paste the Clerk Frontend API URL (e.g. `https://<subdomain>.clerk.accounts.dev`). Save. RLS policies using `auth.jwt() ->> 'sub'` will now match Clerk user ids.

## Deploy

- **Vercel**: connect repo, root = `apps/web`, framework = Next.js, add env vars.
- **Railway**: connect repo, root = `apps/worker`, Dockerfile build, add env vars, restart = always.
