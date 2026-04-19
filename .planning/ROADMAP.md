# Roadmap: Tempmail

**Created:** 2026-04-18
**Granularity:** deep
**Parallelization:** enabled
**Core Value:** Visit → get inbox → receive email — in under 3 seconds, with zero signup.

## Overview

Nine-phase roadmap derived from the 76 v1 requirements in REQUIREMENTS.md and the phase ordering proposed by research/SUMMARY.md. Structure follows the hard dependency chain: **Infra/DNS → Storage → Core → {SMTP ∥ HTTP+SSE} → Sweeper/Abuse → Frontend → Deploy → Validation/Launch**.

Phase split is intentionally granular (`granularity=deep`): each phase delivers one coherent, independently-verifiable capability so the executor can land small, reversible changes and the verifier can gate on observable behavior.

### Parallel Windows

The dependency graph allows two parallel execution windows once upstream phases land:

- **Window A (SMTP ∥ HTTP/SSE):** Phase 4 and Phase 5 both depend only on Phase 3 (Core Domain). They can run concurrently on separate workstreams once Core is done.
- **Window B (HTTP/SSE ∥ Frontend):** Phase 5 and Phase 7 can overlap **once the API contract (routes, payloads, SSE event shape) is frozen in Phase 5's plan**. The frontend can be scaffolded against a mocked contract while the backend finalizes.

Both windows are optional; sequential execution is also valid. The executor should exploit them if the workspace supports worktrees (config: `use_worktrees=true`).

## Phases

- [ ] **Phase 1: Infrastructure & DNS Readiness** - Domain, VPS, and DNS correctly configured so the internet can deliver mail to our MX
- [ ] **Phase 2: Storage Layer** - SQLite schema + WAL + attachment directory scheme that every later phase writes through
- [ ] **Phase 3: Core Domain Logic** - Protocol-agnostic business rules (createInbox, ingestMessage, listMessages, expireInbox) + event bus
- [ ] **Phase 4: SMTP Ingestion** - Inbound MX on port 25 with size caps, catch-all disabled, STARTTLS, PII-minimizing logs
- [ ] **Phase 5: HTTP API + SSE** - Fastify routes, view-token cookie auth, rate limits, SSE with replay-on-subscribe
- [ ] **Phase 6: Retention Sweeper & Abuse Hardening** - Expiry sweeper, disk circuit breaker, per-IP abuse controls, fail2ban jails
- [ ] **Phase 7: Frontend (SvelteKit Static)** - Auto-mint UI, live countdown, sandboxed HTML render, mobile-responsive layout
- [ ] **Phase 8: Deployment (Docker Compose + Caddy)** - One-command self-host via `docker compose up -d` with auto-TLS and SSE passthrough
- [ ] **Phase 9: End-to-End Validation & Launch** - Real external delivery tests, pentests, PII log grep, and the go-live switch

## Phase Details

### Phase 1: Infrastructure & DNS Readiness

**Goal**: The operator's domain and VPS are configured so that external MTAs (Gmail, Outlook, Proton) can route mail to our server over port 25 with correct DNS authentication.

**Depends on**: Nothing (first phase — requires operator input to unblock execution, but does not block planning of later phases).

**Requirements** (8): INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, INFRA-06, INFRA-07, INFRA-08

**Success Criteria** (what must be TRUE):
  1. `dig MX <domain>` returns a hostname (not a CNAME, not an IP) that resolves via A to the VPS public IP.
  2. `dig TXT <domain>` shows `v=spf1 -all`; `dig TXT _dmarc.<domain>` shows `p=reject`.
  3. `nc -vz <vps-ip> 25` from an external network returns a 220 SMTP banner.
  4. `dig -x <vps-ip>` returns the MX hostname (PTR matches forward A = FCrDNS OK).
  5. A test email sent to `abuse@<domain>` lands in the operator's real inbox within minutes, and `GET https://<domain>/.well-known/security.txt` serves a valid file listing the abuse contact.

