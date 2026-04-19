# Phase 4: SMTP Ingestion - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto

<domain>
## Phase Boundary

Bind an SMTP server on :25 in the same Node process as (eventually) the HTTP server. Accept inbound mail for known inboxes, stream-parse it, sanitize HTML, persist via Core `ingestMessage`, emit PII-safe logs, rate-limit abusive senders. Receive-only — AUTH disabled, SIZE advertised, no outbound.

Scope (REQUIREMENTS.md SMTP-01..09):
- :25 listener (in-process, same Node as HTTP)
- AUTH disabled (unauthenticated submission rejected)
- SIZE=10485760 advertised, >10MB → 552
- `onRcptTo`: reject unknown recipients with 550 (no catch-all)
- Body parsing via `mailparser.simpleParser` streaming — no full buffer
- STARTTLS with valid certificate
- Per-sender-IP token-bucket rate limit; 452 temp-fail under pressure
- Explicit connection/data/command timeouts
- PII-minimized logs (no addresses, no subjects, no bodies)

Out of scope: SMTP submission/auth, outbound relay, SPF/DKIM verification (deferred to v2 — this is the MX endpoint receiving whatever arrives).

</domain>

<decisions>
## Implementation Decisions

### Library and Module Layout
- **D-01:** `smtp-server@3.x` (Nodemailer) — embedded library, not Postfix/Haraka.
- **D-02:** `mailparser@3.x` `simpleParser` — streaming parse; never `await simpleParser(fullBuffer)`.
- **D-03:** `isomorphic-dompurify@2.x` OR `dompurify@3.x` + `jsdom@24.x` — server-side HTML sanitization happens HERE in the SMTP layer (per Phase 3 D-13), BEFORE calling `core.ingestMessage`.
- **D-04:** New module root: `src/smtp/`. Files: `server.ts` (bind + handlers), `session.ts` (per-connection state), `parser.ts` (mailparser wrapping), `sanitizer.ts` (DOMPurify setup), `rate-limit.ts` (token bucket), `log.ts` (PII-safe formatter). `index.ts` exposes `createSmtpServer(deps)`.
- **D-05:** Factory `createSmtpServer({ core, config, now, logger })` returns `{ listen(port), close() }`. Same DI style as Core.

### Port and TLS (SMTP-01, SMTP-06)
- **D-06:** Binds configurable port (default 25 prod, 2525 dev for non-privileged). Production uses CAP_NET_BIND_SERVICE or runs rootless with systemd unit setting it (documented in Phase 8).
- **D-07:** STARTTLS with cert/key paths from config; in dev mode, generate a self-signed cert at startup and log a clear warning.
- **D-08:** TLS options: `minVersion: 'TLSv1.2'`, prefer modern ciphers; `secured` event logs TLS used (no cipher details to prod logs).

### AUTH (SMTP-02)
- **D-09:** `authOptional: true` at server level — allow unauthenticated connections.
- **D-10:** No `onAuth` handler — any AUTH attempt must be rejected cleanly (smtp-server default behavior with `disabledCommands: ['AUTH']`).
- **D-11:** Explicit `disabledCommands: ['AUTH']` to advertise clearly.

### Size Limits (SMTP-03)
- **D-12:** `size: 10 * 1024 * 1024` (10 MB) at server config — smtp-server advertises SIZE and rejects oversize at DATA.
- **D-13:** Per-inbox total cap (25 MB) enforced by Phase 6 sweeper (not here). SMTP layer only enforces per-message cap.

### Recipient Validation (SMTP-04)
- **D-14:** `onRcptTo(address, session, cb)`:
  - Parse `address.address` → extract local-part + domain
  - Domain mismatch to config domain → `cb(new Error('550 Relay access denied'))`
  - `core.lookupInbox(localPart, domain)` → found? proceed : `cb(new Error('550 5.1.1 Unknown recipient'))` (NO catch-all)
- **D-15:** Expose new read-only helper on Core: `core.findInboxByAddress(localPart, domain)`. If absent in current Core API, extend Phase 3 minimally — one-line addition via `inboxRepo.findInboxByLocalPartAndDomain` passthrough. Planner decides whether to add to `core.inboxes` or make smtp adapter call repos directly (prefer the former to keep D-03 boundary).

### Parsing and Attachments (SMTP-05)
- **D-16:** `onData(stream, session, cb)`:
  - Pipe stream through `simpleParser`
  - For each attachment: pipe through `attachmentStore.writeAttachment(stream)` → get `{sha256, size, path}`
  - Collect structured payload
  - Sanitize HTML body via DOMPurify (per D-03)
  - Call `core.ingestMessage(payload)`
  - Bridge result: `accepted: false, reason: "unknown_recipient"` → 550; `"invalid_attachment"` → 550; success → `cb()`
- **D-17:** Streaming throughout — never `Buffer.concat` entire raw message.

### Sanitization (D-13 from Phase 3, enforced here)
- **D-18:** DOMPurify config: `FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'base', 'link']`, `FORBID_ATTR: ['on*', 'style', 'srcset', 'srcdoc', 'formaction']`, `ALLOW_DATA_ATTR: false`, `ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i` — blocks `javascript:`, `vbscript:`, `data:` URIs.
- **D-19:** Return value of sanitize is what gets stored as `html_body_sanitized`. Text body stored as-is.
- **D-20:** Image tags with remote `src` are LEFT IN (the frontend iframe CSP blocks them from loading; preserving the tag lets the "Load images" button work). But `src="data:"` URIs are stripped by D-18.

