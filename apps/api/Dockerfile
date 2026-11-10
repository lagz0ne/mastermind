# Build from repo root: docker build -f apps/api/Dockerfile .
FROM docker.io/oven/bun:1.4.4 AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @mastermind/api build

FROM docker.io/oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "index.js"]
