---
phase: 05-http-api-sse
status: complete
plans_completed: [05-01, 05-02, 05-03, 05-04, 05-05, 05-06]
plans_total: 6
started: 2026-04-19
completed: 2026-04-19

requirements-completed: [API-01, API-02, API-03, API-04, API-05, API-06, API-07, API-08, API-09, API-10, API-11, RT-01, RT-02, RT-03]

provides:
  - "src/http/server.ts — createHttpServer(deps) → FastifyInstance"
  - "src/http/errors.ts — HTTP_ERROR_CODES + sendError envelope helper"
  - "src/http/schemas.ts — zod param schemas (id, inboxIdParam, messageIdParam)"
  - "src/http/sse.ts — formatEventId, parseLastEventId, serializeEvent, serializeHeartbeat"
  - "src/http/plugins/helmet.ts — D-21 config"
  - "src/http/plugins/rate-limit.ts — 429 envelope + abuse hook + bucketForPath, ipToPrefix"
  - "src/http/plugins/auth.ts — cookieNameFor, authorizeInbox decorator, viewTokenCookieOptions"
  - "src/http/routes/inbox.ts — POST + GET /api/inbox"
  - "src/http/routes/messages.ts — list + single message"
  - "src/http/routes/attachments.ts — scoped attachment download + formatContentDisposition"
  - "src/http/routes/stream.ts — SSE with replay + heartbeat"
  - "Core extensions: getInbox, verifyInboxAccess, getMessage, getAttachmentForInbox, recordAbuse"

consumed_by: [07-frontend-svelte-static, 08-deployment-docker-caddy]

invariants:
  - "D-03 boundary: no 'better-sqlite3' or 'node:fs' imports under src/http/ (verified by grep)"
  - "D-06: viewToken is cookie-only — never in body, query, or path"
  - "D-15: SSE event id = <receivedAtMs>-<messageId>; Last-Event-ID parsed as numeric prefix"
  - "D-16: SSE replay runs BEFORE live bus subscription (race-closed)"
  - "D-18: per-route rate limits — 5/min mint, 60/min meta+attach, 120/min read, 10/min stream"
  - "D-20: 429 increments core.abuse_counters via core.recordAbuse"
  - "D-21: helmet CSP off (API serves JSON/SSE/octet), frameguard deny, HSTS, noSniff, no-referrer, same-origin COOP/CORP"
  - "D-24: every error body is { error: { code, message } } — enumeration-safe (cross-inbox probes → 404, not 403)"

tests:
  phase-5-new: 50
  cumulative: 189
  files-new: 9
  files-cumulative: 33
---

# Phase 5: HTTP API + SSE Summary

**Fastify 5 HTTP server exposing the REST + SSE surface for the tempmail service. Binds 127.0.0.1 behind Caddy (Phase 8); 14 Phase 5 requirements closed (API-01..11, RT-01..03); 50 new tests across 9 files bring the project total to 189.**

## Completion Summary

| Plan  | Name | Commits | Tests added |
|-------|------|---------|-------------|
| 05-01 | Scaffolding | 1 (deps) | 0 |
| 05-02 | Server bootstrap + auth + Core extensions | 7 (2 Core, 1 errors/schemas, 3 plugins, 1 server, 1 test) | 7 |
| 05-03 | Inbox routes | 3 | 7 |
| 05-04 | Message + attachment routes | 5 | 14 |
| 05-05 | SSE stream | 5 | 8 |
| 05-06 | Rate-limit envelope + abuse | 3 | 11 |
| **Phase total** | | **24 commits** | **50 new / 189 cumulative** |

## API Surface

External callers (Phase 7 frontend, end-users) call `createHttpServer` exactly once at startup with the shared Core + attachment store:

```typescript
import { createHttpServer } from 'src/http/server.js';

const app = await createHttpServer({
  core,                // from createCore(deps)
  attachmentStore,     // from createAttachmentStore(rootDir)
  config: {
    cookieSecret: '...',
    hardTtlMs: 60 * 60_000,
    trustProxy: true,
  },
  logger: pinoInstance, // optional
});

await app.listen({ host: '127.0.0.1', port: 8080 });
```

### Endpoint table

| Method | Path | Auth | Rate limit | Purpose |
|--------|------|------|------------|---------|
| GET | `/healthz` | none | none | Liveness probe |
| POST | `/api/inbox` | none | 5/min | Mint a new inbox; sets cookie |
| GET | `/api/inbox/:id` | cookie | 60/min | Inbox metadata (address, timestamps, messageCount) |
| GET | `/api/inbox/:id/messages` | cookie | 120/min | Message list (metadata only, ASC) |
| GET | `/api/inbox/:id/messages/:msgId` | cookie | 120/min | Single message (bodies + attachment metadata) |
| GET | `/api/inbox/:id/attachments/:attId` | cookie | 60/min | Streamed attachment bytes |
| GET | `/api/inbox/:id/stream` | cookie | 10/min | SSE: replay + live + heartbeat |