### Rate Limiting (SMTP-07)
- **D-21:** Token bucket per sender IP prefix (`/24` IPv4, `/64` IPv6) in-memory Map with periodic cleanup. Per connection:
  - Refill rate: 10 tokens / 60s per prefix
  - Burst: 20
  - RCPT/DATA consumes a token
  - Empty bucket → respond `452 4.7.1 Too many requests, try later`
- **D-22:** Shared with HTTP layer? No — SMTP rate limiter is SMTP-only. HTTP uses `@fastify/rate-limit` (Phase 5).
- **D-23:** On 452, also persist to `abuse_counters` via `abuseRepo.incrementCounter(ipPrefix, 'smtp_452')` for observability.

### Timeouts (SMTP-08)
- **D-24:** Server timeouts: `socketTimeout: 60000` (60s idle), `closeTimeout: 30000` (30s graceful close), `size: 10MB` (already set).
- **D-25:** DATA phase has its own implicit timeout via socketTimeout; 10MB at 1Mbps = ~80s worst case — if that's reasonable, bump socketTimeout to 120000 for the DATA state specifically. Planner picks.

### PII-Safe Logging (SMTP-09)
- **D-26:** Log fields (whitelist): `timestamp, sender_ip, sender_ip_prefix, sender_domain, message_size, smtp_code, duration_ms, local_part_hash_first8`
- **D-27:** `local_part_hash_first8` = first 8 hex chars of `sha256(local_part + domain + PII_LOG_SALT)`. Salt from env var, regenerated per deploy ideally (documented in Phase 8).
- **D-28:** NEVER log: full sender address, recipient address, subject, body, message-id header, attachment filenames
- **D-29:** `pino` logger from Phase 1, wrapped in a thin `smtpLog.ts` helper that enforces the whitelist. Unit test: raw pino calls banned inside `src/smtp/*` except through the helper.

### Config Schema
- **D-30:** `SmtpConfig { port, hostname, domain, tlsCert?, tlsKey?, devGenerateSelfSigned?, maxMessageBytes, rateLimit: { tokensPerMinute, burst }, timeouts: { socketMs, closeMs }, piiLogSalt }`
- **D-31:** Config validated at `createSmtpServer` entry; throws on missing/invalid (programmer error, D-20 from Phase 3 philosophy).

### Testing
- **D-32:** Vitest with a real in-memory SQLite + in-process `smtp-connection` client driving the server. No docker, no external MTA needed. Test STARTTLS with `openssl`-less path via `smtp-connection` `{ secure: true, requireTLS: true }`.
- **D-33:** Minimal E2E using `swaks` as an optional integration test — skipped if `swaks` not on PATH.
- **D-34:** Must cover: unknown recipient → 550; oversize → 552; AUTH attempt → rejected; valid mail → stored; HTML sanitized (script tag removed; javascript: URI removed); attachment stored on disk; rate-limit trip → 452; timeout enforced; STARTTLS negotiated; PII-safe logs (grep test: emitted log events contain no address/subject bytes).

### Claude's Discretion
- Choice between `isomorphic-dompurify` (lighter) vs `dompurify + jsdom` (more control)
- Exact `SmtpConfig` shape as long as D-30 fields are present
- Token-bucket implementation (inline vs dependency like `limiter` package — prefer inline, ~50 lines)

</decisions>

<specifics>
## Specific Ideas

- D-15 / D-16 split the core API extension into planner's hands — prefer adding `core.findInboxByAddress` to stay inside D-03 of Phase 3.
- D-20 leaves remote-src img tags intact by design — the frontend (Phase 7) sandboxed iframe with CSP `default-src 'none'` is the actual tracking-pixel defense, not server stripping. Stripping server-side breaks the "Load images" opt-in.
- PII_LOG_SALT (D-27) doubles as the mechanism to prevent across-time correlation when logs rotate: a new salt every deploy means old hashes can't be tied to new ones.

</specifics>

<canonical_refs>
## Canonical References

### Roadmap and requirements
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md` §SMTP (SMTP-01..09)
- `.planning/ROADMAP.md` §Phase 4

### Research
- `.planning/research/STACK.md` §SMTP (locks smtp-server + mailparser)
- `.planning/research/ARCHITECTURE.md` §Inbound flow
- `.planning/research/PITFALLS.md` §Ingestion (streaming, size caps, PII logs)

### Phase 3 Core API (read `src/core/index.ts` types before planning)
- `createCore(deps) → CoreApi`
- `core.ingestMessage(input) → IngestResult`
- Core extension point: add `core.findInboxByAddress(localPart, domain)` if not already present

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 2 `createAttachmentStore` — `writeAttachment(stream) → {sha256, size, path}` handles streaming + dedup.
- Phase 3 `createCore({ repos, attachmentStore, config, bus? })` — the entire business layer.
- `pino` from Phase 1 — reuse logger factory.

### Patterns
- Factory + deps injection everywhere; no globals.
- Prepared-statement invariant enforced per-layer — SMTP layer must not import `better-sqlite3` directly; only through Core.

### Gotchas
- Windows dev: smtp-server on port 25 needs admin. Use 2525 in dev.
- `simpleParser` can backpressure poorly with very large attachments — set `highWaterMark` on the incoming stream if issues.
- DOMPurify `jsdom` startup is ~200ms; initialize once at server construction, reuse.
- STARTTLS implementation in smtp-server switches the underlying socket — ensure timeouts are reapplied after upgrade.

</code_context>

<deferred>
## Deferred Ideas
- SPF / DKIM / DMARC verification (v2; requires outbound DNS and headers — out of MVP)
- Greylisting (v2; operational complexity outweighs v1 benefit)
- Bayesian spam classifier (out of scope forever — anti-feature)
</deferred>
