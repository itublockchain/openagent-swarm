# syntax=docker/dockerfile:1.7
# BuildKit features (cache mounts) require a syntax >= 1.4.

# ─── Base: Node + corepack-installed pnpm. Host doesn't need pnpm ──
FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ git \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && pnpm config set store-dir /pnpm-store

# ─── Builder: install workspace deps + Next.js production build ───
FROM base AS builder
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY frontend/package.json ./frontend/
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/

# BuildKit cache mount → pnpm store survives across builds.
RUN --mount=type=cache,id=swarm-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --no-frozen-lockfile --shamefully-hoist
RUN test -d node_modules && test -n "$(ls -A node_modules 2>/dev/null)" \
 || (echo "FATAL: pnpm install produced an empty node_modules" >&2 && exit 1)

COPY . .

# NEXT_PUBLIC_* values are inlined at build time. We deliberately do NOT
# `ENV NEXT_PUBLIC_API_URL=...` here — that would bake `localhost:3001`
# into the bundle even when the deploy targets sporeprotocol.xyz / ngrok.
# Instead, frontend/next.config.ts loads the monorepo root .env via
# @next/env, so whatever is in /app/.env at this point is what lands in
# the bundle. To override at build time, write a fresh .env into the
# build context (compose `build.context: .`) before running `up --build`.

RUN pnpm --filter frontend build

# ─── Runner: serves the prebuilt Next.js bundle ───────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/frontend/package.json ./frontend/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/next.config.ts ./frontend/

EXPOSE 3000
CMD ["pnpm", "--filter", "frontend", "start"]