### Error envelope (every error response)

```json
{ "error": { "code": "unauthorized|forbidden|not_found|rate_limited|invalid_request|server_error", "message": "string" } }
```

### Cookie contract (API-09, D-05)

- Name: `tempmail_vt_<inboxId>` — scoped per inbox so multiple tabs / inboxes coexist.
- Attributes: `HttpOnly`, `SameSite=Lax`, `Secure: 'auto'` (set by @fastify/cookie when behind HTTPS), `Path=/api/inbox/<inboxId>`, `Max-Age=<hardTtlMs / 1000>`.
- View-token is plaintext in the cookie; the DB stores only `sha256(viewToken)`.
- Cookie-only: view-token NEVER appears in URL, query, or response body.

## SSE Contract

`GET /api/inbox/:id/stream` returns `text/event-stream` with these rules:

### Frame format

```
id: <receivedAtMs>-<messageId>\n
event: message\n
data: <FullMessageView JSON>\n
\n
```

Heartbeat (every 15s):

```
: heartbeat <epochMs>\n
\n
```

### Reconnect behavior (RT-02, API-06)

On connect, the server:

1. Parses `Last-Event-ID` request header as a number (falls back to 0 on malformed).
2. Calls `core.listMessages({ inboxId, viewToken })`, filters by `receivedAt > lastEventId`.
3. Writes each filtered message as an SSE event.
4. **Then** subscribes to `core.bus.on('message', ...)` for live events.

This closes the "message arrived between SMTP accept and SSE subscribe" race (RT-03, D-16) and makes reconnect idempotent at the message-id level.

### Headers

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Cleanup

`request.raw.on('close')` + `'aborted'` → clear heartbeat interval + unsubscribe from bus + end raw response.

### Backpressure

`reply.raw.write()` return value honored; writer awaits `drain` before the next write. Heartbeat is skipped if a replay / live write is in-flight (D-17).

## Test Coverage Mapping

Each requirement is closed by the listed test(s).

| Requirement | Description | Test(s) |
|-------------|-------------|---------|
| API-01 | POST /api/inbox mints and returns `{address, expiresAt}` | `tests/http/inbox-routes.test.ts` — "mints an inbox, returns 201, sets cookie" |
| API-02 | GET /api/inbox/:id returns metadata | `tests/http/inbox-routes.test.ts` — "returns metadata with the right cookie" |
| API-03 | GET /api/inbox/:id/messages chronological | `tests/http/messages-routes.test.ts` — "empty inbox returns []" + "returns ASC chronological metadata without bodies" |
| API-04 | GET /api/inbox/:id/messages/:msgId full message | `tests/http/messages-routes.test.ts` — "returns the full message (bodies + attachment metadata)" + "serves htmlBody verbatim" |
| API-05 | GET /api/inbox/:id/stream SSE with Last-Event-ID | `tests/http/sse-integration.test.ts` — "Last-Event-ID skips already-delivered messages on reconnect" |
| API-06 | Replay-on-subscribe | `tests/http/sse-integration.test.ts` — "replays pre-existing messages before live events arrive" |
| API-07 | 15s heartbeat | Configured in `registerStreamRoute({ heartbeatMs: 15_000 })`; `serializeHeartbeat` unit-tested in `tests/http/sse-unit.test.ts`. |
| API-08 | GET attachment streams with Content-Disposition + nosniff | `tests/http/attachments-routes.test.ts` — "streams bytes with correct headers" + 4 `formatContentDisposition` cases |
| API-09 | HttpOnly + SameSite=Lax + Secure cookie, never in URL | `tests/http/inbox-routes.test.ts` — "mints an inbox, returns 201, sets cookie" + "body does NOT include viewToken" |
| API-10 | @fastify/rate-limit on every public route | `tests/http/rate-limit.test.ts` — "mint 6th request in 1 minute returns 429 ..." |
| API-11 | @fastify/helmet headers | `tests/http/server.test.ts` — "applies helmet headers" |
| RT-01 | EventSource delivers messages without refresh | Covered by API-05 + API-06 integration tests (real `.listen()` + fetch). |
| RT-02 | Last-Event-ID reconnect | `tests/http/sse-integration.test.ts` — "Last-Event-ID skips already-delivered messages on reconnect" |
| RT-03 | Race-window safe | `tests/http/sse-integration.test.ts` — "replays pre-existing messages before live events arrive" |

