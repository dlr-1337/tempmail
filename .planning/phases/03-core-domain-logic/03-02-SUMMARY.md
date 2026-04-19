---
phase: 03-core-domain-logic
plan: 02
subsystem: core
tags: [core, inboxes, view-token, hashing, timing-safe, expire, orphan-safe]
depends_on: [03-01]

# Dependency graph
requires:
  - phase: 02-storage-layer
    provides: "Repos aggregate (inboxes/messages/attachments), AttachmentStore, withTransaction, InboxRow, newId, nowMs"
  - phase: 03-core-domain-logic
    plan: 01
    provides: "Phase 3 conventions for core module layout, Vitest patterns, commit style"
provides:
  - "src/core/inboxes.ts — createInboxes(deps) factory returning { createInbox, expireInbox, verifyViewToken }"
  - "Standalone verifyViewToken(row, token) export for plan 03-03 reuse (single source of truth for D-15)"
  - "Discriminated-union results per D-19 (CreateInboxResult, ExpireInboxResult)"
  - "Orphan-safe expire: pre-delete sha collection + post-commit unlink only for non-referenced blobs"
  - "Transactional delete via withTransaction — a mid-delete throw leaves DB + disk unchanged"
affects: [03-03-messages, 03-04-composition-root, 06-retention-sweeper]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory-returning-bound-functions (createInboxes(deps) → InboxesApi, mirrors repo pattern)"
    - "SHA-256 hex digest + timingSafeEqual over 32-byte buffers for secret comparison"
    - "Two-phase expire: read-only collect → transactional delete → post-commit orphan unlink"
    - "Discriminated-union results ({ ok: true, ... } | { ok: false, reason: '...' }) for expected business errors"
    - "node:crypto direct import (lazy-import not needed — hashing is on the hot path anyway)"

key-files:
  created:
    - src/core/inboxes.ts
    - tests/core/inboxes.test.ts
  modified: []

key-decisions:
  - "D-04 reuse: local-part generated via newId() (nanoid 22 = 132 bits) — no separate 16-char base32 alphabet needed."
  - "D-06 view-token: independent 22-char nanoid, SHA-256 hex in DB, timingSafeEqual compare over 32-byte buffers."
  - "D-07 one-time token: plaintext returned from createInbox() once; DB only ever sees the hash."
  - "D-17 orphan-safe unlink: collect candidate shas BEFORE the delete cascade, then post-commit call unlinkBySha256 only for shas not in listAllSha256s()."
  - "D-19 error model: expireInbox returns { ok: false, reason: 'not_found' } for unknown ids; createInbox has no expected-error branch."
  - "D-20 programmer error: identical id() collision throws (probability 2^-132 with nanoid — treated as broken RNG)."
  - "verifyViewToken is exported both standalone AND on the api object — plan 03-03's listMessages imports the standalone symbol, plan 03-04's composition root re-exports via the api."

patterns-established:
  - "All core modules depend on Repos/AttachmentStore/Db/Config — never better-sqlite3, node:fs, or raw db.prepare/db.exec (verified via grep in plan gate)."
  - "Vitest cases that need filesystem use withTmpDir + real createAttachmentStore — don't stub the store when orphan-safety is under test."
  - "Inject now + id via optional deps for deterministic test cases; fall through to nowMs/newId in production."

requirements-completed: [CORE-01, CORE-02, CORE-05]

# Metrics
duration: ~20min
completed: 2026-04-18
tasks_completed: 3
files_created: 2
---

# Phase 3 Plan 02: Inboxes Domain Logic Summary

**Protocol-agnostic `createInboxes(deps)` factory — mints ≥132-bit nanoid local-parts, issues independent view-tokens stored as SHA-256 hex (plaintext returned exactly once), and provides a transactional `expireInbox` that collects candidate attachment shas before the FK-CASCADE delete and post-commit unlinks only orphaned blobs via `attachmentStore.unlinkBySha256`.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-18T~11:05Z
- **Completed:** 2026-04-18T~11:15Z
- **Tasks:** 3 (2 code + 1 gate)
- **Files modified:** 2 (created)

## Accomplishments

- `createInboxes(deps)` factory returning `{ createInbox, expireInbox, verifyViewToken }`.
- `createInbox()` returns `{ ok: true, inboxId, address, viewToken, expiresAt, hardExpiresAt }` with `address = ${localPart}@${config.domain}`.
- Standalone `verifyViewToken(row, token)` export — single source of truth for constant-time compare, ready for plan 03-03's `listMessages` to import directly.
- `expireInbox({ inboxId })` → `{ ok: true, deletedMessages, unlinkedAttachments } | { ok: false, reason: 'not_found' }`.
- Orphan-safe unlink: candidate shas collected pre-delete, `withTransaction` wraps the cascade, post-commit loop skips shas still in `listAllSha256s()`.
- Clock + id generator injectable for test determinism; defaults to `nowMs` / `newId` in production.
- 9-case Vitest suite covering address entropy, token hashing, config.domain usage, determinism, verifyViewToken accept/reject, not_found branch, orphan unlink, multi-inbox sha sharing, zero-message inbox, and transaction rollback on throw.

