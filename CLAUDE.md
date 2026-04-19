<!-- GSD:project-start source:PROJECT.md -->
## Project

**Tempmail**

Public, anonymous disposable email service — anyone visits the site, gets a temporary inbox, receives emails, and can throw it away. Self-hosted on the user's own VPS and domain. No accounts, no tracking, no friction.

**Core Value:** **Visit → get inbox → receive email — in under 3 seconds, with zero signup.**

If everything else fails, this single flow must work reliably and feel instant.

### Constraints

- **Tech stack**: Free / OSS only — no paid SaaS, no managed databases, no cloud relays
- **Hosting**: Single VPS owned by user — assume modest specs (~1–2 GB RAM, 1 vCPU baseline)
- **Domain**: User-owned domain with full DNS control (MX records required)
- **Operator burden**: Solo maintainer — pick boring, well-documented tools; minimize moving parts
- **Privacy**: No user accounts means no personal data collection — keep it that way (no analytics SDKs, no telemetry)
- **Cost**: $0 monthly recurring beyond VPS + domain renewal
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## TL;DR — The Prescribed Stack
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Node.js** | 22 LTS (22.22.0+) | JS runtime | Active LTS through Oct 2025, maintenance until April 2027. Mature ecosystem for every piece of this stack — SMTP, HTTP, SQLite. Single well-known runtime solo-maintainers understand. |
| **smtp-server** | 3.18.x | Inbound MX endpoint (port 25) | Official Nodemailer package, actively maintained (latest publish April 2026), ~177 dependents. Lightweight *library* — embeds in the same process as the HTTP API, so delivery → database → SSE push is an in-memory function call, not cross-process. Used by 10minutemail-class services. |
| **mailparser** | 3.x | Parse MIME → structured object | Companion to smtp-server from Nodemailer. `simpleParser` is one async call to get `{from, to, subject, text, html, attachments[]}`. Streams large messages. Industry standard in Node. |
| **Fastify** | 5.8.x | HTTP API + SSE + static files | Fastest mature Node.js HTTP framework (~2-3x Express). Low memory footprint suits 1-2GB VPS. v5 targets Node 20+, drops deprecated cruft. Battle-tested ecosystem (JSON schema, rate limiting, CORS, static) vs Hono whose Node.js adapter has known overhead. |
| **better-sqlite3** | 12.9.x | Embedded database | Fully synchronous, fastest Node SQLite driver. Zero config, zero ops, zero network. WAL mode + 5s `busy_timeout` handles hundreds of writes/sec — far more than a public tempmail will receive. Prebuilt binaries for Node 22. |
| **SQLite** | 3.45+ (via better-sqlite3) | Storage engine | Single file on disk. Auto-expire is a cron-style `DELETE WHERE created_at < ?` — trivial. Survives VPS reboots. Backups = `cp`. No separate daemon competing for the VPS's 1-2GB RAM. |
| **Caddy** | 2.11.x (latest 2.10+ fine) | Reverse proxy + TLS | Automatic Let's Encrypt HTTPS with a 3-line Caddyfile. Renewals handled silently. SSE passthrough works out of the box (no buffering gotchas like nginx). Solo-maintainer-optimized: far fewer foot-guns than nginx + Certbot. |
| **Docker Compose** | v2 (Compose Spec) | Deployment artifact | PROJECT.md explicitly lists "Docker Compose or single binary" — Compose wins because Caddy + the Node app + a persistent volume for SQLite is the bulk of the setup, and Compose keeps ports, volumes, and restart policy in one declarative file. One `docker compose up -d` install, as promised in requirements. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **@fastify/rate-limit** | 10.x | Per-IP rate limiting on HTTP | MANDATORY — PROJECT.md lists "per-IP rate limiting on address creation" as an active requirement. Plugin handles the whole concern declaratively. |
| **@fastify/static** | 8.x | Serve built frontend | Serve `dist/` from the same process. Avoids needing a second Caddy file-server vhost. |
| **@fastify/helmet** | 12.x | Security headers | Public-facing from day one. CSP, HSTS, X-Frame-Options by default. |
| **nanoid** | 5.x | Random address local-part generation | 8-10 char URL-safe IDs. Cryptographically strong, ~120 bits entropy at length 10, collision probability negligible for a service with <60min retention. |
| **SvelteKit** | 2.x (Svelte 5 runes) | Frontend framework | Compiles to tiny bundles (~3-10KB for simple apps, 1.6KB runtime) — critical on a 1-2GB VPS serving uncached first-loads. Native `EventSource` binding via runes reads cleanly. Static adapter produces a plain `dist/` Fastify serves. Works offline of a Node SSR server — no extra process. |
| **EventSource / SSE** | Built-in to browsers | Real-time inbox push | Browser-native `new EventSource('/api/inbox/:id/stream')`. Auto-reconnect. No library needed client-side. Fastify sends via `reply.raw.write('data: ...\n\n')`. |
| **pino** | 9.x | Structured logging | Fastify's default logger. JSON logs that ship straight to `journalctl` via Docker. Essential for fail2ban log-scanning. |
| **dotenv** | 16.x (or Node 22 native `--env-file`) | Config loading | `.env` for domain name, retention minutes, rate limits. Node 22 has native `--env-file` — prefer it to cut a dep. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| **TypeScript** | 5.6+ | Type-safety without a runtime dep (compiled away). Modest learning cost, huge correctness gain for MIME/attachment handling edge cases. Use `tsx` in dev, `tsc` for build. |
| **Vitest** | 2.x | Test runner | Native ESM, fast, good ergonomics. Unit-test parsers and DB layer; integration-test SMTP with `smtp-server`'s own test harness sending fake messages to your listener. |
| **Biome** | 1.9+ | Lint + format | Single binary, no ESLint+Prettier combo. Zero config keeps solo-maintainer attention on features, not tooling. |
| **mailhog / maildev** | latest | Local SMTP sink for manual tests | Docker-run alongside dev to hand-craft weird MIME and see how your parser copes. |
## Installation
# Runtime deps (production)
# Frontend (separate package.json in /web)
# Dev deps
- `node:22-alpine` for the app (small image, musl libc — verify better-sqlite3 prebuild ships for musl; if not, use `node:22-slim`)
- `caddy:2-alpine` for the reverse proxy
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **smtp-server (library, in-process)** | **Haraka** (standalone SMTP server, plugins) | If you ever need >1000 concurrent SMTP connections or want a pluggable anti-spam pipeline. Haraka is overkill for a personal tempmail — it adds a second process, config-file complexity, and its own plugin ecosystem. smtp-server wins on solo-maintainer simplicity. |
| **smtp-server (library, in-process)** | **Postfix + LMTP → Node** (what Leopixel1/temp-mail and elbunuelo/tempmail do) | If you want a battle-hardened MTA doing PTR/SPF checks before your Node code sees the message. Tradeoff: adds Postfix's config surface, a second package to update, and LMTP plumbing. For 1-2GB VPS + solo maintainer, the Node smtp-server handles the load and SPF/DKIM validation can be done in-process with `mailauth`. |
| **Fastify** | **Hono** | Multi-runtime deployment (Cloudflare Workers, Deno, Bun edge). On Node specifically, Hono uses an adapter that *adds* overhead — the opposite of the benchmark headlines. Stick with Fastify on Node. |
| **Fastify** | **Express** | Only if the team already knows Express and can't learn Fastify. Fastify has better perf, JSON schema, and plugin encapsulation. Express is fine but objectively slower and noisier. |
| **Fastify** | **Bun + Hono** | If the operator is comfortable with Bun. Bun's built-in `bun:sqlite` is ~3-6x faster than better-sqlite3, and the single-binary story is genuinely simpler. **This is a legitimate fork-point** (see below). Rejected as the default because Bun's SMTP library story (`smtp-server` works but isn't Bun-native) and Docker image ecosystem are still thinner than Node's. |
| **better-sqlite3** | **node:sqlite** (Node 22 built-in) | When it exits experimental status. Currently requires `--experimental-sqlite` and the API is marked unstable. Revisit in a year. |
| **better-sqlite3** | **PostgreSQL** | Multi-writer workloads, replication, full-text search at scale. For a 1-2GB VPS with <10 writes/sec (a public tempmail sees bursts but rarely sustained load), Postgres wastes ~200-400 MB of RAM on a dedicated daemon for zero benefit. SQLite's single-writer limit is a non-issue here. |
| **SQLite (better-sqlite3)** | **LMDB / Bun KV** | If you hate SQL. LMDB is faster for pure K/V, but loses you ad-hoc queries for the admin endpoint (list active inboxes, count messages) and the SQL migration path. Not worth the savings. |
| **SSE** | **WebSocket (ws / socket.io)** | When the client needs to *send* data on the same channel. Tempmail is strictly server→client (new message arrived). SSE wins on simplicity, proxy compatibility, built-in reconnect, no extra dep. |
| **SSE** | **Long polling** | Only as a fallback for clients behind aggressive proxies that break SSE. EventSource is supported in all evergreen browsers — don't bother. |
| **Caddy** | **nginx + certbot** | Corporate environment with existing nginx ops tooling. For a solo maintainer, Caddy's 3-line Caddyfile + automatic renewal eliminates the single biggest source of "site down on Saturday" incidents. |
| **Caddy** | **Traefik** | Multi-container dynamic service discovery. Overkill for one app + one reverse proxy. Caddy's static config is easier to reason about. |
| **Docker Compose** | **systemd units + tarball deploy** | If the operator is confident with systemd and wants to squeeze every MB out of the 1-2GB VPS (saves ~50-100 MB of Docker daemon RAM). Legitimate fork-point: a solo maintainer comfortable with systemd can run the Node app as a unit, Caddy as a unit, skip Docker entirely. **Default recommendation stays Compose** because it matches the install-in-one-command promise in PROJECT.md. |
| **SvelteKit + Svelte 5** | **HTMX + Alpine.js (server-rendered)** | If you want *zero* build step and already have a server templating story. HTMX works well for inboxes and has a `hx-sse` extension. **Legitimate fork-point for operators who prefer server-rendered templates.** Default is SvelteKit because the requirement "see incoming emails in real time" maps cleanly to reactive `$state` + `EventSource` and the mobile-responsive UI is easier to build/test as an SPA. |
| **SvelteKit** | **React / Next.js** | Only if the developer already knows it well. React's baseline bundle (~40KB gzip) is 5-10x Svelte's for a UI this simple. No feature of React justifies the size on a 1-2GB VPS serving first-time visitors. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Postfix + Dovecot full mail stack** | Designed to *deliver to mailboxes* for long-term storage. Tempmail has no mailboxes — messages live 10-60 min. All that IMAP/LMTP/maildir machinery is wasted RAM and config surface. | `smtp-server` npm package, store straight in SQLite. |
| **Redis for pub/sub between SMTP and HTTP processes** | Only needed if SMTP and HTTP run in separate processes. By keeping both in one Node process, Redis adds a daemon, a network hop, and ~50MB RAM for zero gain. | In-process `EventEmitter` — emit on ingestion, listen in the SSE route handler. |
| **Postgres** | Overkill for <1GB/day writes, no multi-writer need. Costs 200-400 MB RAM that a 1-2GB VPS cannot spare. Backups, upgrades, WAL archiving all become ops tasks for a solo maintainer. | SQLite with WAL mode. |
| **BullMQ / background job queues** | Retention cleanup is one `setInterval` + one DELETE statement. A job queue is engineering theater at this scale. | `setInterval(() => db.prepare('DELETE FROM inboxes WHERE expires_at < ?').run(Date.now()), 60_000)`. |
| **Nodemailer (for sending)** | The project is explicitly receive-only. Installing a sending library is attack surface (if compromised, the service becomes a spam relay). | Don't install it at all. |
| **Paid SMTP relay APIs (Mailgun, SendGrid inbound)** | Violates the $0 monthly cost constraint from PROJECT.md. Also means the user's domain MX points at a third party — they no longer "own" inbound mail. | Self-hosted smtp-server on the user's VPS, MX record points at VPS. |
| **Cloudflare Email Routing** | Technically free, but requires routing all mail through Cloudflare infrastructure — a third-party dependency and privacy concern that contradicts the "anonymous, no tracking" goal. | Direct MX → VPS. |
| **HTMX `hx-ws` WebSocket extension** | WebSockets for one-directional server push is overkill; `hx-sse` exists and fits perfectly. | `hx-sse` extension if going HTMX route, otherwise native `EventSource`. |
| **Clustering / PM2 / Node cluster mode** | On a 1-vCPU VPS, clustering wastes memory duplicating the Node heap. One worker is correct. | Single process. Use Docker's `restart: unless-stopped` for crash recovery. |
| **Express with Express-based middleware** | Fine but slower and with weaker schema validation than Fastify. No reason to choose Express for a greenfield project in 2026. | Fastify. |
| **An ORM (Prisma, Drizzle, TypeORM) heavy-handedly** | Prisma generates a 50MB+ client and has a separate query engine process. For a 3-table schema, this is absurd overhead. | Drizzle ORM (lightweight, compile-time) is fine *if* you want types on queries. Raw better-sqlite3 prepared statements are perfectly acceptable and faster. |
| **SvelteKit SSR adapter (Node adapter) for the frontend** | Adds a second Node process (SvelteKit SSR server) next to the API. The tempmail UI has no SEO needs — it's an app behind an address. | `@sveltejs/adapter-static` — produces plain HTML/JS/CSS served by Fastify. |
## Stack Patterns by Variant
- Swap Node → Bun, Fastify → Hono, better-sqlite3 → `bun:sqlite`
- Single binary deploy is genuinely simpler than npm + node_modules
- Memory usage drops ~30%
- Cost: Bun's SMTP ecosystem is thinner, some npm native modules still have rough edges under Bun
- **Recommendation: stick with Node 22 for the first release; revisit after v1 ships**
- Swap SvelteKit → HTMX + Alpine.js + server-rendered templates (e.g. `@fastify/view` with Handlebars or EJS)
- Use `hx-sse` extension for real-time inbox updates
- Total JS on the wire drops to ~29 KB (htmx + alpine)
- Cost: mobile-responsive polish is harder without a component framework
- **Legitimate fork-point — operator preference**
- Drop Docker, run Node + Caddy via systemd units
- Saves ~80-150 MB (Docker daemon + overhead)
- Cost: deploy story is no longer "one command"
- **Revisit after measuring actual RSS in production**
- Introduce Haraka as a front MTA, have it LMTP-forward to the Node app
- Adds resilience (Haraka queues on disk, survives Node crashes)
- Not needed for day-one launch — premature complexity
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Node.js 22.x | better-sqlite3 12.x | Prebuilt binaries ship for Node 22 (N-API). Node 24 prebuilds have been missing recently per upstream issues — another reason to stay on 22 LTS. |
| Node.js 22.x | Fastify 5.x | Fastify v5 requires Node 20+; 22 is the sweet spot. |
| Node.js 22.x | smtp-server 3.x | Works on Node 16+. Fine. |
| better-sqlite3 12.x | Alpine Linux (musl) | Verify musl prebuilds are published for the specific 12.x version before choosing `node:22-alpine`. If not, fall back to `node:22-slim` (Debian, glibc). |
| SvelteKit 2.x | adapter-static 3.x | Required for the static-output pattern. `adapter-node` is a trap for this project. |
| Caddy 2.11 | Docker image `caddy:2-alpine` | Works. Caddyfile is version-stable; 2.10+ brings ECH/post-quantum but neither matters here. |
| SQLite 3.45+ | WAL mode + `busy_timeout=5000` | Essential config — without busy_timeout, concurrent writes fail instantly with SQLITE_BUSY. |
## Operational Notes (Critical for 1-2GB VPS)
- **Run Node with `--max-old-space-size=768`** on a 1GB VPS to leave headroom for Caddy (~30MB) + kernel.
- **SQLite PRAGMAs on startup**: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `temp_store=MEMORY`, `mmap_size=134217728` (128MB). These are the well-established defaults for a WAL-mode SQLite on a modest server.
- **Retention cleanup**: single `setInterval` every 60s running `DELETE FROM messages WHERE inbox_id IN (SELECT id FROM inboxes WHERE last_activity_at < ?)` then `DELETE FROM inboxes WHERE ...`. Run `PRAGMA wal_checkpoint(TRUNCATE)` daily to keep the WAL file small.
- **fail2ban**: point it at Pino's JSON logs in `/var/log/tempmail/` for per-IP SMTP-abuse and HTTP-abuse banning. PROJECT.md says "abuse-resistance matters" and a 10-line jail config buys you a lot.
- **Attachment storage**: store *inline* in SQLite as BLOB up to ~1 MB; beyond that, reject or store on disk in `/data/attachments/<inbox>/<msg>/`. Given a 10-minute retention, staying in SQLite is simpler unless someone mails a 20MB PDF.
## Sources
- [Fastify v5 official release announcement](https://openjsf.org/blog/fastifys-growth-and-success) — v5.8.4 current, Node 20+ required
- [Node.js 22 LTS release notes](https://nodejs.org/en/blog/release/v22.22.0) — 22.22.0 current stable, LTS until April 2027
- [better-sqlite3 npm page](https://www.npmjs.com/package/better-sqlite3) — 12.9.0 current, synchronous API
- [smtp-server npm page](https://www.npmjs.com/package/smtp-server) — 3.18.3 current, maintained by Nodemailer team
- [Haraka GitHub](https://github.com/haraka/Haraka) — 3.1.5 current (confirms recent activity; we chose *not* to use it, but evidence is current)
- [Caddy 2.10+ release](https://www.x-cmd.com/blog/250423/) — 2.10 released Apr 2025, 2.11 current
- [mailparser Nodemailer docs](https://nodemailer.com/extras/mailparser) — streaming + simpleParser API documented
- [Svelte 5 runes release](https://svelte.dev/blog/runes) — Svelte 5 stable with runes, ~1.6KB runtime gzipped
- [SQLite WAL documentation](https://sqlite.org/wal.html) — WAL mode, busy_timeout behavior
- [Caddy vs nginx comparison for solo maintainers](https://koder.ai/blog/nginx-vs-caddy)
- [SSE vs WebSocket guidance for 2025](https://dev.to/haraf/server-sent-events-sse-vs-websockets-vs-long-polling-whats-best-in-2025-5ep8)
- [Fastify vs Hono on Node.js](https://betterstack.com/community/guides/scaling-nodejs/hono-vs-fastify/) — confirms Hono adapter overhead on Node
- [Bun:sqlite benchmark vs better-sqlite3](https://github.com/WiseLibs/better-sqlite3/discussions/1057) — 3-6x faster, Bun-only
- [SQLite WAL concurrency tuning](https://dev.to/software_mvp-factory/sqlite-wal-mode-and-connection-strategies-for-high-throughput-mobile-apps-beyond-the-basics-eh0) — busy_timeout importance
- [Leopixel1/temp-mail](https://github.com/Leopixel1/temp-mail) — Postfix catch-all + Node backend pattern (we diverge: no Postfix)
- [elbunuelo/tempmail](https://github.com/elbunuelo/tempmail) — similar Postfix pattern
- better-sqlite3 musl prebuild availability for Node 22 on Alpine — verify at install time; fall back to `node:22-slim` (Debian) if broken
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
