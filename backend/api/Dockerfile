FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

# AXL Builder stage
FROM golang:1.25-alpine AS axl-builder
WORKDIR /app
COPY axl/go.mod axl/go.sum ./
RUN go mod download
COPY axl/ ./
RUN go build -o axl-node ./cmd/node/

FROM base AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

RUN pnpm install --no-frozen-lockfile --shamefully-hoist

COPY . .

RUN node_modules/.bin/tsc -p backend/shared-infra/tsconfig.json
RUN node_modules/.bin/tsc -p backend/api/tsconfig.json

FROM node:22-alpine AS runner
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
ENV NODE_ENV=production

# Copy AXL node
COPY --from=axl-builder /app/axl-node .
# Copy Startup script
COPY backend/api/start.sh .
RUN chmod +x start.sh

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/api/dist ./
COPY --from=builder /app/backend/shared-infra/dist ./backend/shared-infra/dist
COPY --from=builder /app/backend/shared-infra/package.json ./backend/shared-infra/package.json
COPY --from=builder /app/backend/api/package.json ./backend/api/

EXPOSE 3001
ENTRYPOINT ["./start.sh"]