## Architectural Commitments (Locked)

1. **Single factory** — `createHttpServer(deps)` is the only public entry into `src/http/`. Internals (`server.ts` → plugins → routes) are wired exactly once.
2. **D-03 boundary** — No `better-sqlite3`, no `node:fs` under `src/http/**`. Verified by grep at phase-close. All I/O flows through `core.*` and `attachmentStore.readAttachment(sha256)`.
3. **Cookie-only view-token** (D-06) — The cookie is the single channel for auth. URL, query, body never carry it.
4. **Cookie per inbox** (D-05) — `tempmail_vt_<inboxId>` with `Path=/api/inbox/<inboxId>` means the browser sends exactly one token per request, scoped to the inbox being addressed. Multi-tab / multi-inbox is natural.
5. **Envelope invariant** (D-24) — Every error response is `{error:{code,message}}`; enumeration-safe (cross-inbox probes → 404 via Core's `not_found` path).
6. **Replay-before-subscribe** (D-16) — SSE reads stored messages with `receivedAt > lastEventId` before attaching to the bus. Combined with Phase 3 D-11 (emit-after-commit), closes the race.
7. **No direct 429 construction** — The rate-limit plugin owns the 429 envelope via `errorResponseBuilder`; routes never manually 429. `core.recordAbuse` is the single abuse-accounting hook.
8. **Streamed attachments** — Bytes flow via `attachmentStore.readAttachment(sha)` (which is a Readable). No buffer in RAM at the HTTP layer.

## Open Items for Phase 7 (Frontend Contract)

The frontend (SvelteKit) consumes this API. Contract guarantees for its implementation:

1. **Mint**: `POST /api/inbox` with no body. 201 response; body has `address` + `expiresAt`; cookie is auto-attached by the browser. Fetch with `credentials: 'include'` if served from a different origin; same-origin under Caddy needs nothing special.
2. **List**: `GET /api/inbox/:id/messages` — returns `{messages: MessageView[]}` ASC. Use `hasTextBody` / `hasHtmlBody` for icon badges without loading bodies.
3. **Read**: `GET /api/inbox/:id/messages/:msgId` — returns `FullMessageView`. `htmlBody` is already sanitized (Phase 4 did it); render in a sandboxed iframe per UI-07. `textBody` is plain text.
4. **Stream**: `new EventSource('/api/inbox/:id/stream')`. Auto-reconnect + `Last-Event-ID` handled by the browser. Parse `event.data` as JSON of `FullMessageView`.
5. **Attachment**: `GET /api/inbox/:id/attachments/:attId` — anchor tag with `download` attribute works (server sets `Content-Disposition: attachment`).
6. **429 handling**: response body is `{error:{code:'rate_limited',message}}` and `Retry-After` header present. Show a "slow down" toast.
7. **401/403/404**: show different UI — 401 means "no cookie, re-mint?"; 403 means "wrong token, your bookmark is stale"; 404 means "inbox expired or never existed".

## Deferred Items

- **`/api/attachments/:id` unscoped convenience route** — deferred to v2; path-scoped `/api/inbox/:id/attachments/:attId` is canonical.
- **CORS for third-party origins** — deferred (STACK + REQUIREMENTS §API say v2 only).
- **OpenAPI generation** — deferred (v1.x).
- **WebSocket alternative to SSE** — rejected (SSE locked by D-14..17).
- **Per-route metrics endpoint** — deferred (v2).

## Invariant Verification at Phase Close

- `npm run typecheck` — **exit 0**
- `npx biome check src/http tests/http` — **clean**
- `npx vitest run` — **189/189 across 33 files**
- `grep -rE 'better-sqlite3|node:fs' src/http/` — **no matches**
- Phase 4 (SMTP) suite unaffected by Phase 5 work.

## Self-Check: PASSED

- All 11 src/http files present (1 server + 3 plugins + 4 routes + 1 sse + 1 errors + 1 schemas)
- All 9 tests/http files present (support + server + auth + inbox + messages + attachments + sse-unit + sse-integration + rate-limit)
- All 6 plan SUMMARY files present (05-01..06)
- This phase summary present
- `npm run typecheck` — exit 0
- `npm run check` — exit 0
- `npm test` — exit 0 (189/189)

---
*Phase 05-http-api-sse: complete*
*Closes API-01..11 + RT-01..03 (14 requirements)*
*Completed: 2026-04-19*
