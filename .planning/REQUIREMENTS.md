# Requirements: Tempmail

**Defined:** 2026-04-18
**Core Value:** Visit → get inbox → receive email — in under 3 seconds, with zero signup.

## v1 Requirements

Requirements for the initial public-launch release. Each maps to roadmap phases.

### Infrastructure (INFRA)

- [ ] **INFRA-01**: Domain has correct MX record (A, not CNAME) pointing to the VPS public IP
- [ ] **INFRA-02**: Domain has SPF `v=spf1 -all` (receive-only stance) published
- [ ] **INFRA-03**: Domain has DMARC `p=reject` published
- [ ] **INFRA-04**: VPS has matching PTR / FCrDNS configured
- [ ] **INFRA-05**: VPS accepts inbound TCP on port 25 (verified externally with `nc -vz`)
- [ ] **INFRA-06**: `abuse@<domain>` mailbox routes to a real inbox the operator monitors within hours
- [ ] **INFRA-07**: `security.txt` published at `/.well-known/security.txt`
- [ ] **INFRA-08**: Provider AUP reviewed; disposable-mail not prohibited; second VPS provider pre-vetted as fallback

### Storage (STORE)

- [ ] **STORE-01**: SQLite schema includes `inboxes`, `messages`, `attachments`, `abuse_counters` tables with `domain` as a first-class column
- [ ] **STORE-02**: SQLite opened in WAL mode with documented PRAGMAs (`synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`)
- [ ] **STORE-03**: Attachments stored on disk in hash-sharded directories (`/data/attachments/<aa>/<bb>/<sha256>`), metadata in DB
- [ ] **STORE-04**: All schema accesses use prepared statements via a single client wrapper

### Core Domain (CORE)

- [ ] **CORE-01**: `createInbox()` generates a random local-part with ≥64 bits of entropy (nanoid 16-char base32 or stronger)
- [ ] **CORE-02**: Each inbox has a separate view-token distinct from its public address
- [ ] **CORE-03**: `ingestMessage()` writes message + attachments transactionally and emits an in-process event
- [ ] **CORE-04**: `listMessages()` returns chronological messages for a given inbox + view-token
- [ ] **CORE-05**: `expireInbox()` cascades deletes to messages + attachment files + abuse counters

### SMTP Ingestion (SMTP)

- [ ] **SMTP-01**: SMTP server listens on TCP:25 in the same Node process as the HTTP server
- [ ] **SMTP-02**: AUTH is disabled; the server is unauthenticated submission for inbound only
- [ ] **SMTP-03**: SMTP advertises `SIZE=10485760` (10 MB) and rejects oversize messages with 552
- [ ] **SMTP-04**: `onRcptTo` rejects unknown recipients with 550 (catch-all explicitly disabled)
- [ ] **SMTP-05**: Body parsing streams via `mailparser.simpleParser` — no full-message buffering in RAM
- [ ] **SMTP-06**: STARTTLS is offered with a valid certificate
- [ ] **SMTP-07**: Per-sender-IP rate limiting at the SMTP layer (token bucket; 452 temp-fail under pressure)
- [ ] **SMTP-08**: Connection / data / command timeouts are explicit (not defaults)
- [ ] **SMTP-09**: SMTP logs are PII-minimized (timestamp, sender IP, sender domain, size, SMTP code, hashed recipient local-part — never full addresses or content)

### HTTP API (API)

- [ ] **API-01**: `POST /api/inbox` mints a new inbox and returns `{address, viewToken, expiresAt}`
- [ ] **API-02**: `GET /api/inbox/:id` returns inbox metadata (requires view-token)
- [ ] **API-03**: `GET /api/inbox/:id/messages` returns chronological messages (requires view-token)
- [ ] **API-04**: `GET /api/inbox/:id/messages/:msgId` returns a single message body (text + sanitized HTML)
- [ ] **API-05**: `GET /api/inbox/:id/stream` opens an SSE stream with `Last-Event-ID` reconnect support
- [ ] **API-06**: SSE handler **replays** stored messages on subscribe before attaching the live listener
- [ ] **API-07**: SSE emits keepalive heartbeats every 15 seconds
- [ ] **API-08**: `GET /api/attachments/:id` streams attachment bytes with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
- [ ] **API-09**: View-token is delivered as an HttpOnly + SameSite=Lax + Secure cookie — never as a URL parameter
- [ ] **API-10**: `@fastify/rate-limit` is enabled on every public route (mint, list, stream, attachment)
- [ ] **API-11**: `@fastify/helmet` security headers are enabled (CSP, frame-ancestors, etc.)

