---
plan: 05-03
status: complete
requirements: [API-01, API-02, API-09, API-10]
commits: [6eab61f, fb29fdf, d47c192]
tests_added: 7
---

# Plan 05-03 — Inbox routes (mint + metadata)

Shipped `POST /api/inbox` and `GET /api/inbox/:id`.

## Endpoints

### POST /api/inbox

- No body.
- Rate-limit: 5/min per IP.
- 201 → `{ address: string, expiresAt: number }`.
- Cookie set: `tempmail_vt_<inboxId>`, `HttpOnly`, `SameSite=Lax`, `Path=/api/inbox/<inboxId>`, `Max-Age=<hardTtlMs/1000>`.
- Body never contains `viewToken` (D-06).

### GET /api/inbox/:id

- Auth: cookie required.
- Rate-limit: 60/min per IP.
- 200 → `{ address, createdAt, lastActivityAt, expiresAt, messageCount }`.
- 400 on malformed id (zod guard before Core contact — D-23).
- 401 missing cookie, 403 wrong token, 404 unknown inbox.

## Tests (7)

Files: `tests/http/inbox-routes.test.ts`.

- Mint: 201, cookie attributes, no `viewToken` in body.
- Metadata: happy path, 401, 403, 404, 400.

## Gates

- `npm run typecheck` — 0
- `npx biome check src/http` — clean
- `npx vitest run tests/http/inbox-routes.test.ts` — 7/7
