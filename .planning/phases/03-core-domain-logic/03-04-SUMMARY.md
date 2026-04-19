---
phase: 03-core-domain-logic
plan: 04
subsystem: core
tags: [core, composition-root, factory, barrel, d-03-invariant, grep-test, end-to-end]
depends_on: [03-01, 03-02, 03-03]

# Dependency graph
requires:
  - phase: 02-storage-layer
    provides: "Repos aggregate, AttachmentStore, Db, withTransaction, test helpers"
  - phase: 03-core-domain-logic
    plan: 01
    provides: "createBus, Bus, BusEvents, MessageEvent"
  - phase: 03-core-domain-logic
    plan: 02
    provides: "createInboxes, InboxesApi, CreateInboxResult, ExpireInboxResult, standalone verifyViewToken"
  - phase: 03-core-domain-logic
    plan: 03
    provides: "createMessages, MessagesApi, IngestInput/Result, ListMessages Input/Result, MessageView, AttachmentView"
provides:
  - "src/core/index.ts — createCore(deps) single-entry composition factory for Phase 4/5/6 adapters"
  - "src/core/types.ts — type-only barrel for interface-only consumers"
  - "CoreApi = { bus, createInbox, expireInbox, ingestMessage, listMessages } — one surface, four operations, one shared bus"
  - "CoreDeps = { db, repos, attachmentStore, config, now?, id? } — every I/O dep is injected"
  - "CoreConfig = { domain, idleTtlMs, hardTtlMs } — single-source for the three config values the core layer needs"
  - "D-03 programmatic enforcement: tests/core/no-direct-db.test.ts — 4 cases, specifier-anchored, catches every import form"
  - "End-to-end composition coverage: tests/core/composition.test.ts — 6 cases proving every Phase 3 ROADMAP success criterion through the public api"
affects: [04-smtp-adapter, 05-http-sse, 06-retention-sweeper]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory-of-factories composition root — createCore(deps) calls createBus + createInboxes + createMessages exactly once and returns the merged api"
    - "Type-only barrel (src/core/types.ts) companion to runtime barrel (src/core/index.ts) — callers pick the surface they need"
    - "Source-grep invariant test — specifier-anchored regex covers `from`, bare side-effect, dynamic `import()`, and `require()` forms"
    - "End-to-end composition test uses real in-memory DB + real attachment store (tmpdir) + real bus — no mocks for the modules under test"

key-files:
  created:
    - src/core/index.ts
    - src/core/types.ts
    - tests/core/no-direct-db.test.ts
    - tests/core/composition.test.ts
  modified: []

key-decisions:
  - "One `createBus()` per `createCore()` — the returned `core.bus` is the only instance external adapters subscribe to; two cores sharing repos still have distinct buses (D-09 surfaced through the public api and asserted in composition test 2)."
  - "Deps are passed through verbatim to each factory — no defaulting happens at the composition-root level; defaults flow to the inner factories (`now ?? nowMs`, `id ?? newId`). This keeps the injection surface uniform and lets tests override any dep end-to-end."
  - "`CoreConfig` only carries the three settings every core module actually uses (`domain`, `idleTtlMs`, `hardTtlMs`). `createInboxes` receives all three; `createMessages` gets only `domain` + `idleTtlMs`. The composition root is the single place these are adapted — adapters never hand-construct the inner configs."
  - "The D-03 grep predicate is specifier-anchored (`['\"]better-sqlite3['\"]`, `['\"]node:fs(?:\\/promises)?['\"]`) instead of `from\\s+...` — Rule 2 auto-add: the plan's `<done>` section verifies with a bare side-effect `import 'better-sqlite3';` (no `from` clause), which the plan's originally-specified regex would miss. Broader anchor catches every import form (from / bare side-effect / dynamic `import()` / CommonJS `require`) with zero false positives because the package specifiers are unambiguous."
  - "`types.ts` re-exports `CoreApi`, `CoreConfig`, `CoreDeps` from `./index.js` so callers that want `import type { CoreApi } from '../core/types.js'` without pulling the factory implementation can do so. Useful for interface-only consumers and mock helpers."

patterns-established:
  - "Composition roots follow the same factory signature as the modules they compose: `createCore(deps) → CoreApi` mirrors `createInboxes(deps) → InboxesApi`."
  - "Phase 3 lock-in: the canonical adapter dependency is `core: CoreApi` — adapters never import `src/core/inboxes.ts` or `src/core/messages.ts` directly, only `src/core/index.ts`."
  - "D-03 is now enforced at BOTH levels: runtime (Phase 2's prepared-statement spy invariant) + source (this plan's grep invariant). Future refactors that try to reach directly into `node:fs` or `better-sqlite3` from `src/core/` fail at test time with a clear file path."

