FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY frontend/package.json ./frontend/
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/

RUN pnpm install --no-frozen-lockfile --shamefully-hoist

COPY . .

# Set environment variables for build time
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN pnpm --filter frontend build

FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
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