**Plans**: TBD

**Notes**: Domain name, VPS provider identity, and VPS specs are `Pending operator input` — tracked in STATE.md "Open Questions Blocking Execution". They block **execution** of this phase only; subsequent phases can be planned in full without them.

### Phase 2: Storage Layer

**Goal**: A durable, concurrent-safe SQLite schema with hash-sharded attachment storage that every other phase reads and writes through a single client wrapper.

**Depends on**: Nothing (no code dependencies — can be built in parallel with Phase 1 execution).

**Requirements** (4): STORE-01, STORE-02, STORE-03, STORE-04

**Success Criteria** (what must be TRUE):
  1. Running the migration creates `inboxes`, `messages`, `attachments`, `abuse_counters` tables with `domain` as a first-class column; `PRAGMA integrity_check` returns `ok`.
  2. `PRAGMA journal_mode` returns `wal`; `PRAGMA synchronous` returns `1` (NORMAL); `PRAGMA busy_timeout` returns `5000`; `PRAGMA foreign_keys` returns `1`.
  3. Writing a test attachment through the storage API places the file at `/data/attachments/<aa>/<bb>/<sha256>` and records the digest + path in the DB.
  4. Every SQL operation executed by the client wrapper uses a prepared statement (verified by a test that spies on `db.prepare` and rejects direct `db.exec` calls for data paths).

**Plans**: TBD

### Phase 3: Core Domain Logic

**Goal**: Protocol-agnostic business logic — create inboxes, ingest messages, list messages, expire inboxes — that both SMTP and HTTP adapters can call without either knowing about the other.

**Depends on**: Phase 2 (Storage).

**Requirements** (5): CORE-01, CORE-02, CORE-03, CORE-04, CORE-05

**Success Criteria** (what must be TRUE):
  1. `createInbox()` returns an address whose local-part has ≥64 bits of entropy (verified by shannon-entropy test on 10k samples) and a distinct view-token that is never equal to the local-part.
  2. `ingestMessage(envelope, parsed)` writes message + attachment rows in a single transaction; if any write throws, the DB state is unchanged AND no attachment files remain on disk.
  3. After `ingestMessage`, any listener registered via `bus.on('inbox:<id>', ...)` receives the new message synchronously within the same tick.
  4. `listMessages(inboxId, viewToken)` returns messages in descending `received_at` order and returns `[]` (not throws) if the view-token does not match.
  5. `expireInbox(inboxId)` cascades: message rows deleted, attachment rows deleted, attachment files unlinked from disk, abuse counter rows for that inbox cleared — all in one transaction.

**Plans**: TBD

### Phase 4: SMTP Ingestion

**Goal**: A receive-only MX listening on TCP:25 in the same Node process as the HTTP server, that accepts mail for existing inboxes, rejects everything else, and streams bodies without buffering.

**Depends on**: Phase 3 (Core Domain).
**Parallel with**: Phase 5 (both only need Phase 3).

**Requirements** (9): SMTP-01, SMTP-02, SMTP-03, SMTP-04, SMTP-05, SMTP-06, SMTP-07, SMTP-08, SMTP-09

**Success Criteria** (what must be TRUE):
  1. `swaks --to <existing-address> --from tester@example.com --server localhost:25 --body "hi"` returns `250 OK` and the message appears in `listMessages` within 1 second.
  2. `swaks --to nonexistent@<domain> --server localhost:25` returns `550` at `RCPT TO` (catch-all explicitly disabled); `swaks --to anyone --server localhost:25 --attach @big.bin` where `big.bin > 10MB` returns `552` at `DATA`.
  3. `openssl s_client -connect localhost:25 -starttls smtp` negotiates TLS successfully with the configured certificate.
  4. Sending 100 messages in 1 second from a single sender IP triggers `452` temp-fail responses after the rate-limit threshold; all messages before the threshold are delivered.
  5. After running a full SMTP session with a real message, grep of the SMTP log file returns no full recipient address, no subject, no body, no header values — only timestamp, sender IP, sender domain, message size, SMTP code, and the hashed recipient local-part.

