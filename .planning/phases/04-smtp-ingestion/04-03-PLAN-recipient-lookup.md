---
phase: 4
plan: 3
status: ready
type: execute
wave: 3
depends_on: [2]
requirements: [SMTP-04]
files_modified:
  - src/core/inboxes.ts
  - src/core/index.ts
  - src/smtp/recipient.ts
  - src/smtp/server.ts
  - tests/core/find-inbox-by-address.test.ts
autonomous: true
tags: [smtp, core-extension, rcpt, 550]
---

## Goal

Implement the `onRcptTo` handler. Per D-15, extend Core with a single thin passthrough helper (`findInboxByAddress(localPart, domain)`) and consume it from SMTP. No catch-all: unknown recipients get `550 5.1.1 Unknown recipient`; wrong-domain gets `550 Relay access denied`.

## Must-have checklist (requirement IDs)

- SMTP-04: `onRcptTo` rejects unknown recipients with 550 (no catch-all)
- D-14: address parsing rejects malformed `address.address` values (no `@`, multiple `@`, empty parts)
- D-15: Core extension point added — `core.findInboxByAddress(localPart, domain)` delegates to `repos.inboxes.findInboxByLocalPart` without leaking repo internals.
- Domain mismatch to `config.domain` returns 550 before DB hit.
- Unit test in `tests/core/find-inbox-by-address.test.ts` covers found/not-found.

## Tasks

1. Extend `createInboxes(deps)` in `src/core/inboxes.ts` to return a third API method `findInboxByAddress(localPart: string, domain: string): { id: string; localPart: string; domain: string } | null`. It is a thin passthrough to `deps.repos.inboxes.findInboxByLocalPart` that maps the row shape into a neutral public type.
2. Expose on `CoreApi` via `src/core/index.ts`: add `findInboxByAddress` to the surface, wire through from `inboxes`.
3. Write `src/smtp/recipient.ts` — exports `buildOnRcptTo({ core, config, limiter?, log })` returning the handler. Logic:
   - Lowercase domain compare to `config.domain`; mismatch → `cb(error)` with `.responseCode = 550`.
   - Parse/validate local-part (non-empty, no additional `@`).
   - `core.findInboxByAddress(local, config.domain)` → found ? `cb()` : `cb(new Error('550 5.1.1 Unknown recipient'))`.
4. Wire the handler into `server.ts` via the deps the plan 04-02 factory already exposes.
5. Add `tests/core/find-inbox-by-address.test.ts` covering: existing inbox returns the neutral view; missing inbox returns null; wrong domain returns null.
6. `<automated>` verify: `npm run typecheck && npm run check && npm test -- tests/core`.

Commits:
- `feat(03-core): expose findInboxByAddress on Core (Phase 4 extension)`
- `test(03-core): cover findInboxByAddress lookup`
- `feat(04-smtp): implement onRcptTo with 550 for unknown / wrong-domain`

## Verification

- Tests pass for new Core helper.
- Server-level test (added in plan 04-06) drives a real smtp-connection client that sees a 550 for unknown recipients.
