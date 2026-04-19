---
plan: 05-05
status: complete
requirements: [API-05, API-06, API-07, RT-01, RT-02, RT-03]
commits: [d6480bf, 49da2cf, 29250b3, 939d9cc, b7373e3]
tests_added: 8
---

# Plan 05-05 — SSE stream with replay-on-subscribe + heartbeat

## Files

- `src/http/sse.ts` — `formatEventId`, `parseLastEventId`, `serializeEvent`, `serializeHeartbeat`.
- `src/http/routes/stream.ts` — `GET /api/inbox/:id/stream`.

## Endpoint

### GET /api/inbox/:id/stream (SSE)

- Auth: cookie. Rate-limit: 10/min per IP.
- Hijacks `reply.raw` and writes `text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Each event frame: `id: <receivedAtMs>-<messageId>\nevent: message\ndata: <json>\n\n`.
- Heartbeat every 15s (override via `heartbeatMs`); emitted as a `: heartbeat <ts>\n\n` comment.
- Replay: on connect, queries `core.listMessages`, filters by `receivedAt > lastEventId`, writes each as an SSE event **before** subscribing to the bus (D-16). Closes the race window called out in RT-03.
- Last-Event-ID: numeric prefix before the first hyphen (`parseLastEventId` also handles `100` and malformed fallback → 0).
- Backpressure: `write()` waits for `drain` when the socket is full; heartbeat skips while a write is in-flight (D-17).
- Cleanup: on `request.raw.on('close'|'aborted')`, clears heartbeat interval + unsubscribes from bus + ends response.

## Tests (8)

- `tests/http/sse-unit.test.ts` — 5 cases: `formatEventId`, `serializeEvent`, frame trailing newlines, `serializeHeartbeat`, `parseLastEventId` variants.
- `tests/http/sse-integration.test.ts` — 3 cases (uses `undici.fetch` + a real `.listen()` on 127.0.0.1:0):
  - 401 without cookie.
  - Replay-on-subscribe: pre-existing message arrives before a live message (race-safe).
  - Last-Event-ID on reconnect skips already-delivered messages.

## Gates

- `npm run typecheck` — 0
- `npx biome check src/http tests/http` — clean
- `npx vitest run tests/http` — 36/36