**Plans**: TBD

### Phase 5: HTTP API + SSE

**Goal**: Fastify HTTP API on loopback exposing inbox mint / read / stream / attachment endpoints, with view-token cookie auth, per-route rate limits, security headers, and race-safe SSE (replay-on-subscribe).

**Depends on**: Phase 3 (Core Domain).
**Parallel with**: Phase 4 (both only need Phase 3). Frontend (Phase 7) can start once this phase's API contract is frozen in plan.

**Requirements** (14): API-01, API-02, API-03, API-04, API-05, API-06, API-07, API-08, API-09, API-10, API-11, RT-01, RT-02, RT-03

**Success Criteria** (what must be TRUE):
  1. `POST /api/inbox` returns a JSON body with `address`, `expiresAt` (but NOT the view-token) and sets the view-token as an `HttpOnly; SameSite=Lax; Secure` cookie; the address resolves to an existing DB row before the response completes.
  2. `GET /api/inbox/:id/messages` returns 200 with the cookie, 401/403 without; `GET /api/attachments/:id` streams bytes with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` headers.
  3. A browser connecting `EventSource('/api/inbox/:id/stream')` receives all messages stored before the connection (replay) AND any message delivered after (live), with no duplicates and no drops — tested by racing an ingest call against the subscribe.
  4. Disconnecting a live `EventSource` and reconnecting with `Last-Event-ID: <last>` resumes the stream from the correct point; server writes `: heartbeat\n\n` comments every 15 seconds.
  5. Running 100 POSTs to `/api/inbox` from a single IP in 10 seconds returns `429` after the threshold; response headers include `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options` (helmet defaults).

**Plans**: TBD

### Phase 6: Retention Sweeper & Abuse Hardening

**Goal**: Bounded disk usage and operator-visible abuse controls — inboxes expire on schedule, orphans are reaped, disk watermark circuit-breakers fire, per-IP rate limits and per-address blocklist are enforced, and fail2ban has something to jail on.

**Depends on**: Phase 3 (Core — needs `expireInbox`), Phase 4 (SMTP — to enforce 452 temp-fail), Phase 5 (HTTP — to enforce 429 and host the admin endpoint).

**Requirements** (9): RETN-01, RETN-02, RETN-03, RETN-04, ABUSE-01, ABUSE-02, ABUSE-03, ABUSE-04, ABUSE-05

**Success Criteria** (what must be TRUE):
  1. An inbox created with `now - 11min` last-activity is gone from disk and DB within 60 seconds of the sweeper tick running; its attachment files are unlinked in the same transaction.
  2. Placing a stray file at `/data/attachments/de/ad/deadbeef...` with no DB row causes the hourly orphan reaper to delete it; files with active DB rows are never touched.
  3. When simulated disk usage crosses 80%, SMTP `onData` returns `452` and a log line indicates the circuit breaker is open; at 90%, `POST /api/inbox` also returns `503` until disk recovers.
  4. Calling the localhost-only admin endpoint `curl -X POST http://127.0.0.1:<admin>/blocklist -d '{"address":"..."}'` causes subsequent SMTP `RCPT TO` for that address to return `550`; requests to the same endpoint from a non-loopback IP are refused.
  5. After a fail2ban-trigger simulation (e.g. 20 HTTP 429s from one IP), the shipped jail template matches the logged pattern and would ban the IP; log rotation confirmed: logs older than 48h are deleted; `ABUSE-04` verified by config inspection (no network log shipping configured).

**Plans**: TBD

### Phase 7: Frontend (SvelteKit Static)

