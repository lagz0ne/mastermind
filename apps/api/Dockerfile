# Build from repo root: docker build -f apps/api/Dockerfile .
# One image serves the UI (apps/web, bundled in) and the API, and runs bd serve
# (the beads write path) as a child process on loopback.
FROM docker.io/oven/bun:1.4.4 AS build
WORKDIR /repo
COPY . .
# The runner binaries (served at /download/mastermind-runner) carry GIT_SHA as their version.
ARG GIT_SHA=dev
ARG RUNNER_TARGETS=all
RUN bun install --frozen-lockfile \
 && GIT_SHA=$GIT_SHA RUNNER_TARGETS=$RUNNER_TARGETS bun run --filter @mastermind/api build

# bd, pinned by version and checksum (checksums.txt of the GitHub release).
FROM docker.io/oven/bun:1.4.4 AS bd
ARG BD_VERSION=1.3.4
ARG TARGETARCH=amd64
WORKDIR /bd
RUN case "$TARGETARCH" in \
      amd64) sum=175c26904bde3ff9168d2282ff6b56f17b17f60c22fa5acb3dacc9fb3465303a ;; \
      arm64) sum=f4ee6eb3ec79bb2d7eb9d717c73efbcb6fa763cc70f726b4d055b72afdd68ad5 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun -e "const r = await fetch('https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_${TARGETARCH}.tar.gz'); if (!r.ok) throw new Error(r.statusText); await Bun.write('bd.tgz', r)" \
 && echo "$sum  bd.tgz" | sha256sum -c - \
 && tar xzf bd.tgz bd && ./bd version

FROM docker.io/oven/bun:1.4.4-slim
# bd init (first boot only, creates the beads database) shells out to git.
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./
COPY --from=bd /bd/bd /usr/local/bin/bd
ARG GIT_SHA=dev
# DO_NOT_TRACK: bd sends anonymous usage metrics unless told not to.
ENV NODE_ENV=production PORT=3000 GIT_SHA=$GIT_SHA BD_BIN=/usr/local/bin/bd DO_NOT_TRACK=1
EXPOSE 3000
USER bun
CMD ["bun", "index.js"]
