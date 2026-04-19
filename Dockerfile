# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# tempmail production image (Phase 8, D-01..D-04).
#
# Base: node:22-slim (Debian). We chose slim over alpine because better-sqlite3
# prebuilds for musl can lag behind the official Debian builds — this keeps
# image builds reliable at the cost of ~40MB vs alpine.
#
# Layout:
#   deps    — production node_modules + native rebuild (cached unless
#             package.json / package-lock.json change)
#   build   — TypeScript compile (backend dist/) + SvelteKit build (web/build/)
#   runtime — minimal image with node_modules + dist + web/build only
#
# Final image runs as non-root (`node` user, uid 1000), exposes :25 + :8080,
# ships a /healthz healthcheck. Entrypoint: `node --enable-source-maps dist/main.js`.
# -----------------------------------------------------------------------------

ARG NODE_VERSION=22.14.0

# ----------------------------- stage: deps -----------------------------------
FROM node:${NODE_VERSION}-slim AS deps

# build-essential + python3 needed ONLY if a native module lacks a prebuild and
# must compile from source. better-sqlite3 ships prebuilds for node 22 on
# linux/amd64, but we install the toolchain defensively so `npm rebuild` doesn't
# fail cold on a minor version bump.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Install prod deps only. We re-install dev deps in the build stage below.
RUN npm ci --omit=dev \
 && npm rebuild better-sqlite3

# ----------------------------- stage: build ----------------------------------
FROM node:${NODE_VERSION}-slim AS build

WORKDIR /app

# Full dev install for the TS + SvelteKit builds.
COPY package.json package-lock.json ./
RUN npm ci

# Backend compile.
COPY tsconfig.json tsconfig.build.json biome.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Frontend compile (SvelteKit adapter-static emits to web/build/).
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# ----------------------------- stage: runtime --------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# tini provides PID 1 signal forwarding — docker sends SIGTERM to PID 1 and our
# node process is wired to handle it (see src/main.ts installShutdown).
# curl lets the HEALTHCHECK probe /healthz without pulling in extra base layers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    HTTP_HOST=0.0.0.0 \
    SMTP_PORT=25 \
    SMTP_HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Copy runtime artifacts only — no source, no dev deps, no tests.
COPY --from=deps  /app/node_modules  ./node_modules
COPY --from=build /app/dist          ./dist
COPY --from=build /app/web/build     ./web/build
COPY package.json ./

# The non-root `node` user ships with the official base. Give it ownership of
# both /app (read-only at runtime) and /data (the persisted volume mount).
RUN mkdir -p /data \
 && chown -R node:node /app /data

USER node

# The app binds SMTP on :25 from inside the container. Compose maps 25:25 (prod)
# or 2525:25 (local) at the host boundary. HTTP stays internal — Caddy is the
# public entry point.
EXPOSE 25 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${HTTP_PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
