---
phase: 08
plan: 08-02
title: Dockerfile multi-stage + .dockerignore + .env.example
covers: DEPLOY-01, D-01, D-02, D-03, D-09
---

# Goal

One-shot reproducible container build. Multi-stage Dockerfile, `.dockerignore`, and `.env.example`.

## Must-have checklist

- [ ] `Dockerfile` multi-stage (deps, build, runtime); runtime < 300MB
- [ ] Uses `node:22-slim` (Debian) — better-sqlite3 prebuild stability on alpine/musl is flaky
- [ ] `npm rebuild better-sqlite3` in deps stage
- [ ] Builds backend `dist/` via `tsc -p tsconfig.build.json`
- [ ] Builds frontend `web/build/` via `npm ci && npm run build`
- [ ] Runtime user: non-root (`node` user from base image, uid 1000)
- [ ] Exposes `25` (SMTP) + `8080` (HTTP loopback inside compose network)
- [ ] Healthcheck hits `GET /healthz` on 8080
- [ ] CMD = `["node","--enable-source-maps","dist/main.js"]`
- [ ] `.dockerignore` excludes `.planning`, `node_modules`, `.git`, `tests`, `data`, `web/node_modules`, `web/.svelte-kit`, `*.md` (except LICENSE)
- [ ] `.env.example` lists all required vars from config.ts with inline comments

## Tasks

1. Write `Dockerfile` with deps / build / runtime stages.
2. Write `.dockerignore`.
3. Write `.env.example`.

<automated>
# Docker may be unavailable on this Windows dev machine — build is optional.
docker --version || echo "docker cli absent; config-only validation"
# If available: docker build -t tempmail:local .
</automated>

## Commit

`feat(08-02): Dockerfile multi-stage + dockerignore + env example`
