FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- Install full workspace deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

# ---- Build shared + worker ----
FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter shared build
RUN pnpm --filter worker build

# ---- Runtime image ----
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Copy only what's needed to run. pnpm workspaces rely on node_modules
# symlinks in every workspace package (shared + worker) to resolve deps
# like zod via `.pnpm/` store, so we MUST copy packages/shared/node_modules
# and apps/worker/node_modules, not just the hoisted root.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist

WORKDIR /repo/apps/worker
CMD ["node", "dist/index.js"]
