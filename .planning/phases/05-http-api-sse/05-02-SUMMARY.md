---
plan: 05-02
status: complete
requirements: [API-01, API-02, API-09, API-10, API-11]
commits: [44471df, 1839ebd, 4787f9e, 611bf74, b16582e, 6e17cbf, 9d04048, a49_support_test_commit]
tests_added: 7
---

# Plan 05-02 — Server bootstrap, auth plugin, helmet, Core extensions

Extended Core with five passthroughs consumed by Phase 5 routes; stood up an empty Fastify factory with the security plugin stack; added a cookie-based `authorizeInbox` decorator.

## Core extensions (respects D-03)

All zero-DB-direct access, all go through `deps.repos.*`.

- `core.getInbox(inboxId) → { ok: true, inbox: InboxView } | { ok: false, reason: 'not_found' }` — used by `GET /api/inbox/:id`. Includes message count.
- `core.verifyInboxAccess(inboxId, viewToken) → { ok: true, row } | { ok: false, reason: 'not_found' | 'forbidden' }` — the auth plugin's cheap pre-flight.
- `core.getMessage({ inboxId, messageId, viewToken }) → { ok: true, message: FullMessageView } | { ok: false, reason }` — used by `GET /api/inbox/:id/messages/:msgId`. Cross-inbox access returns `not_found` (no enumeration leak).
- `core.getAttachmentForInbox({ inboxId, attachmentId, viewToken }) → { ok: true, attachment: AttachmentDescriptor } | { ok: false, reason }` — ownership-checked attachment lookup. `sha256` on descriptor only for HTTP layer; never sent to client.
- `core.recordAbuse({ ipPrefix, bucket }) → number` — new `src/core/abuse.ts`. Floors `now()` to 60s, calls `repos.abuse.incrementCounter`.

## HTTP files added

- `src/http/errors.ts` — `HTTP_ERROR_CODES`, `sendError(reply, code, message)`
- `src/http/schemas.ts` — `idSchema`, `inboxIdParam`, `messageIdParam`, `attachmentIdParam`, `errorResponseSchema`
- `src/http/plugins/helmet.ts` — D-21 config
- `src/http/plugins/rate-limit.ts` — 429 envelope + `onExceeded → core.recordAbuse`, `bucketForPath`, `ipToPrefix`
- `src/http/plugins/auth.ts` — cookie-per-inbox guard; `authorizeInbox(inboxId)` decorator; `viewTokenCookieOptions(inboxId, hardTtlMs)`
- `src/http/server.ts` — `createHttpServer({ core, attachmentStore, config, logger }) → FastifyInstance`; registers helmet → rate-limit → auth → sensible → `/healthz` → (routes, landed in 05-03..05)

## Tests added (7)

- `tests/http/support.ts` — `buildTestRig({ ready? })` harness
- `tests/http/server.test.ts` — 3 cases (healthz; helmet headers; 404 unknown route)
- `tests/http/auth.test.ts` — 4 cases (missing cookie → 401; wrong cookie → 403; right cookie → 200; unknown inbox → 404)

## Gates

- `npm run typecheck` — exit 0
- `npx biome check src/http src/core` — clean
- `npx vitest run tests/http tests/core` — 61/61