### Real-Time UX (RT)

- [ ] **RT-01**: Browser opens an `EventSource` to `/api/inbox/:id/stream` and receives messages without manual refresh
- [ ] **RT-02**: Disconnects auto-reconnect via the `EventSource` reconnect mechanism + `Last-Event-ID` resume
- [ ] **RT-03**: Race-window safe: a message that arrives before the SSE subscription completes is still delivered (server replay)

### Frontend (UI)

- [ ] **UI-01**: First visit auto-mints an inbox (no signup, no captcha on landing)
- [ ] **UI-02**: Address is visible large and copy-to-clipboard with one button
- [ ] **UI-03**: Inbox shows live countdown to expiry; idle activity resets the timer up to a hard ceiling
- [ ] **UI-04**: "New inbox" button discards current inbox and mints a fresh one
- [ ] **UI-05**: Message list shows sender, subject, received-at; click expands to full message
- [ ] **UI-06**: Plain-text body renders as the default view
- [ ] **UI-07**: HTML body renders inside a sandboxed iframe (`sandbox="allow-popups"` only — no scripts, no same-origin)
- [ ] **UI-08**: HTML is sanitized server-side with DOMPurify before being served to the iframe
- [ ] **UI-09**: Iframe `srcdoc` includes `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ...">`
- [ ] **UI-10**: Remote content (images, fonts, stylesheets) is blocked by default; an explicit "Load images" button is required to unblock for the current message
- [ ] **UI-11**: Layout is mobile-responsive (functional on a 360px viewport)
- [ ] **UI-12**: Privacy statement linked from every page (no accounts, no analytics, retention policy stated)
- [ ] **UI-13**: No third-party trackers, no analytics SDKs, no external font/CDN loads

### Retention & Sweeper (RETN)

- [ ] **RETN-01**: Default retention is 10 minutes idle, hard ceiling 1 hour absolute
- [ ] **RETN-02**: A `setInterval(60s)` sweeper deletes expired inboxes + their messages + attachment files in a single transaction
- [ ] **RETN-03**: An hourly orphan reaper deletes attachment files with no DB references
- [ ] **RETN-04**: A disk-watermark circuit breaker switches SMTP to 452 temp-fail at 80% disk usage and refuses new inboxes at 90%

### Abuse & Operations (ABUSE)

- [ ] **ABUSE-01**: Per-IP rate limits on inbox creation (e.g. 5/min, 50/hour) and on message reads
- [ ] **ABUSE-02**: A localhost-only admin endpoint allows operator to blocklist a specific address on demand
- [ ] **ABUSE-03**: Logs are whitelist-only (timestamp, sender IP, hashed local-part, status code) and rotate at 24–48h
- [ ] **ABUSE-04**: No third-party log aggregators or off-box log shipping
- [ ] **ABUSE-05**: `fail2ban` jail templates are shipped for SMTP and HTTP rate-limit hits

### Deployment (DEPLOY)

- [ ] **DEPLOY-01**: Single `docker compose up -d` brings up the full stack (Node app + Caddy)
- [ ] **DEPLOY-02**: Caddyfile auto-provisions Let's Encrypt for the web origin
- [ ] **DEPLOY-03**: Caddy reverse-proxies `/api/*` to the Node loopback port with `flush_interval -1` for SSE
- [ ] **DEPLOY-04**: Caddy serves the SvelteKit static build directly
- [ ] **DEPLOY-05**: Persistent data lives in a single named volume (`/data`) — DB + attachments
- [ ] **DEPLOY-06**: A systemd-units fallback is documented for VPS instances under 1 GB RAM
- [ ] **DEPLOY-07**: A deploy runbook documents MX-TTL pre-lowering before any IP migration

