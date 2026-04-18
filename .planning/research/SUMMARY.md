# Project Research Summary

**Project:** Tempmail — self-hosted, anonymous, receive-only disposable email
**Domain:** Public tempmail / self-hosted MX + web UI on a single VPS
**Researched:** 2026-04-18
**Confidence:** HIGH (all four research streams converged on the same core architecture; remaining variance is in deliberately-flagged fork-points)

## Executive Summary

Tempmail is a commodity product category with a narrow, well-documented build pattern: one Node.js process that *is* the MX (not "talks to" Postfix), writing to a single SQLite file and pushing to browsers via SSE. All four research streams (STACK, FEATURES, ARCHITECTURE, PITFALLS) converged on this shape independently — there is no material disagreement on the core stack. The differentiation opportunity is not feature breadth (competitors converged on the same feature set years ago) but **speed, privacy, and operational calm**: zero ads, zero tracking, zero accounts, sub-second push, and an operator burden low enough that one person can run it for years on a ~$5/mo VPS.

The recommended approach is **Node 22 LTS + smtp-server + mailparser + Fastify + better-sqlite3 + Caddy + SvelteKit (static adapter) + Docker Compose**. Both SMTP listener and HTTP server run in the same Node process and share an in-memory `EventEmitter`. Attachments go to a hash-sharded directory on disk, metadata in SQLite, expiry enforced by a `setInterval` sweeper running in the same process.

The critical risks are **not** technical — they are operational and legal-posture concerns specific to the tempmail category: (1) hosting-provider VPS termination following downstream signup-abuse reports; (2) XSS / tracking-pixel exfiltration via rendered HTML email; (3) the realtime race where an email arrives before the browser subscribes; (4) domain listings on disposable-provider blocklists (expected — design domain as rotatable from v1). Missing any of these four at launch means the service is either dead or dangerous within the first week of real traffic.

## Locked Stack Picks (cross-confirmed by all four research streams)

- **Node.js 22 LTS** — runtime, maintenance until April 2027.
- **smtp-server 3.18.x** (Nodemailer) — inbound MX on port 25 as a *library in the same process*, not Postfix.
- **mailparser (`simpleParser`)** — streams raw RFC 5322 → structured `ParsedMail` + attachment streams.
- **Fastify 5.x** — HTTP API + SSE + static serving.
- **better-sqlite3 12.x + SQLite WAL** — `journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON, mmap_size=128MB`. Attachments on disk, metadata in DB.
- **Caddy 2.11.x** — reverse proxy + automatic Let's Encrypt; SSE passthrough with `flush_interval -1`.
- **SvelteKit 2.x (Svelte 5 runes) + adapter-static** — SPA served by Caddy.
- **Docker Compose v2** — single declarative deploy file; systemd fallback documented.
- **In-process `EventEmitter` as pub/sub** — no Redis, no broker.
- **SSE (not WebSocket)** — server→client only.
- **Helpers:** `@fastify/rate-limit`, `@fastify/helmet`, `@fastify/static`, `nanoid` (≥64-bit entropy), `pino`, `DOMPurify`.
- **Dev:** TypeScript, Vitest, Biome, tsx.

**Fork-points (operator may override):** Bun-vs-Node; HTMX-vs-SvelteKit; systemd-vs-Docker on <1 GB VPS.

## Expected Features

**Must have (v1):**
- Zero-signup auto-assigned inbox on first visit (session token in cookie)
- Inbound SMTP reception with correct MX / SPF `-all` / DMARC `p=reject` / PTR / STARTTLS
- Real-time updates via SSE (+ polling fallback)
- Read message (sender, subject, date, text body, HTML body)
- **HTML rendering in sandboxed iframe + DOMPurify + remote-images blocked by default**
- Attachment support (10 MB/file, 25 MB/inbox caps, download-only)
- "New inbox" button, copy-to-clipboard
- Countdown timer + idle-reset + hard ceiling (10 min idle, 1 hr hard)
- Per-IP rate limits on every public endpoint
- Mobile-responsive UI, visible privacy statement

**Should have (v1.x):** QR code, load-images toggle, dark mode, raw-source view, public status page, documented API, no-JS read path, ALTCHA on rate-limit trip.

**Defer (v2+):** public-inbox opt-in mode, multi-domain (data model domain-aware from v1), PWA, inbox export.

**Anti-features (stay out):** accounts, sending, custom addresses, catch-all forwarding, spam filtering, paid tiers, image proxy, push notifications, threading, full-text search, analytics.

## Architecture Approach

One Node.js process binds port 25 (SMTP) and an internal loopback port (HTTP, fronted by Caddy on 443). Both sides share a `better-sqlite3` handle and an `EventEmitter` singleton.

