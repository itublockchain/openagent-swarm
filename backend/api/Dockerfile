# syntax=docker/dockerfile:1.7
# BuildKit features (cache mounts) require a syntax >= 1.4.

# ─── Base: Node + corepack-installed pnpm. Host doesn't need pnpm ──
FROM node:22-alpine AS base
# python3/make/g++/git: native deps for better-sqlite3 and friends.
# git: occasionally pulled by npm subdeps that ship as git+https://… refs.
RUN apk add --no-cache python3 make g++ git \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && pnpm config set store-dir /pnpm-store

# ─── AXL builder: Go binary used by the agent's start.sh ──────────
FROM golang:1.25-alpine AS axl-builder
WORKDIR /app
COPY axl/go.mod axl/go.sum ./
RUN go mod download
COPY axl/ ./
RUN go build -o axl-node ./cmd/node/

# ─── Builder: install workspace deps + compile TS ─────────────────
FROM base AS builder
WORKDIR /app

# Manifests first — Docker reuses the cached install layer until the
# lockfile or any package.json changes. Source code (COPY . .) lands
# in a later layer so editing TS files doesn't bust the install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

# BuildKit cache mount so the pnpm content store survives across builds —
# zero-copy reuses for unchanged deps, ~10x faster reruns.
# --shamefully-hoist flattens to /app/node_modules so CommonJS tools
# (hardhat, typechain) resolve modules via the standard Node lookup.
# --no-frozen-lockfile lets a still-valid lockfile work while tolerating
# drift from a recent dep change that wasn't committed; switch to
# --frozen-lockfile in CI for strict determinism.
RUN --mount=type=cache,id=swarm-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --no-frozen-lockfile --shamefully-hoist
# Hard sanity check — pnpm install must have populated node_modules.
# A silent no-op (corepack failure, lockfile corruption) used to slip
# through and only surface as "Cannot find module 'fastify'" at runtime.
RUN test -d node_modules && test -n "$(ls -A node_modules 2>/dev/null)" \
 || (echo "FATAL: pnpm install produced an empty node_modules" >&2 && exit 1)

COPY . .

RUN pnpm --filter @swarm/contracts exec hardhat compile
RUN node_modules/.bin/tsc -p backend/shared-infra/tsconfig.json
RUN node_modules/.bin/tsc -p backend/api/tsconfig.json

# ─── Runner: minimal image, no pnpm needed at runtime ─────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
ENV NODE_ENV=production

# AXL node binary + startup script.
COPY --from=axl-builder /app/axl-node .
COPY backend/api/start.sh .
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/api/dist ./
COPY --from=builder /app/backend/shared-infra/dist ./backend/shared-infra/dist
COPY --from=builder /app/backend/shared-infra/package.json ./backend/shared-infra/package.json
COPY --from=builder /app/backend/api/package.json ./backend/api/

EXPOSE 3001
ENTRYPOINT ["./start.sh"]
