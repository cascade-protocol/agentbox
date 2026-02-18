FROM node:24-slim AS production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN corepack enable

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/backend/package.json ./packages/backend/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

RUN npm install -g tsx

COPY packages/backend/src ./packages/backend/src
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/backend/drizzle.config.ts ./packages/backend/
COPY packages/backend/drizzle ./packages/backend/drizzle

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

WORKDIR /app/packages/backend

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["tsx", "src/index.ts"]