**Inbound flow:** TCP:25 → `smtp-server.onData(stream)` → `simpleParser(stream)` → attachments piped to `/data/attachments/<hash-sharded-path>` → SQLite INSERTs → `bus.emit('inbox:<id>', msg)` → SSE flush.

**Major components:** (1) DNS/MX infra; (2) SMTP ingestion (in-process); (3) Core logic (createInbox, ingestMessage, listMessages, expireInbox); (4) HTTP API + SSE (Fastify); (5) Data store (SQLite WAL + filesystem attachments); (6) Event bus; (7) Expiry sweeper; (8) Reverse proxy (Caddy); (9) Abuse layer (per-IP token-bucket); (10) Frontend (SvelteKit static).

## Top 5 Critical Pitfalls (all launch-blockers)

1. **Signup-fraud abuse → VPS termination.** Mitigation: monitored `abuse@` in WHOIS + footer + security.txt, per-IP rate limits (5/min, 50/hour), per-address blocklist-on-request, 452 temp-fail under load, second VPS provider pre-vetted.
2. **HTML email XSS + tracking-pixel exfiltration.** Mitigation: render in `<iframe sandbox="allow-popups">` (no `allow-scripts`, no `allow-same-origin`), DOMPurify defense-in-depth, CSP `default-src 'none'` inside srcdoc, block remote-content tags by default.
3. **Realtime race: email arrives before SSE subscribed.** Mitigation: address persisted before mint response returns; on SSE subscribe, server replays stored messages before attaching listener; persistent store is source of truth, pub/sub is only a nudge; reconnect via `Last-Event-ID`.
4. **No sweeper / missing size caps → disk fills → silent MX outage.** Mitigation: `setInterval(60s)` sweeper + per-message cap at SMTP DATA (552) + per-inbox cap (452 temp-fail) + disk watermark circuit breaker (80%/90%) + hash-sharded dirs <10k entries + orphan reaper hourly + monitor `df -i` AND `df -h`.
5. **Logging email content / sender / recipient / headers in plaintext.** Mitigation: whitelist-not-blacklist logging (timestamp, sender IP, sender domain, size, SMTP code, hashed recipient local-part); 24–48h rotation; no off-box log aggregators; no third-party frontend trackers.

