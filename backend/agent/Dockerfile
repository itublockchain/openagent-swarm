# syntax=docker/dockerfile:1.7
# BuildKit features (cache mounts) require a syntax >= 1.4.

# ─── Base: Node + corepack-installed pnpm. Host doesn't need pnpm ──
FROM node:22-alpine AS base
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

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

# BuildKit cache mount → pnpm store survives across builds.
# --shamefully-hoist flattens deps so legacy CommonJS tools resolve.
RUN --mount=type=cache,id=swarm-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --no-frozen-lockfile --shamefully-hoist
RUN test -d node_modules && test -n "$(ls -A node_modules 2>/dev/null)" \
 || (echo "FATAL: pnpm install produced an empty node_modules" >&2 && exit 1)

COPY . .

RUN pnpm --filter @swarm/contracts exec hardhat compile
RUN node_modules/.bin/tsc -p backend/shared-infra/tsconfig.json
RUN node_modules/.bin/tsc -p backend/agent/tsconfig.json

# ─── Runner: minimal image, no pnpm needed at runtime ─────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
ENV NODE_ENV=production

COPY --from=axl-builder /app/axl-node .
COPY backend/agent/start.sh .
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/agent/dist ./
COPY --from=builder /app/backend/shared-infra/dist ./backend/shared-infra/dist
COPY --from=builder /app/backend/shared-infra/package.json ./backend/shared-infra/package.json
COPY --from=builder /app/backend/agent/package.json ./backend/agent/

ENTRYPOINT ["./start.sh"]