**Goal**: A mobile-responsive, zero-tracker SPA that auto-mints an inbox on first visit, displays it prominently with a copy button, pushes new messages in real time, and renders HTML email safely in a sandboxed iframe with remote content blocked.

**Depends on**: Phase 5 (HTTP API contract must be frozen). Can start scaffolding against a mocked contract earlier to run in parallel with Phase 5.

**Requirements** (13): UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, UI-11, UI-12, UI-13

**Success Criteria** (what must be TRUE):
  1. Visiting `/` with no cookie renders an inbox address within 1 second, with no captcha, no signup; clicking the copy button copies `<address>` (no whitespace) to the OS clipboard and shows visible feedback.
  2. Sending an email to the displayed address causes a new message row to appear in the UI without any user action (SSE-driven), and the countdown timer resets on activity but never exceeds 1 hour total.
  3. An email containing `<script>alert(1)</script>`, `<img onerror=alert(1)>`, and a `<link rel=stylesheet href="//attacker.example/x.css">` renders in the iframe with NO alerts, NO network requests to attacker.example (verified via DevTools network inspector), and no remote images load until the user clicks "Load images".
  4. `curl -s https://<origin>/ | grep -E '(google-analytics|googletagmanager|googleapis\\.com/css|cdn\\.jsdelivr)'` returns zero hits; all fonts/JS/CSS are served from the same origin; a link to the privacy statement is present on every page.
  5. Opening the app in a browser window resized to 360×640 shows a fully usable layout: address visible, copy button tappable (≥44px), message list readable, no horizontal scroll.

**Plans**: TBD
**UI hint**: yes

### Phase 8: Deployment (Docker Compose + Caddy)

**Goal**: A single-command self-host — `docker compose up -d` stands up the Node app + Caddy reverse proxy with auto Let's Encrypt, SSE passthrough, static-asset serving, and a persistent data volume.

**Depends on**: Phases 4, 5, 7 (internal flow must already work on localhost before we put Caddy in front).

**Requirements** (7): DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, DEPLOY-05, DEPLOY-06, DEPLOY-07

**Success Criteria** (what must be TRUE):
  1. On a fresh VPS with the domain's DNS already pointing at it, running `docker compose up -d` from the repo brings up both services; within 2 minutes Caddy provisions a valid Let's Encrypt cert and `curl https://<domain>/` returns the SvelteKit app.
  2. `curl -N https://<domain>/api/inbox/<id>/stream` with a valid cookie streams events with sub-second latency — verified by timing an SMTP ingest vs the client-side receive; `flush_interval -1` in the Caddyfile is present.
  3. Stopping and restarting the compose stack preserves all inboxes and attachments (data lives in the named volume at `/data`); `docker compose down -v` is the only command that clears it.
  4. The systemd-units fallback in `deploy/systemd/` is documented in the README; a dry-run following the fallback instructions on a <1 GB VPS image starts both services.
  5. The deploy runbook at `deploy/RUNBOOK.md` includes an explicit "lower MX TTL 48h before migration" step; a checklist-style verification section documents post-migration `dig @8.8.8.8 MX` and `@1.1.1.1 MX` cross-check.

**Plans**: TBD

### Phase 9: End-to-End Validation & Launch

**Goal**: Verify the "Looks Done But Isn't" checklist against the deployed service with real external mail, pentest the exposed attack surface, and flip the service to publicly announced.

**Depends on**: Phase 8 (must be deployed on the real domain).

**Requirements** (7): VAL-01, VAL-02, VAL-03, VAL-04, VAL-05, VAL-06, VAL-07