**Honorable mentions (also launch-critical):** inbox address enumeration (≥64-bit entropy, separate view-token in cookie, address not in URL path); MX DNS misconfig (A not CNAME, SPF `-all`, DMARC `p=reject`); port-25 inbound-vs-outbound confusion (verify with external `nc -vz`); MX TTL too high during migration; DBL listing (expected — don't fight it).

## Implications for Roadmap

### Phase 1: Domain, DNS, and VPS Readiness
**Why first:** Everything downstream is wallpaper without correct MX/DNS and a VPS that accepts inbound :25.
**Delivers:** Domain + VPS + inbound-25 verified + MX→A + PTR + SPF `-all` + DMARC `p=reject` + `abuse@` routed + security.txt + 1800s TTL + `internet.nl/mail/` green.
**Operator inputs:** domain name, VPS provider, VPS specs.

### Phase 2: Data Model and Storage Layer
**Why:** Zero dependencies, unblocks both adapters.
**Delivers:** SQLite schema (inboxes, messages, attachments, abuse_counters) with `domain` as first-class column; WAL PRAGMAs; hash-sharded attachment directory; prepared-statement client wrapper.

### Phase 3: Core Domain Logic
**Why:** Protocol-agnostic; enables parallel SMTP/HTTP work.
**Delivers:** createInbox, ingestMessage, listMessages, address generator (≥64-bit entropy), view-token separation, EventEmitter singleton.

### Phase 4: SMTP Ingestion (in-process)
**Why:** Testable locally with `swaks`/`telnet` without live DNS.
**Delivers:** smtp-server on :25, AUTH disabled, SIZE=10MB advertised, onRcptTo validates against existing inboxes (reject 550 for unknown — no catch-all), streaming `simpleParser`, STARTTLS, PII-whitelist logging, sender-IP rate limit, explicit timeouts.

### Phase 5: HTTP API + SSE + Rate Limiting
**Why:** Parallel with Phase 4 once Phase 3 lands.
**Delivers:** Fastify on loopback; `POST /api/inbox`, `GET /api/inbox/:id`, `GET /api/inbox/:id/messages`, `GET /api/inbox/:id/stream` (SSE, 15s heartbeats), `GET /api/attachments/:id` (streamed, `Content-Disposition: attachment`); view-token bearer auth in HttpOnly SameSite=Lax cookie; @fastify/rate-limit on every route; **replay-on-subscribe** in SSE handler; helmet headers.

### Phase 6: Expiry Sweeper and Abuse Hardening
**Why:** Explicit launch-blocker.
**Delivers:** `setInterval(60s)` sweeper with transactional deletes + attachment unlinks; hourly orphan reaper; disk watermark circuit breaker; per-address blocklist endpoint (localhost-bound); SQLite abuse counters; fail2ban jail templates.

### Phase 7: Frontend (SvelteKit Static)
**Why:** Parallel with Phase 5 once API contract agreed.
**Delivers:** Auto-mint on first visit, session cookie, `EventSource` client, Svelte 5 `$state` reactive inbox, countdown/idle-reset/hard-ceiling UX, copy-to-clipboard, "new inbox" button, mobile-first layout, **HTML in sandboxed iframe + DOMPurify + CSP + remote-content blocked + explicit "Load images" button (no proxy)**, text fallback always available, visible privacy statement.

### Phase 8: Reverse Proxy, TLS, Docker Compose
**Why:** Depends on 4+5+7 working on localhost first.
**Delivers:** Caddyfile with `reverse_proxy /api/*` and `/stream/*` (flush_interval -1), static serving of SvelteKit build, auto Let's Encrypt; docker-compose.yml + volume; single `docker compose up -d` install; systemd fallback documented.

### Phase 9: End-to-End Validation and Launch
**Why:** First real internet exposure; "Looks Done But Isn't" checklist gates this.
**Delivers:** Deploy + external Gmail/Outlook/Proton send tests + `internet.nl/mail/` green + STARTTLS cert validation + rate-limit load test (100 POSTs/10s → 429) + XSS pentest + enumeration pentest + sweeper-deleting verification + PII-log grep + deploy runbook with MX-TTL procedure.

### Ordering Rationale
- Phase 1 first — only phase whose failure is "build whole product, discover nothing works."
- Phases 2→3→{4,5}→6→7→8→9 follow hard dependencies; 4+5 and 5+7 can overlap.
- Abuse-resistance is **in-MVP, not deferred**.
- Frontend sandboxing belongs to the frontend phase, not later hardening — it's a capability choice, not polish.
- Caddy is late because internal flow must work on localhost first.

### Research Flags
**Needs deeper research during planning:** Phase 1 (provider AUP + inbound-25 policy per plan tier), Phase 4 (MIME edge cases, 4xx-vs-5xx SMTP semantics, MTA-STS/TLS-RPT), Phase 7 (DOMPurify + iframe-srcdoc + CSP details; remote-content tag allow/block list; Svelte 5 EventSource reconnection with Last-Event-ID).
**Standard patterns (skip research-phase):** Phases 2, 3, 5, 6, 8.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Context7/official confirms versions; four streams converged independently. |
| Features | HIGH | Cross-verified across 5+ competitors and 2026 comparison articles. |
| Architecture | HIGH | Pattern consistent across reference implementations. |
| Pitfalls | HIGH | Failure modes consistent across operator writeups, academic research, DNSBL policies. |

**Overall confidence:** HIGH.

## Open Questions Pending Operator Input (block Phase 1 execution, not planning)

1. **Domain name** — PROJECT.md marks Pending.
2. **VPS specs confirmation** — assumed 1–2 GB RAM / 1 vCPU; if <1 GB, drop Docker for systemd.
3. **VPS provider identity** — affects AUP review, port-25 policy, abuse-response.
4. **Attachment policy fork** — accept with caps (default) vs reject at SMTP.
5. **Fork: Bun vs Node** — default Node 22.
6. **Fork: SvelteKit vs HTMX** — default SvelteKit.
7. **Retention defaults** — 10 min idle / 1 hr hard agreed across all streams; locked unless overridden.
8. **`abuse@` mailbox destination** — must route to a real inbox the operator reads within hours; cannot be the tempmail itself.

## Launch-Blocker vs Scale-Blocker Summary

**Launch-blockers (must ship in v1):** inbound :25 verified, `abuse@` monitored, correct MX/PTR/SPF=-all/DMARC=reject, catch-all disabled (reject unknown recipients at SMTP), per-message + per-inbox size caps, rate limits on creation + reads, expiry sweeper running, sandboxed-iframe HTML + DOMPurify + remote-content blocked, replay-on-subscribe SSE, address entropy ≥64 bits + view-token in cookie, PII-minimizing logs.

**Scale-blockers (post-launch iterative):** domain DBL listing (expected; data model domain-rotatable from Phase 2, actual rotation v2+), inode exhaustion, MX TTL on migration, multi-domain, SSE `ulimit` tuning.

---

## Source Files

- `.planning/PROJECT.md`
- `.planning/research/STACK.md`
- `.planning/research/FEATURES.md`
- `.planning/research/ARCHITECTURE.md`
- `.planning/research/PITFALLS.md`