requirements-completed: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05]

# Metrics
duration: ~15min
completed: 2026-04-18
tasks_completed: 4
files_created: 4
---

# Phase 3 Plan 04: Composition Root Summary

**Single-entry factory `createCore(deps)` wires bus + inboxes + messages into one `CoreApi` object that Phase 4/5/6 adapters import from `src/core`. `src/core/types.ts` mirrors the re-exports as a type-only barrel. Two tests lock the Phase 3 contract: a source-grep invariant (`tests/core/no-direct-db.test.ts`, 4 cases) enforces D-03 by walking every `.ts` under `src/core/` and failing if any file imports `better-sqlite3`, `node:fs`, or calls `db.prepare`/`db.exec`; an end-to-end composition test (`tests/core/composition.test.ts`, 6 cases) proves every Phase 3 ROADMAP success criterion through the public api using a real in-memory DB, real attachment store in a tmpdir, and real bus.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-18T11:25Z
- **Completed:** 2026-04-18T11:30Z
- **Tasks:** 4 (3 code + 1 gate)
- **Files modified:** 4 (created)

## Accomplishments

- `createCore({ db, repos, attachmentStore, config, now?, id? }) → CoreApi` with exactly one `createBus()` call per invocation.
- `CoreApi` surface: `{ bus, createInbox, expireInbox, ingestMessage, listMessages }` — one surface for every adapter.
- `CoreConfig = { domain, idleTtlMs, hardTtlMs }` — every config value the core modules consume, in one place.
- Public barrel `src/core/index.ts` re-exports `Bus`, `BusEvents`, `MessageEvent`, `CreateInboxResult`, `ExpireInboxResult`, `InboxesApi`, `IngestInput/Result`, `ListMessages Input/Result`, `MessageView`, `AttachmentView`, `MessagesApi`.
- Type-only barrel `src/core/types.ts` mirrors the re-exports plus `CoreApi`, `CoreConfig`, `CoreDeps` for interface-only consumers.
- D-03 grep invariant — 4 cases. Manually validated: injecting `import 'better-sqlite3';` into `src/core/bus.ts` flips the case red with the offender path in the assertion message; reverting returns the suite to green.
- End-to-end composition test — 6 cases covering address entropy, bus identity, ingest-emits-and-persists, ASC chronological listing, view-token enforcement (forbidden / not_found), and full-walk expire with orphan unlink.
- Full suite **100/100 pass across 15 test files** (90 pre-existing + 4 invariant + 6 composition). Typecheck exit 0. Biome clean over 41 files.

## Phase 3 ROADMAP Success-Criteria Coverage

