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

# ════════════════════════════════════════════════════════════════
# BAKED-IN PUBLIC CONFIG — fresh-checkout works without a local .env.
# These get statically inlined into the client bundle at `next build`,
# so the values are PUBLIC by design (anyone with the served JS can read
# them). Override at deploy time by passing `--build-arg` or by setting
# them on the compose `frontend.environment:` block (compose env wins
# over Dockerfile ENV during build).
# ════════════════════════════════════════════════════════════════
ENV NEXT_PUBLIC_API_URL=http://localhost:3001 \
    NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws \
    NEXT_PUBLIC_REOWN_PROJECT_ID=400c6d7d206f4776802e3b3a6d967b5f \
    NEXT_PUBLIC_USDC_ADDRESS=0xcbF0cC20e36daf2689EA61632dA68B7fe9C22342 \
    NEXT_PUBLIC_ESCROW_ADDRESS=0x94fb6508EcfDa3FE6D2A8ed6c8d01fb81a237d48 \
    NEXT_PUBLIC_TREASURY_ADDRESS=0xcAa459ec1dF4004CeBA5712A6A01F013d9B00a74

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
