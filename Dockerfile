# syntax=docker/dockerfile:1
# Sloppanizer API: one container, data on the /data volume.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @organizer/server...
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    SLOPPANIZER_HOST=0.0.0.0 \
    SLOPPANIZER_PORT=4711 \
    SLOPPANIZER_DATA_DIR=/data
LABEL org.opencontainers.image.source="https://github.com/omeldar/sloppanizer" \
      org.opencontainers.image.title="sloppanizer"
COPY --from=deps /app /app
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
WORKDIR /app/apps/server
EXPOSE 4711
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4711/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/index.ts"]