**Success Criteria** (what must be TRUE):
  1. Three real send tests pass: a message sent from a Gmail account, an Outlook/Hotmail account, and a Proton account to freshly-minted addresses all arrive in the UI within 5 seconds; `internet.nl/mail/<domain>/` returns green for MX, STARTTLS, and all applicable sub-checks.
  2. A scripted load test (`ab` or `hey`) firing 100 inbox-creation POSTs in 10 seconds from one IP produces `429` after the threshold; the sweeper verification test confirms an inbox older than its TTL is physically gone from disk and DB within one 60s cycle.
  3. An XSS payload suite (including `<script>`, `<img onerror>`, DOM clobbering attempts, `<meta http-equiv=refresh>`, SVG `onload`) sent to a test inbox and rendered produces zero JS execution, verified by opening each in a browser with `console.error` instrumentation.
  4. An enumeration attempt scripting 1000 sequential `GET /api/inbox/<random>/messages` requests without the correct cookie returns `401/403/404` indistinguishably (no existence leak) and triggers rate-limit `429` well before completion.
  5. `grep -rE "(@<domain>|Subject:|From: |To: )" /var/log/` on the live VPS returns zero matches containing real mail content; a fresh install has no PII in any log file.

**Plans**: TBD

## Dependency Graph

```
Phase 1 (Infra/DNS)          Phase 2 (Storage)
  │ [operator-input gated]     │
  │                            v
  │                          Phase 3 (Core Domain)
  │                            │
  │                            ├────────────┐
  │                            v            v
  │                         Phase 4       Phase 5
  │                         (SMTP)        (HTTP+SSE)
  │                            │            │
  │                            └─────┬──────┤
  │                                  v      ├──────> Phase 7 (Frontend)
  │                               Phase 6          [parallel once API contract frozen]
  │                               (Sweeper+Abuse)
  │                                  │             │
  └──────────────────────────────────┴─────────────┘
                                     v
                               Phase 8 (Deploy)
                                     │
                                     v
                               Phase 9 (Validation/Launch)
```

Dashed arrow from Phase 1: execution of Phase 1 requires operator input (domain name, VPS provider, VPS specs, `abuse@` destination), but downstream phase *planning* is not blocked.

## Coverage

**v1 requirements:** 76 (INFRA-01..VAL-07 — the 73 figure in REQUIREMENTS.md is an arithmetic error; the actual checkbox count is 76)
**Mapped to phases:** 76
**Unmapped:** 0
**Duplicated:** 0

Every v1 requirement ID from INFRA-01 through VAL-07 appears in exactly one phase's `Requirements` list. See the per-category mapping in REQUIREMENTS.md Traceability.

### Coverage Breakdown by Category

| Category | Count | Phase |
|----------|-------|-------|
| INFRA-01..08 | 8 | Phase 1 |
| STORE-01..04 | 4 | Phase 2 |
| CORE-01..05 | 5 | Phase 3 |
| SMTP-01..09 | 9 | Phase 4 |
| API-01..11 | 11 | Phase 5 |
| RT-01..03 | 3 | Phase 5 |
| UI-01..13 | 13 | Phase 7 |
| RETN-01..04 | 4 | Phase 6 |
| ABUSE-01..05 | 5 | Phase 6 |
| DEPLOY-01..07 | 7 | Phase 8 |
| VAL-01..07 | 7 | Phase 9 |
| **Total** | **76** | **9 phases** |

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure & DNS Readiness | 0/0 | Not started | - |
| 2. Storage Layer | 0/0 | Not started | - |
| 3. Core Domain Logic | 3/4 | In progress | - |
| 4. SMTP Ingestion | 0/0 | Not started | - |
| 5. HTTP API + SSE | 0/0 | Not started | - |
| 6. Retention Sweeper & Abuse Hardening | 0/0 | Not started | - |
| 7. Frontend (SvelteKit Static) | 0/0 | Not started | - |
| 8. Deployment (Docker Compose + Caddy) | 0/0 | Not started | - |
| 9. End-to-End Validation & Launch | 0/0 | Not started | - |

Plans are filled in by `/gsd-plan-phase <N>` at phase entry.

---
*Roadmap created: 2026-04-18*
*Granularity: deep | Parallelization: enabled | Worktrees: enabled*
