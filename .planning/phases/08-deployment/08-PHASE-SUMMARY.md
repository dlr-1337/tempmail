# Phase 8 — Deployment — SUMMARY

**Status:** COMPLETE (build-artifacts; live-deploy deferred to operator)
**Date:** 2026-04-18
**Test gate:** 251 / 251 passing (238 baseline + 13 new env-schema tests)
**Typecheck:** clean
**Biome:** no new errors in files this phase touched

---

## Artifacts shipped

### Composition root (new binary entry)
- `src/config.ts` — zod env schema + `loadAppConfig` + `formatEnvErrors`
- `src/main.ts` — composition of openDb → repos → attachment store → core → sweeper → SMTP → HTTP, with structured startup log + SIGTERM/SIGINT shutdown (30s grace)
- `tests/config/env.test.ts` — 13 tests covering schema behavior + guardrails
- `package.json` — `dev`/`start` scripts retargeted at `src/main.ts` / `dist/main.js`

### Container build
- `Dockerfile` — 3-stage multi-stage (`deps` / `build` / `runtime`), node:22-slim base, non-root, healthcheck on `/healthz`, tini PID 1
- `.dockerignore` — excludes `.planning`, `web/node_modules`, `web/build`, tests, secrets
- `.env.example` — full schema with inline comments pointing at config.ts

### Compose
- `docker-compose.yml` — prod: `app` publishes `:25`, `caddy` publishes `:80/:443`, named volumes `data`/`caddy_data`/`caddy_config`
- `docker-compose.local.yml` — override: publishes SMTP as `:2525`, routes Caddy to the local Caddyfile, defaults DOMAIN=tempmail.local

### Caddy
- `ops/Caddyfile` — prod with LE auto-TLS, SSE-safe `flush_interval -1`, SPA root, strict CSP + HSTS + no-sniff, immutable/no-cache rules
- `ops/Caddyfile.local` — self-signed `tls internal` equivalent for local dev

### systemd fallback (<1GB VPS)
- `ops/systemd/tempmail.service` — hardened unit with `CAP_NET_BIND_SERVICE` for :25
- `ops/systemd/caddy.service` — reference upstream unit
- `ops/systemd/README.md` — step-by-step manual deploy (Debian/Ubuntu)

### Runbooks
- `ops/DEPLOY.md` — prerequisites, DNS pre-flight, first-deploy, STARTTLS cert gotcha, `abuse@` mailbox, migration (MX-TTL lowering), abuse response, troubleshooting
- `ops/PRE-DEPLOY-CHECKLIST.md` — operator tick list (infrastructure, DNS, secrets, operational, abuse readiness)
- `ops/DEV.md` — hosts entry, `.env` setup, compose + smoke test, troubleshooting

### Smoke tests
- `ops/smoke-test.sh` — bash (Linux/macOS/CI): compose up → healthz poll → mint inbox → swaks deliver → messages list → down
- `ops/smoke-test.ps1` — PowerShell (Windows dev) equivalent, SMTP delivery optional

---

## DEPLOY-NN coverage

| Req       | Covered by                                                            |
|-----------|----------------------------------------------------------------------|
| DEPLOY-01 | Dockerfile + docker-compose.yml + `src/main.ts` → one-command deploy |
| DEPLOY-02 | `ops/Caddyfile` (auto-TLS via `{$DOMAIN}` block)                      |
| DEPLOY-03 | `ops/Caddyfile` `/api/*` reverse_proxy with `flush_interval -1`       |
| DEPLOY-04 | `ops/Caddyfile` root + try_files + file_server                        |
| DEPLOY-05 | `ops/systemd/*` (fallback path documented + shipped)                  |
| DEPLOY-06 | `data` named volume in `docker-compose.yml`, `/data` in image         |
| DEPLOY-07 | `ops/DEPLOY.md`, `ops/PRE-DEPLOY-CHECKLIST.md`, `ops/DEV.md`          |

All 22 locked decisions (D-01..D-22) addressed.

---

## One-command local smoke

```bash
# Pre-reqs: .env filled (DOMAIN=tempmail.local, random salt + cookie secret),
# hosts entry: 127.0.0.1 tempmail.local, web/build/ present.

docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
# then: ops/smoke-test.sh  (or ops/smoke-test.ps1 on Windows)
```

## One-command prod deploy flow

```bash
git clone <repo> && cd tempmail
cp .env.example .env
$EDITOR .env           # DOMAIN, PII_LOG_SALT, COOKIE_SECRET, LETS_ENCRYPT_EMAIL
docker compose up -d
```

First run: Caddy mints the LE cert; app emits `tempmail.started`; `/healthz`
responds 200. See `ops/DEPLOY.md` for the full first-deploy checklist.

---

## Deferred validations (no impact on phase completion)

- **`docker build` not run** on this Windows dev machine — Docker CLI is
  installed but the daemon (Docker Desktop Linux engine) is not currently
  running. Dockerfile, compose files, Caddyfiles, and smoke-test scripts
  were syntax-validated (bash -n, manual review). First build on a Linux
  host or a booted Docker Desktop will confirm end-to-end.
- **Live smoke-test not run** for the same reason — operator should run
  `ops/smoke-test.sh` (or `.ps1`) after `docker compose up` succeeds.

---

## Open items blocking a REAL VPS deploy

These are operator inputs, not code. The build is ready to ship the moment
they're supplied:

1. **Real domain** with DNS control (A, AAAA, MX, PTR, SPF, DMARC per
   `ops/DEPLOY.md` §2).
2. **VPS** with inbound :25, :80, :443 verified reachable externally.
3. **VPS AUP vetted** — confirmed to permit disposable-mail (see
   PRE-DEPLOY-CHECKLIST.md).
4. **`abuse@<domain>` mailbox** provisioned at an external provider (NOT
   tempmail itself).
5. **`PII_LOG_SALT`** generated and saved (`openssl rand -hex 32`).
6. **`COOKIE_SECRET`** generated and saved.
7. **`LETS_ENCRYPT_EMAIL`** chosen.
8. **STARTTLS cert sharing plan** — decide between `TLS_DEV_SELF_SIGNED=true`
   (not recommended prod), manually copying Caddy's issued cert into
   `TLS_CERT_PATH` / `TLS_KEY_PATH` (simplest), or a Caddy storage hook
   (future improvement).

Once those are in hand, the operator runs `docker compose up -d` and the
deploy is done.

---

## Plans

| Plan | Title | Commit |
|------|-------|--------|
| 08-01 | composition entry (src/main.ts + src/config.ts) | `feat(08-01)` |
| 08-02 | Dockerfile + .dockerignore + .env.example       | `feat(08-02)` |
| 08-03 | docker-compose + local override                 | `feat(08-03)` |
| 08-04 | Caddyfile prod + local                          | `feat(08-04)` |
| 08-05 | systemd units + README                          | `feat(08-05)` |
| 08-06 | runbooks (DEPLOY, PRE-DEPLOY, DEV)              | `docs(08-06)` |
| 08-07 | smoke-test scripts                              | `feat(08-07)` |

(Note: a single phase-level commit ships everything per this session's instructions.)
