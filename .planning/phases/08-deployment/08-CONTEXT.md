# Phase 8: Deployment (Docker Compose + Caddy) - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto — build artifacts only. Real deploy happens when operator supplies domain + VPS.

<domain>
## Phase Boundary

Package the backend + frontend into a one-command deploy. Provide Docker Compose as primary path and systemd units as fallback for <1GB VPS. Caddy handles TLS (Let's Encrypt), SSE passthrough, static SPA serving, and API reverse-proxy. Everything must work from `docker compose up -d` on a fresh Linux VPS with no hand-configuration beyond filling in a `.env` file.

Scope (REQUIREMENTS.md DEPLOY-01..07):
- Single `docker compose up -d` brings up app + Caddy
- Caddyfile auto-TLS (Let's Encrypt) for the web origin
- Caddy reverse-proxies `/api/*` to Node loopback with `flush_interval -1` for SSE
- Caddy serves SvelteKit `web/build/` statically with SPA fallback
- Persistent data in a single named volume `/data` (DB + attachments + caddy state)
- systemd-units fallback documented for <1GB RAM VPS
- Deploy runbook covers MX-TTL pre-lowering before any IP migration

Out of scope: actually running on a VPS (requires operator), securing the admin blocklist socket over a real tunnel (documented but not provisioned), backup/restore (v2).

</domain>

<decisions>
## Implementation Decisions

### Container Build
- **D-01:** Dockerfile multi-stage: `node:22-alpine` builder → `node:22-alpine` runtime. Native module compat: use `node:22-slim` (Debian) instead if `better-sqlite3` prebuilds lack musl support — planner verifies empirically.
- **D-02:** Stages:
  1. `deps`: `npm ci --omit=dev` + `npm rebuild better-sqlite3` (native) — cached layer
  2. `build`: copy full source, `tsc -p tsconfig.build.json` → `dist/`, `cd web && npm ci && npm run build` → `web/build/`
  3. `runtime`: copy `node_modules` from `deps`, `dist/` from `build`, `web/build/` from `build`, non-root user, expose 25 + 8080 (HTTP loopback inside container, Caddy proxies) — healthcheck hits `/healthz`
- **D-03:** Final image <300MB uncompressed. Strip dev deps, no source maps in runtime, no build tools.
- **D-04:** `CMD ["node", "--enable-source-maps", "dist/main.js"]` — production entry. A new `src/main.ts` composes all factories: `openDb`, `createRepos`, `createAttachmentStore`, `createCore`, `createSmtpServer`, `createHttpServer`, `createSweeper`, wires disk-state callbacks, starts listeners.
- **D-05:** Signals: handle `SIGTERM` gracefully — `smtp.close()`, `http.close()`, `sweeper.stop()`, `db.close()`. 30s grace, then force exit.

### docker-compose.yml
- **D-06:** Services:
  - `app`: builds from Dockerfile; restart=unless-stopped; reads env from `.env`; ports NOT exposed to host (internal only)
  - `caddy`: `caddy:2.11-alpine`; ports `:80`, `:443`, `:25` (tempmail routes raw TCP for SMTP? — actually Caddy doesn't proxy SMTP). Revise: Caddy handles :80 + :443 for HTTP; SMTP binds directly from `app` container with `network_mode: host` OR via explicit port mapping `25:25` on app. Use explicit mapping.
- **D-07:** Revised services:
  - `app`: `ports: ["25:25"]` for SMTP inbound; HTTP stays internal `:8080`
  - `caddy`: `ports: ["80:80", "443:443"]`; depends_on app; reverse-proxies to `app:8080`
- **D-08:** Volumes:
  - `data` named volume mounted at `/data` in app (SQLite + attachments)
  - `caddy_data` named volume for Caddy's ACME state + certs
  - `caddy_config` named volume for Caddy runtime config
- **D-09:** `.env.example` shipped with required vars: `DOMAIN`, `LETS_ENCRYPT_EMAIL`, `PII_LOG_SALT`, `IDLE_TTL_MS`, `HARD_TTL_MS`, optional `ADMIN_SOCKET_PATH`.

### Caddyfile
- **D-10:** Single Caddyfile at `ops/Caddyfile`:
  ```
  {$DOMAIN} {
      encode zstd gzip
      # API + SSE
      reverse_proxy /api/* app:8080 {
          flush_interval -1
          transport http {
              read_timeout 0s     # SSE long-lived
              write_timeout 0s
          }
      }
      # Admin endpoint — loopback-only via unix socket (never exposed)
      # (no reverse_proxy block; admin is not reachable through Caddy by design)

      # Healthz for external monitors (optional)
      reverse_proxy /healthz app:8080

      # Static SPA with SPA fallback
      root * /srv/web
      try_files {path} /index.html
      file_server

      # Security headers
      header {
          Strict-Transport-Security "max-age=31536000; includeSubDomains"
          X-Content-Type-Options "nosniff"
          Referrer-Policy "no-referrer"
          Cross-Origin-Opener-Policy "same-origin"
          Cross-Origin-Resource-Policy "same-origin"
          Content-Security-Policy "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src data: blob:; base-uri 'self'; form-action 'none'; frame-ancestors 'none';"
          -Server
      }

      # Cache policy
      @immutable path /_app/immutable/*
      header @immutable Cache-Control "public, max-age=31536000, immutable"
      @html path /*.html
      header @html Cache-Control "no-cache"
  }
  ```
- **D-11:** Caddy auto-issues Let's Encrypt cert from first :443 hit. Requires port 80 reachable for HTTP-01 challenge (standard; document in runbook that VPS firewall must allow :80).

### systemd Fallback (<1GB VPS)
- **D-12:** `ops/systemd/tempmail.service`:
  ```
  [Unit]
  Description=Tempmail
  After=network.target
  [Service]
  User=tempmail
  WorkingDirectory=/opt/tempmail
  ExecStart=/usr/bin/node --enable-source-maps dist/main.js
  Environment=NODE_ENV=production
  EnvironmentFile=/etc/tempmail/env
  AmbientCapabilities=CAP_NET_BIND_SERVICE  # bind :25 without root
  Restart=on-failure
  RestartSec=5s
  [Install]
  WantedBy=multi-user.target
  ```
- **D-13:** `ops/systemd/caddy.service` — standard Caddy systemd unit (reuse upstream) or document `apt install caddy` for Debian/Ubuntu.
- **D-14:** `ops/systemd/README.md` walks through the manual setup:
  1. `apt install nodejs caddy`
  2. Create `tempmail` user + dirs
  3. Build: clone repo, `npm ci`, `npm run build`, `cd web && npm ci && npm run build`
  4. Install systemd units + env file
  5. `systemctl enable --now tempmail caddy`

### Main Composition (new file)
- **D-15:** `src/main.ts`:
  - Loads config from env (using `zod` for validation — already in deps from Phase 5)
  - Opens DB (`openDb`)
  - Creates repos, attachment store, core
  - Instantiates sweeper + wires disk-state getters
  - Starts SMTP (with `isAcceptingMail` from sweeper)
  - Starts HTTP (with `diskState` from sweeper, admin plugin registered with socket path)
  - Starts sweeper intervals
  - Logs structured startup summary (`{event: 'startup', node: version, db: path, domain}`)
  - Wires SIGTERM/SIGINT handlers
- **D-16:** `src/config.ts` — env schema with defaults + validation. Fails fast on missing required vars.

### Deploy Runbook (DEPLOY-07)
- **D-17:** `ops/DEPLOY.md` sections:
  1. Prerequisites (domain with DNS control, VPS with inbound :25 + :80 + :443 allowed, 1GB+ RAM recommended)
  2. Pre-flight DNS (MX = A record, PTR / FCrDNS set, SPF `-all`, DMARC `p=reject`, MX TTL 1800s BEFORE first deploy so future moves are fast)
  3. First deploy: clone repo → fill `.env` → `docker compose up -d` → `docker compose logs caddy` to watch cert issuance → test `curl https://<domain>/healthz`
  4. SMTP smoke test: `swaks --to abc@<domain> --server <domain> --tls-optional`
  5. `abuse@<domain>` mailbox setup (forward to operator's real inbox; recommend a separate provider, NOT your own tempmail)
  6. Migration runbook: how to move to a new IP
     - Lower MX TTL to 60s, wait >1x current TTL
     - Stand up new VPS, deploy, verify
     - Update A record → wait
     - Decommission old VPS
     - Raise TTL back to 1800s
  7. Abuse response: what to do when you get a complaint
  8. Troubleshooting: common failures (port 25 blocked, cert challenge fails, disk full)
- **D-18:** `ops/PRE-DEPLOY-CHECKLIST.md` — tick list operator runs through before first deploy:
  - [ ] Domain + DNS configured
  - [ ] VPS inbound :25/:80/:443 verified externally
  - [ ] VPS AUP allows disposable-mail (or second provider pre-vetted)
  - [ ] `abuse@` mailbox set up at external provider
  - [ ] Strong random `PII_LOG_SALT` generated
  - [ ] `.env` filled

### Local Validation (no real VPS)
- **D-19:** `ops/DEV.md` — how to test locally before VPS:
  - Add `127.0.0.1 tempmail.local` to `/etc/hosts`
  - `docker compose -f docker-compose.yml -f docker-compose.local.yml up` (local override uses self-signed certs, port 2525 SMTP)
  - Send test mail via `swaks --server 127.0.0.1:2525 --to anything@tempmail.local`
  - Open `https://tempmail.local` (accept self-signed warning)
- **D-20:** `docker-compose.local.yml` override: binds 2525 not 25, uses Caddy `tls internal` instead of Let's Encrypt.

### Testing
- **D-21:** `.github/workflows/ci.yml` OR local `ops/smoke-test.sh` that runs:
  - `docker compose build` (no push, just verify)
  - `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`
  - Wait for healthz green
  - `curl -X POST http://localhost/api/inbox` returns 200 with cookie
  - `swaks` delivers a test mail; `curl /api/inbox/:id/messages` shows it
  - `docker compose down`
- **D-22:** Skip CI setup in v1 if GH Actions not requested; ship the smoke-test script standalone.

### Claude's Discretion
- Whether to ship GitHub Actions CI — if yes, include; if no, just `ops/smoke-test.sh`. Default: script only.
- `node:22-alpine` vs `node:22-slim` — pick based on better-sqlite3 prebuild availability. Planner tests both.
- Multi-arch build (amd64 + arm64) — nice to have; default amd64 only for v1.

</decisions>

<specifics>
## Specific Ideas

- `flush_interval -1` on Caddy's reverse_proxy is the documented SSE escape hatch. Without it, events buffer.
- Separate ports for :25 (SMTP direct) and :80/:443 (Caddy) means Caddy isn't in the SMTP path at all — TLS for SMTP is handled by the app itself via STARTTLS with a cert Caddy already minted. Planner decides cert sharing strategy (Caddy can expose certs via its storage API, or we dual-request).
- A common deploy footgun: cert for SMTP STARTTLS must match the MX hostname, not just the web origin. Document in runbook.

</specifics>

<canonical_refs>
## Canonical References

### Requirements
- `.planning/REQUIREMENTS.md` §Deployment (DEPLOY-01..07)
- `.planning/ROADMAP.md` §Phase 8

### Research
- `.planning/research/STACK.md` §Reverse proxy + deploy
- `.planning/research/PITFALLS.md` §MX TTL, §Port 25 provider blocking
- `.planning/research/ARCHITECTURE.md` §Deployment

### Existing artifacts (consume)
- `src/**` backend + tests — build output goes to `dist/`
- `web/build/` — frontend build output from Phase 7
- Phase 4 STARTTLS cert handling
- Phase 5 `/healthz` endpoint

</canonical_refs>

<code_context>
## Existing Code Insights

### New files this phase adds
- `Dockerfile` (root)
- `docker-compose.yml` + `docker-compose.local.yml`
- `.dockerignore`, `.env.example`
- `ops/Caddyfile` (prod) + `ops/Caddyfile.local`
- `ops/systemd/tempmail.service`, `ops/systemd/caddy.service`, `ops/systemd/README.md`
- `ops/DEPLOY.md`, `ops/PRE-DEPLOY-CHECKLIST.md`, `ops/DEV.md`
- `ops/smoke-test.sh`
- `src/main.ts`, `src/config.ts`

### Gotchas
- `better-sqlite3` on Alpine (musl) sometimes lacks prebuilds — always budget for `npm rebuild` in the builder stage.
- Caddy :80 must be open for HTTP-01 ACME challenge — document.
- SMTP STARTTLS cert domain ≠ web origin is common gotcha — clarify in runbook.
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` in systemd unit lets non-root bind :25 (cleaner than setcap on the binary).
- `.env` must NEVER be committed — `.gitignore` must have `.env` but NOT `.env.example`.

</code_context>

<deferred>
## Deferred Ideas
- Backup/restore tooling (v2 — periodic sqlite .backup + rsync)
- Prometheus metrics scrape endpoint (v2)
- Multi-arch container build (v2)
- Docker Swarm / k8s manifests (not a goal)
- Automated DNS provisioning (Terraform/Pulumi) — v2
</deferred>
