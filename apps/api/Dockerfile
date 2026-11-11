# Build from repo root: docker build -f apps/api/Dockerfile .
# One image serves the UI (apps/web, bundled in) and the API. State lives on NATS.
FROM docker.io/oven/bun:1.4.4 AS build
WORKDIR /repo
COPY . .
# The runner binaries (served at /download/mastermind-runner) carry GIT_SHA as their version.
ARG GIT_SHA=dev
ARG RUNNER_TARGETS=all
RUN bun install --frozen-lockfile \
 && GIT_SHA=$GIT_SHA RUNNER_TARGETS=$RUNNER_TARGETS bun run --filter @mastermind/api build

FROM docker.io/oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./
ARG GIT_SHA=dev
ENV NODE_ENV=production PORT=3000 GIT_SHA=$GIT_SHA
EXPOSE 3000
# JetStream backups (BACKUP_URL=file:///backups/nats): a new volume mounted here takes this owner.
RUN mkdir -p /backups && chown bun:bun /backups
USER bun
# Unhealthy = /api/health is not 200 (ok=false: nats or work down) on 4 checks in a row,
# so about 60 s; the orchestrator then replaces the container (mm-210.38). Failures in
# the first 90 s (connecting to NATS, opening the store) do not count.
HEALTHCHECK --interval=15s --timeout=10s --start-period=90s --retries=4 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(8000) }); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "index.js"]
