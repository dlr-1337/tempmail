---
plan: 05-04
status: complete
requirements: [API-03, API-04, API-08, API-10]
commits: [0f6456e, f625b21, 4494af3, 9c97b8d, 7d64746]
tests_added: 14
---

# Plan 05-04 — Message routes + attachment streaming

## Endpoints

### GET /api/inbox/:id/messages

- Auth: cookie. Rate-limit: 120/min.
- 200 → `{ messages: MessageView[] }` — ASC chronological; no bodies (`hasTextBody` / `hasHtmlBody` booleans only).

### GET /api/inbox/:id/messages/:msgId

- Auth: cookie. Rate-limit: 120/min.
- 200 → `FullMessageView` = `{ id, receivedAt, sender, subject, textBody, htmlBody, sizeBytes, attachments }`.
- 404 when the message's `inbox_id` doesn't match `:id` (no cross-inbox leak).

### GET /api/inbox/:id/attachments/:attId

- Auth: cookie. Rate-limit: 60/min.
- Path chosen to keep the per-inbox cookie scope (`/api/inbox/<id>`) valid. Convenience alias `/api/attachments/:id` deferred to v2.
- Headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="..."` (RFC 5987 `filename*` for non-ASCII), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Length`.
- Streams bytes directly from `attachmentStore.readAttachment(sha256)` — no buffer in RAM.

## `formatContentDisposition` (RFC 5987)

Exported for test parity. ASCII filenames → plain `filename="..."`; non-ASCII → dual `filename="asciifallback"; filename*=UTF-8''percent-encoded`; null → `attachment`; quotes/backslashes in ASCII fallback replaced with `_`.

## Tests (14)

- `tests/http/messages-routes.test.ts` — 7 cases: empty list, ASC order without bodies, 401+403, single happy path, 404 unknown, 404 cross-inbox, htmlBody verbatim.
- `tests/http/attachments-routes.test.ts` — 7 cases: streams bytes + headers, 401+404 unknown, 404 cross-inbox, 4 `formatContentDisposition` cases.

## Gates

- `npm run typecheck` — 0
- `npx biome check src/http` — clean
- `npx vitest run tests/http` — 28/28
