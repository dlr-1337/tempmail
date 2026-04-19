# Phase 5: HTTP API + SSE - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto

<domain>
## Phase Boundary

A Fastify HTTP server running in the same Node process as SMTP, exposing the REST surface for inbox mint/list/read, streaming SSE for real-time delivery, serving attachment bytes, and enforcing per-route rate limits. Binds loopback only — Caddy (Phase 8) fronts with TLS.

Scope (REQUIREMENTS.md API-01..11, RT-01..03):
- `POST /api/inbox` mints new inbox, sets HttpOnly+SameSite=Lax+Secure cookie
- `GET /api/inbox/:id`, `GET /api/inbox/:id/messages`, `GET /api/inbox/:id/messages/:msgId` — view-token required
- `GET /api/inbox/:id/stream` — SSE with `Last-Event-ID` reconnect + **replay-on-subscribe** + 15s heartbeats
- `GET /api/attachments/:id` — streamed, `Content-Disposition: attachment` + `nosniff`
- `@fastify/rate-limit` on all public routes
- `@fastify/helmet` security headers (CSP, frame-ancestors, etc.)

Out of scope: TLS termination (Phase 8 — Caddy), frontend (Phase 7), sweeper scheduling (Phase 6), CORS for third-party origins (deferred).

</domain>

<decisions>
## Implementation Decisions

### Framework & Module Layout
- **D-01:** `fastify@5.x` core + `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/sensible`.
- **D-02:** New module root `src/http/`. Files: `server.ts` (app builder), `routes/inbox.ts`, `routes/messages.ts`, `routes/attachments.ts`, `routes/stream.ts`, `plugins/auth.ts` (view-token cookie guard), `plugins/rate-limit.ts`, `plugins/helmet.ts`, `sse.ts` (SSE serializer), `schemas.ts` (zod or JSON Schema).
- **D-03:** Factory `createHttpServer({ core, config, logger })` returns a Fastify instance with `.listen(port, hostname)` and `.close()`.
- **D-04:** Bind `127.0.0.1` only — never public. Caddy in Phase 8 reverse-proxies; SSE uses `flush_interval -1`.