### Validation (VAL)

- [ ] **VAL-01**: External delivery test: Gmail, Outlook, and Proton each successfully deliver to a freshly-minted address
- [ ] **VAL-02**: `internet.nl/mail/` shows green for the domain (MX, STARTTLS, DNSSEC where applicable)
- [ ] **VAL-03**: Load test: 100 inbox-creation POSTs in 10 seconds returns 429 to the offender
- [ ] **VAL-04**: XSS pentest: a payload using `<script>`, `<img onerror>`, and DOM-clobbering attempts cannot execute in the iframe
- [ ] **VAL-05**: Enumeration pentest: cannot list or guess other users' inboxes by mutating IDs
- [ ] **VAL-06**: Sweeper verification: an inbox older than its TTL is gone from disk and DB within one sweeper cycle
- [ ] **VAL-07**: PII-log grep: no full email addresses, no message bodies, no header dumps in any log file

## v2 Requirements

Acknowledged but deferred. Not in current roadmap.

### Frontend Polish (UIPOL)

- **UIPOL-01**: QR code of the address for cross-device share
- **UIPOL-02**: Dark mode toggle
- **UIPOL-03**: Raw-source view of message
- **UIPOL-04**: No-JS read path

### Public Surface (PUB)

- **PUB-01**: Public status page showing service health
- **PUB-02**: Documented HTTP/SSE API for third-party tools
- **PUB-03**: ALTCHA (self-hosted PoW captcha) triggered only on rate-limit trip

### Multi-Domain (MD)

- **MD-01**: Operator can add additional domains live without DB migration (`domains` table from v1 makes this trivial)
- **MD-02**: User can pick which domain to mint an inbox on

## Out of Scope

| Feature | Reason |
|---------|--------|
| User accounts / persistent inboxes | Defeats the disposable core value |
| Sending email from the inbox | Out of scope for v1; tempmail = receive-only; outbound risks spam-relay reputation |
| Custom user-chosen addresses | Random keeps namespace simple, removes enumeration vector |
| Catch-all forwarding to a real inbox | Different product (alias service) |
| Spam filtering / virus scanning | Users opt into receiving anything by definition |
| Paid features / billing | Explicit personal-project goal: free to run, free to use |
| Multi-domain in v1 | Data model is domain-aware (STORE-01) but only one domain ships |
| Native mobile / desktop apps | Web only |
| Image proxy for tracking-pixel mitigation | Privacy goal achieved by blocking remote content; proxy itself becomes a tracker target |
| Push notifications | Defeats anonymity (requires push-service identifier) |
| Message threading / search | Scope creep for ephemeral inboxes |
| Public-inbox / shared-namespace mode | Strongly cautioned against — fraud and harassment vector |
| Third-party analytics or telemetry | Explicit privacy stance in PROJECT.md |

## Traceability

