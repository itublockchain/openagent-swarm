FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS builder
WORKDIR /app

# root workspace dosyaları
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./

# tüm package.json'lar
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY shared/package.json ./shared/
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

# --shamefully-hoist: tüm paketler root node_modules altına düşer
# bu sayede tsc her paketi bulabilir
RUN pnpm install --frozen-lockfile --shamefully-hoist

# kaynak kod
COPY . .

# workspace symlink'lerini manuel kur
RUN node_modules/.bin/tsc -p backend/agent/tsconfig.json

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/agent/dist ./
COPY --from=builder /app/backend/agent/package.json ./backend/agent/

CMD ["node", "backend/agent/src/index.js"]