### View-Token Cookie (API-09)
- **D-05:** On `POST /api/inbox` success: set cookie `tempmail_vt_<inboxId>` (scoped per inbox so multiple tabs can coexist) with:
  - `HttpOnly: true`
  - `Secure: true` (respected even behind Caddy; Fastify's `secure: 'auto'` mode sets it when `x-forwarded-proto=https`)
  - `SameSite: 'Lax'`
  - `Path: /api/inbox/<inboxId>`
  - `Max-Age: <hardTtlMs / 1000>` (Core config)
- **D-06:** NEVER accept view-token via query string or URL path — cookie only.
- **D-07:** Auth plugin (`plugins/auth.ts`) decorates routes that require it. Reads `tempmail_vt_<inboxId>` cookie from request, passes to `core.listMessages({ inboxId, viewToken })`. Missing cookie → `401`; wrong token → `403` (from Core's `"forbidden"`); missing inbox → `404` (from Core's `"not_found"`).

### Routes (API-01..08)
- **D-08:** `POST /api/inbox`:
  - Body: none (or optional `{ domain }` for v2 — ignore in v1)
  - Response: `201 { address: "abc123@domain.tld", expiresAt: <epochMs> }` (no viewToken in body; it's in the cookie)
  - Rate-limited per IP
- **D-09:** `GET /api/inbox/:id`:
  - Auth: cookie required
  - Response: `{ address, createdAt, lastActivityAt, expiresAt, messageCount }`
- **D-10:** `GET /api/inbox/:id/messages`:
  - Auth: cookie required
  - Response: `{ messages: MessageView[] }` (metadata only, no bodies)
- **D-11:** `GET /api/inbox/:id/messages/:msgId`:
  - Auth: cookie required
  - Response: `{ id, sender, subject, receivedAt, textBody, htmlBody, attachments: AttachmentView[] }`
  - `htmlBody` is already sanitized (Phase 4 did it) — served as-is
- **D-12:** `GET /api/inbox/:id/stream` (SSE):
  - Auth: cookie required
  - `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`
  - Writes `id: <epochMs-randomId>` + `event: message` + `data: <json>` per message
  - Honors `Last-Event-ID` header for reconnect — **replays stored messages** with `receivedAt > lastEventId` BEFORE attaching the live listener
  - Heartbeat: `: heartbeat <timestamp>\n\n` every 15s
  - Close: unsubscribe from bus on request end
- **D-13:** `GET /api/attachments/:id`:
  - Auth: cookie required (inbox-scoped: must own the message that owns the attachment)
  - `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="..."` (RFC 5987 encoded for non-ASCII), `X-Content-Type-Options: nosniff`
  - Stream from disk via `attachmentStore.readAttachment(sha256)`

### SSE Implementation (RT-01..03, API-05..07)
- **D-14:** SSE is a raw reply.raw writer — not Fastify's default serializer. Use `reply.raw.writeHead(200, headers)` + `reply.raw.write(eventString)`.
- **D-15:** `id:` format: `<receivedAtMs>-<messageId>` — monotonic enough to survive reconnect; `Last-Event-ID` parsed as `<receivedAtMs>` prefix.
- **D-16:** Replay-on-subscribe sequence:
  1. Validate auth
  2. Write headers, flush
  3. Query `core.listMessages({inboxId, viewToken})` → filter `receivedAt > lastEventId`
  4. Write each as an SSE event, flush
  5. Subscribe to `core.bus.on('message', ...)` with inbox filter
  6. On new event: write to raw reply, flush
  7. On `request.raw.on('close', ...)`: unsubscribe
  8. Start heartbeat interval; clear on close
- **D-17:** Backpressure: if `reply.raw.write()` returns false, wait for `drain` before next write. For heartbeats, skip if writing is in-flight.

### Rate Limiting (API-10)
- **D-18:** `@fastify/rate-limit` plugin, keyed by IP:
  - `POST /api/inbox`: 5/min, 50/hr per IP
  - `GET /api/inbox/:id`: 60/min per IP
  - `GET /api/inbox/:id/messages`: 120/min per IP
  - `GET /api/inbox/:id/messages/:msgId`: 120/min per IP
  - `GET /api/inbox/:id/stream`: 10/min per IP (per-connection)
  - `GET /api/attachments/:id`: 60/min per IP
- **D-19:** Rate-limit storage: in-memory by default (single-process deployment per STACK). Externalizable via `@fastify/rate-limit` redis option later if needed.
- **D-20:** When rate-limited, respond `429` with `Retry-After: <seconds>`. Increment `abuse_counters` via Core extension (planner: add `core.recordAbuse({ipPrefix, bucket})` passthrough).

### Security Headers (API-11)
- **D-21:** `@fastify/helmet` with explicit config:
  - `contentSecurityPolicy: false` — API endpoints don't serve HTML; Caddy sets CSP for the static frontend
  - `frameguard: { action: 'deny' }`
  - `hsts: { maxAge: 31536000, includeSubDomains: true }` (respected at edge — Caddy terminates TLS)
  - `noSniff: true`
  - `referrerPolicy: { policy: 'no-referrer' }`
  - `crossOriginOpenerPolicy: { policy: 'same-origin' }`
  - `crossOriginResourcePolicy: { policy: 'same-origin' }`

### Validation
- **D-22:** Zod schemas for request params/body/response. Register via Fastify's native JSON Schema (convert via `zod-to-json-schema` OR use `fastify-type-provider-zod`). Planner picks.
- **D-23:** Validate `:id` matches inbox ID shape (nanoid 22 alphabet) BEFORE hitting Core — 400 on malformed.

### Error Responses
- **D-24:** JSON error envelope: `{ error: { code: 'string', message: 'string' } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `invalid_request`, `server_error`.
- **D-25:** Never leak internals — stack traces stripped in production. `logger.error` captures full details off-wire.
- **D-26:** Never distinguish `not_found` vs `forbidden` publicly for the stream endpoint — use `403` for both to fully match Core's enumeration-safe listMessages contract. Actually: keep `403/404` split as Core delivers it; the attacker already knows the inbox exists because they just tried to open the stream with the id.

### Testing
- **D-27:** Vitest + `fastify.inject()` for unit tests on routes (no network). Use real Core with in-memory DB + tmpdir attachment store.
- **D-28:** SSE tests via `fetch()` against a real listening server on ephemeral port, reading event-stream chunks.
- **D-29:** Cover: mint → cookie set; subsequent request with cookie succeeds; without cookie → 401; wrong cookie → 403; stream replays pre-existing messages, then live events arrive; reconnect with `Last-Event-ID` skips already-delivered; rate-limit → 429; attachment download streams bytes correctly; helmet headers present; invalid ID → 400.

### Claude's Discretion
- Zod vs JSON Schema directly (default: Zod via `fastify-type-provider-zod`)
- Exact error code taxonomy beyond D-24's minimum
- Whether to split routes into separate plugins or one `routes/index.ts`

</decisions>

<specifics>
## Specific Ideas

- Cookie-per-inbox (D-05 `tempmail_vt_<inboxId>`) handles the "multiple tabs" UX naturally. Alternative of one cookie holding a map of tokens gets ugly on reset.
- SSE over Fastify is a known footgun (default serializer escapes data). Using `reply.raw` directly is the documented escape hatch.
- Replay-on-subscribe at the HTTP layer (D-16) complements Phase 3's emit-after-commit — together they close the race.

</specifics>

<canonical_refs>
## Canonical References

### Roadmap and requirements
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md` §API, §RT
- `.planning/ROADMAP.md` §Phase 5

### Research
- `.planning/research/STACK.md` §HTTP
- `.planning/research/ARCHITECTURE.md` §HTTP+SSE + replay-on-subscribe
- `.planning/research/PITFALLS.md` §Race, §XSS

### Phase 3 Core API (consume)
- `core.createInbox`, `core.listMessages`, `core.bus`, Core types
- Core extensions planner may add: `core.getInbox(id)`, `core.getMessage(inboxId, msgId)`, `core.recordAbuse({ipPrefix, bucket})`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 3 Core — entire business layer consumed via DI.
- Phase 2 attachment store — streamed reads via `readAttachment(sha256)`.
- Phase 1 pino logger.

### Patterns
- Factory + deps. Invariant: no direct `better-sqlite3` or `node:fs` in `src/http/*` except through Core / attachmentStore.

### Gotchas
- SSE + Fastify's reply: use `reply.raw` + `reply.hijack()` to bypass the serializer and keepalive the socket.
- Windows bind to 127.0.0.1 works fine without admin at non-privileged ports.
- `@fastify/rate-limit` counts per key; default key is `request.ip` — respect `trustProxy` so IPs are read from `X-Forwarded-For` behind Caddy.
- `fastify.inject()` does NOT support SSE well — use real listen for those tests.

</code_context>

<deferred>
## Deferred Ideas
- OpenAPI spec generation (v1.x)
- CORS for third-party API consumers (v2)
- WebSocket alternative to SSE (no — SSE is locked)
- Per-route metrics endpoint (v2)
</deferred>