| # | ROADMAP criterion (Phase 3) | Proved by |
|---|------------------------------|-----------|
| 1 | `createInbox()` returns a local-part with ≥64 bits of entropy and a distinct view-token | `composition.test.ts` — case "createInbox returns address with configured domain and distinct view-token" (also `inboxes.test.ts` 9-case suite) |
| 2 | `ingestMessage` writes message + attachments transactionally (atomic all-or-none) | `messages.test.ts` — atomicity + rollback cases; surfaced through `composition.test.ts` — "ingestMessage to the address … emits on core.bus and writes DB" + "expireInbox cascades DB rows and unlinks orphan attachment blobs" |
| 3 | After `ingestMessage`, a bus listener receives the new message synchronously within the same tick | `composition.test.ts` — "ingestMessage … emits on core.bus" asserts `listener.toHaveBeenCalledTimes(1)` within the same tick; `bus.test.ts` covers sync delivery semantics |
| 4 | `listMessages(inboxId, viewToken)` returns messages for the right token; rejects wrong tokens | `composition.test.ts` — "listMessages returns ingested messages in ASC order …" and "listMessages enforces view-token: forbidden for wrong token, not_found for unknown id". Per plan 03-03 D-15 the wrong-token branch returns `{ ok: false, reason: 'forbidden' }` (anti-enumeration, supersedes ROADMAP's original `[]` formulation) and ordering is ASC chronological. |
| 5 | `expireInbox` cascades messages + attachment rows + attachment files + abuse counters in one transaction | `composition.test.ts` — "expireInbox cascades DB rows and unlinks orphan attachment blobs" (end-to-end: write blob → ingest with attachment → expire → DB row gone AND file gone); `inboxes.test.ts` 9-case suite covers the unit-level branches (orphan-safe, multi-inbox sha sharing, zero-messages, transaction rollback on throw, not_found) |

D-03 (no direct DB access in `src/core/`) — enforced programmatically by `tests/core/no-direct-db.test.ts` across all files currently under `src/core/` (bus.ts, inboxes.ts, messages.ts, index.ts, types.ts).

## Task Commits

Each task committed atomically on branch `gsd/phase-02-storage-layer`:

1. **Task 1: createCore + types barrel** — `ebfbe62` (feat(core): add composition root with createCore(deps))
2. **Task 2: D-03 grep invariant test** — `936d2eb` (test(core): enforce D-03 no-direct-db invariant via source grep)
3. **Task 3: End-to-end composition test** — `ff8f6ff` (test(core): end-to-end composition root coverage)
4. **Task 4: Plan-level gate** — no commit (verification-only; no file changes)

**Plan metadata commit:** pending (docs commit wraps this file + the phase summary + STATE.md + ROADMAP.md + REQUIREMENTS.md).

## Files Created/Modified

- `src/core/index.ts` — 103 lines. `createCore(deps)`, `CoreApi`, `CoreConfig`, `CoreDeps`, plus re-exports of Bus/MessageEvent/Ingest/List shapes.
- `src/core/types.ts` — 20 lines. Type-only barrel re-exporting `CoreApi`, `CoreConfig`, `CoreDeps`, `Bus`, `MessageEvent`, `CreateInboxResult`, `ExpireInboxResult`, `InboxesApi`, `IngestInput/Result`, `ListMessages Input/Result`, `MessageView`, `AttachmentView`, `MessagesApi`.
- `tests/core/no-direct-db.test.ts` — 79 lines, 4 cases (sanity + three forbidden-pattern checks).
- `tests/core/composition.test.ts` — 199 lines, 6 end-to-end cases.

## Verification Results

All three plan-gate commands exit 0:

- `npm run typecheck` — 0 errors.
- `npm run check` — Biome clean across 41 files.
- `npx vitest run` — **100/100 tests pass across 15 test files** (660ms test runtime).
- `npx vitest run tests/core/no-direct-db.test.ts` — 4/4 pass.
- `npx vitest run tests/core/composition.test.ts` — 6/6 pass.

D-03 manual verification: injecting `import 'better-sqlite3';` at the top of `src/core/bus.ts` flipped the grep case red with `offenders: …\\src\\core\\bus.ts` in the assertion message. Reverting the file returned the suite to green. The offender was NOT committed.

## Decisions Made

- **Broader invariant regex than the plan's original spec (deviation Rule 2):** Anchored the three forbidden-import checks on the unambiguous specifier string (`['\"]better-sqlite3['\"]`, `['\"]node:fs(?:\\/promises)?['\"]`) rather than the plan's `from\\s+...` / `require\\s*\\(\\s*...` pair. The plan's `<done>` step specifies an exact offender to use for manual verification: `import 'better-sqlite3';` — a bare side-effect import with no `from` clause — which the plan's original regex would not catch, leaving the invariant toothless against a legitimate real-world footgun. The broader predicate catches every import form (from / bare side-effect / dynamic `import()` / CommonJS `require`) with zero false positives because the package specifiers are unambiguous (`better-sqlite3` does not appear in any legitimate non-import context, and `node:fs[/promises]` is a Node builtin specifier never used elsewhere).
- **Did not guard `deps` mutation defensively.** `createCore` reads fields and passes them down; it never writes back. Adding `Object.freeze(deps)` would be noise.
- **Followed the plan's `<action>` code blocks verbatim for `src/core/index.ts`, `src/core/types.ts`, and `tests/core/composition.test.ts`.** Only the invariant test's regex was broadened (see above).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical functionality] Broadened the D-03 invariant regex to catch bare side-effect imports**
- **Found during:** Task 2 sanity verification
- **Issue:** The plan's regex `from\\s+['\"]better-sqlite3['\"]` + `require\\s*\\(\\s*['\"]better-sqlite3['\"]` does NOT match a bare side-effect import like `import 'better-sqlite3';`. Yet the plan's `<done>` clause says to manually verify by introducing exactly that offender — creating an untestable contradiction where a genuine D-03 violation would sail past the invariant.
- **Fix:** Replaced the two alternation regexes with a single specifier-anchored match `['\"]better-sqlite3['\"]` (and the equivalent for `node:fs(/promises)?`). Catches all four import forms (from / bare / dynamic `import()` / CommonJS `require`). The `db.prepare|db.exec` regex is unchanged from the plan.
- **False-positive risk:** None under `src/core/` — the package name and `node:fs` specifier appear only in import statements, never in doc-comment prose (verified: the existing core files' doc comments write the names without quotes).
- **Files modified:** `tests/core/no-direct-db.test.ts` (predicate body only; structure unchanged).
- **Commit:** `936d2eb` (Task 2's commit — the fix landed with the test itself).

No other functional deviations. The `src/core/index.ts` and `src/core/types.ts` implementations match the plan's `<action>` code blocks byte-for-byte (modulo Biome's standard formatting).

## Issues Encountered

- **D-03 invariant initially didn't catch the manual-verify offender.** The plan's as-written regex missed bare side-effect imports. Diagnosed during Task 2's `<done>` manual verification step; fixed inline (see Deviations above); re-verified with the same injected offender; reverted the offender. Caught before commit.
- **Biome flagged CRLF line endings in `src/core/bus.ts` after a `git checkout -- src/core/bus.ts` used during offender revert.** Ran `npm run check:fix` to normalize back to LF (the committed form). Net content diff against HEAD is zero; `git status` reports the file as modified only because of the autocrlf round-trip on this Windows working tree. `bus.ts` is NOT in this plan's scope and was NOT staged for any of this plan's commits.

## User Setup Required

None — no external services, no env vars, no dashboard configuration, no auth gates.

## Next Phase Readiness

- **Phase 4 (SMTP adapter)** imports from `src/core/index.js`:
  - `createCore(deps)` at startup to obtain the `CoreApi` instance.
  - `ingestMessage(input)` per accepted `DATA` — return shape lets it translate `unknown_recipient` / `invalid_attachment` / `invalid_envelope` into SMTP 550s.
- **Phase 5 (HTTP + SSE)** imports from `src/core/index.js`:
  - `createInbox()` behind `POST /api/inbox`.
  - `listMessages({ inboxId, viewToken })` behind `GET /api/inbox/:id/messages`.
  - `bus.on('message', listener)` in the SSE handler; the listener uses replay-on-subscribe semantics (D-10) to avoid race windows.
  - `expireInbox({ inboxId })` is not on the HTTP path — Phase 6 owns it.
- **Phase 6 (sweeper)** imports `expireInbox({ inboxId })` and calls it per expired inbox from `repos.inboxes.listExpired(cutoff, limit)`.
- **Phase 4 and Phase 5 are now unblocked and can run in parallel.** Both depend only on Phase 3; neither depends on the other.

## Known Stubs

None. Every code path in `src/core/index.ts` has a real implementation. The type-only barrel `src/core/types.ts` has zero runtime surface by design. The two tests exercise real dependencies end-to-end; no mocks for the modules under test.

## Threat Flags

None new. The composition root introduces no new network surface, no auth path, no file access, and no schema change. It is a pure wiring layer that forwards to modules whose threat surface was already catalogued in plans 03-01 (bus — no persistence, listener-failure isolation), 03-02 (inboxes — hashed view-token with timing-safe compare, orphan-safe expire), and 03-03 (messages — enumeration-safe listing, defensive attachment validation, emit-after-commit).

The D-03 grep invariant is itself a threat-mitigation artifact: it turns a "we promise the core layer doesn't touch the DB/filesystem directly" code-review convention into a test that fails red if the invariant is violated. Future refactors now have to explicitly bypass this test to introduce a direct dependency.

## Self-Check: PASSED

- `src/core/index.ts` — FOUND
- `src/core/types.ts` — FOUND
- `tests/core/no-direct-db.test.ts` — FOUND
- `tests/core/composition.test.ts` — FOUND
- `.planning/phases/03-core-domain-logic/03-04-SUMMARY.md` — FOUND (this file)
- Commit `ebfbe62` (feat(core): add composition root) — FOUND in `git log`
- Commit `936d2eb` (test(core): enforce D-03 invariant) — FOUND in `git log`
- Commit `ff8f6ff` (test(core): end-to-end composition coverage) — FOUND in `git log`
- `npm run typecheck` — exit 0
- `npm run check` — exit 0 (41 files)
- `npx vitest run` — exit 0 (100/100 tests pass)
- D-03 manual verification — offender correctly named in failure output; file reverted; suite green.

---
*Phase: 03-core-domain-logic*
*Plan: 04*
*Completed: 2026-04-18*
