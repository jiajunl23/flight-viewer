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

## Deploy

- **Vercel**: connect repo, root = `apps/web`, framework = Next.js, add env vars.
- **Railway**: connect repo, root = `apps/worker`, Dockerfile build, add env vars, restart = always.