Filled by `gsd-roadmapper` on 2026-04-18. Every v1 requirement is mapped to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Pending |
| INFRA-02 | Phase 1 | Pending |
| INFRA-03 | Phase 1 | Pending |
| INFRA-04 | Phase 1 | Pending |
| INFRA-05 | Phase 1 | Pending |
| INFRA-06 | Phase 1 | Pending |
| INFRA-07 | Phase 1 | Pending |
| INFRA-08 | Phase 1 | Pending |
| STORE-01 | Phase 2 | Pending |
| STORE-02 | Phase 2 | Pending |
| STORE-03 | Phase 2 | Pending |
| STORE-04 | Phase 2 | Pending |
| CORE-01 | Phase 3 | Pending |
| CORE-02 | Phase 3 | Pending |
| CORE-03 | Phase 3 | Pending |
| CORE-04 | Phase 3 | Pending |
| CORE-05 | Phase 3 | Pending |
| SMTP-01 | Phase 4 | Pending |
| SMTP-02 | Phase 4 | Pending |
| SMTP-03 | Phase 4 | Pending |
| SMTP-04 | Phase 4 | Pending |
| SMTP-05 | Phase 4 | Pending |
| SMTP-06 | Phase 4 | Pending |
| SMTP-07 | Phase 4 | Pending |
| SMTP-08 | Phase 4 | Pending |
| SMTP-09 | Phase 4 | Pending |
| API-01 | Phase 5 | Pending |
| API-02 | Phase 5 | Pending |
| API-03 | Phase 5 | Pending |
| API-04 | Phase 5 | Pending |
| API-05 | Phase 5 | Pending |
| API-06 | Phase 5 | Pending |
| API-07 | Phase 5 | Pending |
| API-08 | Phase 5 | Pending |
| API-09 | Phase 5 | Pending |
| API-10 | Phase 5 | Pending |
| API-11 | Phase 5 | Pending |
| RT-01 | Phase 5 | Pending |
| RT-02 | Phase 5 | Pending |
| RT-03 | Phase 5 | Pending |
| RETN-01 | Phase 6 | Pending |
| RETN-02 | Phase 6 | Pending |
| RETN-03 | Phase 6 | Pending |
| RETN-04 | Phase 6 | Pending |
| ABUSE-01 | Phase 6 | Pending |
| ABUSE-02 | Phase 6 | Pending |
| ABUSE-03 | Phase 6 | Pending |
| ABUSE-04 | Phase 6 | Pending |
| ABUSE-05 | Phase 6 | Pending |
| UI-01 | Phase 7 | Pending |
| UI-02 | Phase 7 | Pending |
| UI-03 | Phase 7 | Pending |
| UI-04 | Phase 7 | Pending |
| UI-05 | Phase 7 | Pending |
| UI-06 | Phase 7 | Pending |
| UI-07 | Phase 7 | Pending |
| UI-08 | Phase 7 | Pending |
| UI-09 | Phase 7 | Pending |
| UI-10 | Phase 7 | Pending |
| UI-11 | Phase 7 | Pending |
| UI-12 | Phase 7 | Pending |
| UI-13 | Phase 7 | Pending |
| DEPLOY-01 | Phase 8 | Pending |
| DEPLOY-02 | Phase 8 | Pending |
| DEPLOY-03 | Phase 8 | Pending |
| DEPLOY-04 | Phase 8 | Pending |
| DEPLOY-05 | Phase 8 | Pending |
| DEPLOY-06 | Phase 8 | Pending |
| DEPLOY-07 | Phase 8 | Pending |
| VAL-01 | Phase 9 | Pending |
| VAL-02 | Phase 9 | Pending |
| VAL-03 | Phase 9 | Pending |
| VAL-04 | Phase 9 | Pending |
| VAL-05 | Phase 9 | Pending |
| VAL-06 | Phase 9 | Pending |
| VAL-07 | Phase 9 | Pending |

**Coverage:**
- v1 requirements: 76 total (actual count from checkbox enumeration; the earlier "73" was an arithmetic error)
- Mapped to phases: 76
- Unmapped: 0
- Duplicated across phases: 0

### Coverage by Phase

| Phase | Requirements | Count |
|-------|--------------|-------|
| Phase 1: Infrastructure & DNS Readiness | INFRA-01..08 | 8 |
| Phase 2: Storage Layer | STORE-01..04 | 4 |
| Phase 3: Core Domain Logic | CORE-01..05 | 5 |
| Phase 4: SMTP Ingestion | SMTP-01..09 | 9 |
| Phase 5: HTTP API + SSE | API-01..11, RT-01..03 | 14 |
| Phase 6: Retention Sweeper & Abuse Hardening | RETN-01..04, ABUSE-01..05 | 9 |
| Phase 7: Frontend (SvelteKit Static) | UI-01..13 | 13 |
| Phase 8: Deployment (Docker Compose + Caddy) | DEPLOY-01..07 | 7 |
| Phase 9: End-to-End Validation & Launch | VAL-01..07 | 7 |
| **Total** | — | **76** |

---
*Requirements defined: 2026-04-18*
*Traceability mapped: 2026-04-18 by gsd-roadmapper*