## Task Commits

Each task was committed atomically on branch `gsd/phase-02-storage-layer`:

1. **Task 1: Implement createInbox + verifyViewToken + expireInbox** — `d647b71` (feat)
2. **Task 2: Vitest coverage** — `8480762` (test)
3. **Task 3: Plan-level gate** — no commit (verification-only; no file changes)

**Plan metadata commit:** pending (docs commit wraps this file).

## Files Created/Modified

- `src/core/inboxes.ts` — 182 lines. Exports `createInboxes`, `verifyViewToken` (standalone), and types `InboxesApi`, `InboxesDeps`, `InboxesConfig`, `CreateInboxResult`, `ExpireInboxResult`.
- `tests/core/inboxes.test.ts` — 304 lines, 9 test cases across 2 `describe` blocks.

## Verification Results

All three gates exit 0:

- `npm run typecheck` — 0 errors.
- `npm run check` — Biome clean across 35 files.
- `npx vitest run` — 66/66 tests pass (57 pre-existing + 9 new in `tests/core/inboxes.test.ts`).
- `npx vitest run tests/core/inboxes.test.ts` — 9/9 pass individually (~37ms).

Plan's end-to-end greps also clean:

- No `better-sqlite3` imports under `src/core/`.
- No `node:fs` imports under `src/core/`.
- No `db.prepare(` or `db.exec(` under `src/core/`.

## Decisions Made

- Followed the plan's `<action>` code blocks verbatim — the plan was specified tightly enough that no implementation latitude was needed.
- Added the plan-recommended defensive length check (`candidate.length !== stored.length`) in `verifyViewToken` even though sha256 digests are always 32 bytes, as belt-and-suspenders against a future hash-algo swap.
- Added `id()` call-count assertion in the deterministic-injection test (`expect(id).toHaveBeenCalledTimes(2)`) — catches a regression where a future refactor adds a third `id()` call (e.g. for an attachment id accidentally minted here).
- Added a sibling assertion in the multi-inbox sha-sharing test (`expect(repos.inboxes.findInboxById(b.inboxId)).toBeDefined()`) to prove inbox B survives A's expiration.
- Included `inboxes.verifyViewToken(row, ...)` assertions alongside the standalone-function assertions — confirms the api-object export is wired to the same implementation, not a divergent reimplementation.

## Deviations from Plan

None functional. Only authored-choice augmentations (non-deviations) are the three extra assertions listed under "Decisions Made" — they strengthen existing test cases without adding new cases or changing the module surface.

## Issues Encountered

- None. Typecheck and Biome were clean on the first run. All 9 Vitest cases passed on first run without debugging.

## User Setup Required

None — no external services, no env vars, no dashboard configuration.

## Next Phase Readiness

- **Plan 03-03 (`messages`)** can import `verifyViewToken` directly from `src/core/inboxes.js` for `listMessages`'s wrong-token → forbidden branch (D-15). Same timing-safe compare, no duplication.
- **Plan 03-04 (composition root)** can call `createInboxes({ db, repos, attachmentStore, config, bus })` and pass the factory output through to the HTTP/SMTP adapter layers. The `bus` field is not yet on `InboxesDeps` — plan 03-04 or 03-03 may extend it (current plan didn't require it).
- **Phase 6 sweeper** will call `expireInbox({ inboxId })` per expired row from `repos.inboxes.listExpired(cutoff, limit)`.
- No blockers. Plan 03-03 (messages) can proceed immediately.

## Known Stubs

None. Every code path in `src/core/inboxes.ts` has a real implementation and test coverage. No TODOs, no placeholder data, no mocked return values leaking into the module.

## Threat Flags

None new. This plan implements the mitigations listed in CORE-02 (view-token separation), CORE-05 (cascade expiry with on-disk cleanup), and D-06 (hashed storage of secret credentials):

- View-token never appears in the public address (address local-part and view-token are two independent nanoids).
- DB leak exposes only SHA-256 hashes; attacker must brute-force via online oracle.
- `timingSafeEqual` eliminates the token-length and byte-by-byte timing oracle.
- `expireInbox` guarantees the retention promise: message rows + attachment rows + on-disk blobs all removed when the inbox is destroyed, with cross-inbox dedup preserved.

No new network surface, no new auth path, no schema changes.

## Self-Check: PASSED

- `src/core/inboxes.ts` — FOUND
- `tests/core/inboxes.test.ts` — FOUND
- `.planning/phases/03-core-domain-logic/03-02-SUMMARY.md` — FOUND (this file)
- Commit `d647b71` (feat(core)) — FOUND in `git log`
- Commit `8480762` (test(core)) — FOUND in `git log`
- `npm run typecheck` — exit 0
- `npm run check` — exit 0 (35 files)
- `npx vitest run` — exit 0 (66/66 tests)
- Forbidden-imports grep — all three checks empty (no `better-sqlite3`, `node:fs`, `db.prepare|db.exec` under `src/core/`)

---
*Phase: 03-core-domain-logic*
*Plan: 02*
*Completed: 2026-04-18*
