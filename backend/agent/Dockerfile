FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

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
RUN node_modules/.bin/tsc -p backend/agent/tsconfig.json

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/agent/dist ./
COPY --from=builder /app/backend/shared-infra/dist ./backend/shared-infra/dist
COPY --from=builder /app/backend/shared-infra/package.json ./backend/shared-infra/package.json
COPY --from=builder /app/backend/agent/package.json ./backend/agent/

CMD ["node", "backend/agent/src/index.js"]