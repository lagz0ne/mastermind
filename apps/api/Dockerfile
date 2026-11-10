# Build from repo root: docker build -f apps/api/Dockerfile .
# One image serves the UI (apps/web, bundled in) and the API.
FROM docker.io/oven/bun:1.4.4 AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @mastermind/api build

FROM docker.io/oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./
ARG GIT_SHA=dev
ENV NODE_ENV=production PORT=3000 GIT_SHA=$GIT_SHA
EXPOSE 3000
USER bun
CMD ["bun", "index.js"]
