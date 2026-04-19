---
phase: 2
plan: 5
subsystem: tests
tags: [vitest, testing, sqlite, integration-tests, unit-tests, fk-cascade, pragmas, invariant-tests]
dependency_graph:
  requires:
    - "node-project"
    - "typescript-toolchain"
    - "vitest-runner"
    - "db-handle"
    - "schema-v1"
    - "inbox-repo"
    - "message-repo"
    - "attachment-repo"
    - "abuse-repo"
    - "repos-aggregate"
    - "attachment-store"
  provides:
    - "phase-2-test-suite"
    - "store-requirement-coverage"
  affects: ["03-*", "04-*", "05-*", "06-*"]
tech_stack:
  added: []
  patterns:
    - "In-memory SQLite (`:memory:`) for parallelizable unit tests (D-33)"
    - "Real file DB in tmpdir for integration tests that need PRAGMA + WAL semantics (D-34)"
    - "`withTmpDir(fn)` helper — allocate + run + clean a per-test temp directory"
    - "Vitest explicit imports (`globals: false`) — describe/expect/it/vi named in every file"
    - "vi.spyOn on Db handle to programmatically enforce D-21 (no raw SQL outside repos)"
    - "Sha256 test fixtures use `'a'.repeat(64)` pattern — valid lowercase hex, human-readable"
key_files:
  created:
    - path: "tests/support/tmpdir.ts"
      purpose: "withTmpDir(fn) — allocate + clean a per-test temp directory"
    - path: "tests/support/db-helper.ts"
      purpose: "openTestDb() + openTestDbWithRepos() — canonical unit-test DB setup"
    - path: "tests/db/schema.test.ts"
      purpose: "9 tests — schema structure, columns, indexes, FK declarations, integrity_check (STORE-01)"
    - path: "tests/db/pragmas-integration.test.ts"
      purpose: "3 tests — WAL + PRAGMAs on real file DB, re-apply across reconnect (STORE-02, D-34)"
    - path: "tests/db/inbox-repo.test.ts"
      purpose: "7 tests — createInbox, findByLocalPart, UNIQUE enforcement, hard-cap, delete, listExpired"
    - path: "tests/db/message-repo.test.ts"
      purpose: "4 tests — insertMessageWithAttachments atomicity + FK rollback, listByInbox ordering, count"
    - path: "tests/db/attachment-repo.test.ts"
      purpose: "4 tests — findById, listByMessage, listAllSha256s dedup, deleteByMessage"
    - path: "tests/db/abuse-repo.test.ts"
      purpose: "4 tests — UPSERT + RETURNING, missing keys, triple independence, pruneOldCounters"
    - path: "tests/db/cascade.test.ts"
      purpose: "3 tests — FK CASCADE at both levels (inbox->messages->attachments, message->attachments) (D-09)"
    - path: "tests/db/prepared-statement-invariant.test.ts"
      purpose: "2 tests — D-21 enforcement: no db.exec() post-open, no db.prepare() post-createRepos"
    - path: "tests/attachments/paths.test.ts"
      purpose: "4 tests — shardPath shape, invalid-hex rejection, isValidSha256Hex edges (STORE-03)"
    - path: "tests/attachments/store.test.ts"
      purpose: "9 tests — write/read/stat/unlink, dedup, large streams, invalid-sha refusal, .incoming/ cleanup (STORE-03)"
  modified: []
  deleted:
    - path: "tests/smoke.test.ts"
      reason: "Sentinel placeholder from plan 02-01 — real tests now cover the Vitest-non-empty requirement. Deferred removal from 02-01 SUMMARY is now resolved."
decisions:
  - "D-33 materialized: every repo unit test + schema test + D-21 invariant test opens a fresh :memory: DB via openTestDb(). Parallel-safe by construction."
  - "D-34 materialized: PRAGMA behavior + PRAGMA reapply + migration idempotency exercised with a real file DB in a per-test tmpdir"
  - "Plan's verify snippets (inline integer PRAGMA values like `134217728`) preserved with Biome's preferred underscore separator (`134_217_728`)"
  - "`as any`-free tests: Repos typed directly via the exported `Repos` type; helper signatures use it to avoid ReturnType<typeof openTestDbWithRepos>['repos'] long-forms"
requirements: [STORE-01, STORE-02, STORE-03, STORE-04]
metrics:
  duration_minutes: ~6
  completed_date: "2026-04-19"
  tasks: 3
  files_created: 12
  files_deleted: 1
  test_files: 10
  test_cases: 49
  test_runtime_ms: ~450
---

# Phase 2 Plan 5: Vitest Test Suite Summary

Locked in Phase 2 behavior with a 49-test Vitest suite across 10 files — unit tests on in-memory SQLite (D-33), one integration test on a real file DB (D-34), and a dedicated D-21 invariant spy test. Every STORE-01..04 requirement now has at least one failing-if-broken assertion. Total runtime ~450ms; the whole suite fits comfortably under the plan's 3-second budget.

## What Was Built

### Support layer (`tests/support/`)

- **`tmpdir.ts`** — `withTmpDir(fn)` allocates a `mkdtemp('tempmail-test-')` directory under the OS tmpdir, runs `fn(dir)`, and unconditionally `rm -rf`'s it on return (success or throw). The two consumers are `pragmas-integration.test.ts` and `attachments/store.test.ts`.
- **`db-helper.ts`** — `openTestDb()` returns a fresh `:memory:` DB with schema applied; `openTestDbWithRepos()` returns `{ db, repos }` in one step. Almost every unit test uses the latter.

### DB tests (`tests/db/`)

| File | Cases | Purpose |
| ---- | ---- | ---- |
| `schema.test.ts` | 9 | Table list, per-table column presence, NOT NULL on inboxes.domain, composite PK on abuse_counters, every documented index, `PRAGMA integrity_check`, schema_version at 1, FK declarations on messages & attachments |
| `pragmas-integration.test.ts` | 3 | On a real file DB: WAL + synchronous=1 + busy_timeout=5000 + foreign_keys=1 + temp_store=MEMORY + mmap_size=128MB; PRAGMAs re-apply across close/reopen; migration idempotency (version stays 1, no double-insert) |
| `inbox-repo.test.ts` | 7 | createInbox assigns id + timestamps, findByLocalPart disambiguates by (local_part, domain), UNIQUE (local_part, domain) enforced, updateLastActivity clamps at hard cap, missing inbox returns undefined, deleteInbox returns true-then-false, listExpired returns only rows < cutoff in ascending order |
| `message-repo.test.ts` | 4 | insertMessageWithAttachments writes N attachments atomically, FK violation throws (rollback), listMessagesByInbox orders newest first, countMessagesByInbox accurate |
| `attachment-repo.test.ts` | 4 | findAttachmentById, listAttachmentsByMessage, listAllSha256s dedups, deleteAttachmentsByMessage scoped |
| `abuse-repo.test.ts` | 4 | incrementCounter UPSERT+RETURNING increments, getCounter 0 on miss, (prefix, bucket, window) triples independent, pruneOldCounters deletes strictly < cutoff |
| `cascade.test.ts` | 3 | inbox delete cascades to messages, inbox delete cascades to attachments via messages, deleteMessagesByInbox cascades to attachments but leaves siblings untouched |
| `prepared-statement-invariant.test.ts` | 2 | D-21 spy tests: no `db.exec()` during repo methods post-open; no `db.prepare()` on repeated `createInbox` calls (statements cached) |

### Attachment tests (`tests/attachments/`)

| File | Cases | Purpose |
| ---- | ---- | ---- |
| `paths.test.ts` | 4 | shardPath returns `<aa>/<bb>/<sha256>`, rejects short/uppercase/non-hex, isValidSha256Hex edge matrix, accepts full lowercase hex alphabet |
| `store.test.ts` | 9 | Write → correct sha + path + size + file-on-disk; large ~1MB stream; read roundtrip byte-identical; null on missing; dedup (D-29); idempotent unlink; invalid-sha rejection on read/stat/unlink; statBySha256 exists/missing; `.incoming/` empty after successful write |

## STORE-XX Requirement Traceability

| Requirement | Proof (test file → case) |
| ----------- | ----------------------- |
| **STORE-01** (4 domain tables + domain first-class) | `schema.test.ts` — "creates all five tables", "inboxes has domain as a first-class column", "messages has all D-06 columns", "attachments has storage_path and sha256 (D-07)", "abuse_counters has composite PK (D-08)", "creates required indexes", "passes PRAGMA integrity_check", "schema_version starts at 1", "FK declarations exist on messages.inbox_id and attachments.message_id" |
| **STORE-02** (WAL + PRAGMAs) | `pragmas-integration.test.ts` — "applies WAL + documented PRAGMAs on fresh open", "WAL + foreign_keys re-apply on reconnect", "opening same path twice does not re-run migrations" |
| **STORE-03** (hash-sharded attachment store) | `attachments/paths.test.ts` (all 4 cases) + `attachments/store.test.ts` (all 9 cases). Critical proofs: write lands at `<root>/<aa>/<bb>/<sha256>`; dedup same-bytes; invalid-sha rejection (D-28); atomic write (no `.incoming/` residue) |
| **STORE-04** (repos + prepared statements) | All four `*-repo.test.ts` files (19 cases total) prove intent-named method behavior. `cascade.test.ts` (3 cases) proves D-09 CASCADE. `prepared-statement-invariant.test.ts` (2 cases) proves D-21 programmatically via `vi.spyOn` on `db.exec` and `db.prepare`. |

## Verification Results

Plan-level gate, run from repo root on final state:

```
npm run typecheck  -> exit 0 (clean)
npm run check      -> exit 0 (31 files, 0 findings)
npm test           -> exit 0 (10 files, 49 tests, ~450ms)
```

Per-task verify from the plan:

| Task | Command | Result |
| ---- | ------- | ------ |
| 1 | `npx vitest run tests/db/schema.test.ts tests/db/pragmas-integration.test.ts` | 12 passed / 357ms |
| 2 | `npx vitest run tests/db/{inbox,message,attachment,abuse}-repo.test.ts tests/db/cascade.test.ts` | 22 passed / 380ms |
| 3 | `npx vitest run tests/attachments/paths.test.ts tests/attachments/store.test.ts tests/db/prepared-statement-invariant.test.ts` | 15 passed / 318ms |

## Test Suite Composition

| Suite | Files | Cases | ~Runtime |
| ----- | ----- | ----- | -------- |
| `schema v1 (STORE-01)` | 1 | 9 | 22ms |
| `PRAGMAs on real file DB (STORE-02, D-34)` | 1 | 3 | 47ms |
| `inboxRepo (STORE-04)` | 1 | 7 | 25ms |
| `messageRepo (STORE-04)` | 1 | 4 | 21ms |
| `attachmentRepo (STORE-04)` | 1 | 4 | 18ms |
| `abuseRepo (STORE-04)` | 1 | 4 | 15ms |
| `FK CASCADE (D-09)` | 1 | 3 | 16ms |
| `D-21: all repo SQL goes through prepared statements` | 1 | 2 | 13ms |
| `attachment paths (STORE-03)` | 1 | 4 | 4ms |
| `attachmentStore (STORE-03)` | 1 | 9 | 76ms |
| **Total** | **10** | **49** | **~450ms** (full suite, incl. Vitest startup + reporting) |

Every case matches the plan's own verification table counts exactly.

## Commits

| Task | Commit | Files |
| ---- | ------ | ----- |
| 1. support helpers + schema + PRAGMA tests | `c227099` | `tests/support/{tmpdir,db-helper}.ts`, `tests/db/{schema,pragmas-integration}.test.ts` |
| 2. repos + cascade tests | `c790076` | `tests/db/{inbox,message,attachment,abuse}-repo.test.ts`, `tests/db/cascade.test.ts` |
| 3. attachment store + D-21 invariant + sentinel removal | `89d8f34` | `tests/attachments/{paths,store}.test.ts`, `tests/db/prepared-statement-invariant.test.ts`, **deleted** `tests/smoke.test.ts` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Plan source used `.ts` imports; project forbids them**
- **Found during:** Task 1, initial authoring.
- **Issue:** Plan snippets import with `.ts` extensions (`from '../../src/db/client.ts'`). The project's `tsconfig.json` sets `allowImportingTsExtensions: false` (locked by plan 02-01); previous plans' autofixes use `.js` under NodeNext-ESM.
- **Fix:** Used `.js` extensions everywhere — `from '../../src/db/client.js'`, `from '../support/db-helper.js'`, etc. Plan's intent (NodeNext module specifiers) preserved; only the file extension changed.
- **Files modified:** All 10 test files + both support helpers.
- **Commits:** `c227099`, `c790076`, `89d8f34`.

**2. [Rule 3 — Blocking] Large integer literals must use underscores for Biome**
- **Found during:** Task 1, local biome check on `pragmas-integration.test.ts`.
- **Issue:** Plan snippet had `134217728` (raw); Biome's `useNumericSeparators` rule wants `134_217_728`.
- **Fix:** Applied the separator. Same numeric value, Biome-compliant.
- **Files modified:** `tests/db/pragmas-integration.test.ts`, `tests/db/inbox-repo.test.ts` (9_999_999_999), `tests/db/prepared-statement-invariant.test.ts` (9_999_999_999).
- **Commits:** `c227099`, `c790076`, `89d8f34`.

**3. [Rule 1 — Type bug] `ReturnType<typeof openTestDbWithRepos>['repos']` in helper signatures**
- **Found during:** Task 2, authoring `message-repo.test.ts` and `attachment-repo.test.ts`.
- **Issue:** Plan source used `ReturnType<typeof openTestDbWithRepos>['repos']` for helper function parameter types. This is legal but verbose and couples test helpers to the helper's return shape instead of the underlying `Repos` type.
- **Fix:** Imported `Repos` directly from `../../src/db/repos/index.js` and typed helpers as `(repos: Repos) => ...`. Zero runtime change; cleaner and matches the contract the helpers actually depend on.
- **Files modified:** `tests/db/message-repo.test.ts`, `tests/db/attachment-repo.test.ts`.
- **Commit:** `c790076`.

**4. [Rule 1 — Bug] `noUncheckedIndexedAccess` appeasement in attachment-repo test**
- **Found during:** Task 2, typecheck on `attachment-repo.test.ts`.
- **Issue:** Plan source had `repos.attachments.findAttachmentById(attId!)`. The project's `biome.json` bans non-null assertions (`noNonNullAssertion: error`).
- **Fix:** Used an early-return guard: `const attId = m1.attachmentIds[0]; expect(attId).toBeDefined(); if (!attId) return; const row = repos.attachments.findAttachmentById(attId);`. Same assertion semantics (test fails on undefined via `toBeDefined()`); no `!` operator.
- **Files modified:** `tests/db/attachment-repo.test.ts`.
- **Commit:** `c790076`.

**5. [Rule 1 — Bug] `noUncheckedIndexedAccess` in store.test.ts read roundtrip**
- **Found during:** Task 3, typecheck on `attachments/store.test.ts`.
- **Issue:** Plan source had `for await (const chunk of readBack!)` inside the "readAttachment streams bytes back" test. Same non-null-assertion ban.
- **Fix:** Replaced with `expect(readBack).not.toBeNull(); if (!readBack) return;` before the loop. Same control flow, no `!`.
- **Files modified:** `tests/attachments/store.test.ts`.
- **Commit:** `89d8f34`.

**6. [Rule 1 — Bug] Typed `row` generic on persist reconnect select**
- **Found during:** Task 1, typecheck on `pragmas-integration.test.ts`.
- **Issue:** Plan source wrote `db2.prepare('SELECT id FROM inboxes WHERE id=?').get('id1')`, relying on `unknown` row. With strict TS, `.get()` returns `unknown` when no generics are supplied, and `expect(row).toBeDefined()` is fine but `row.id` would not be accessible (untyped). The plan's assertion was only `toBeDefined()`, so plain `unknown` would compile — but clearer to type it.
- **Fix:** Added `<[string], { id: string }>` generic on the prepare call and asserted both `toBeDefined()` and `row?.id === 'id1'`. Stronger coverage, same intent.
- **Files modified:** `tests/db/pragmas-integration.test.ts`.
- **Commit:** `c227099`.

**7. [Rule 3 — Blocking] Readable import + expect-unused in store.test.ts**
- **Found during:** Task 3, biome check on `attachments/store.test.ts`.
- **Issue:** Biome's `organizeImports` wants alphabetical ordering + grouped bare/named imports. Plan source had imports in a non-alphabetical order.
- **Fix:** Sorted imports: `node:crypto`, `node:fs/promises`, `node:path`, `node:stream`, then `vitest`, then project-relative. Identical semantics.
- **Files modified:** `tests/attachments/store.test.ts`.
- **Commit:** `89d8f34`.

### Intentional Cleanup

**Sentinel removal: `tests/smoke.test.ts`**
- Plan 02-01's SUMMARY explicitly flagged this as a deferred item. Plan 02-05's plan file instructs executor to remove the sentinel once real tests pass.
- Final `git rm tests/smoke.test.ts` + commit `89d8f34`.
- `npm test` still passes (49 tests, no empty-suite exit-1 concern).

### Out-of-scope (deferred) items

None. All items from `.planning/phases/02-storage-layer/deferred-items.md` were already resolved by plans 02-03 and 02-04 (items 1, 2, 3 all CLOSED). Nothing new deferred.

## Must-have Truths — Verified

| # | Truth | Verified |
| - | ----- | -------- |
| 1 | `npm test` runs the full Phase 2 test suite and exits 0 | Final gate run: 10 files, 49 tests, 0 failures, exit 0 |
| 2 | Unit tests use `:memory:` SQLite (D-33) | All repo + schema + D-21 tests open via `openTestDb()` / `openTestDbWithRepos()` which calls `openDb(':memory:')`. Confirmed by grep: only `pragmas-integration.test.ts` and `attachments/store.test.ts` touch the filesystem. |
| 3 | One integration test uses a real file DB in a tmpdir (D-34) to verify WAL mode + PRAGMA persistence across reconnect | `pragmas-integration.test.ts` case 2 "WAL + foreign_keys re-apply on reconnect" opens `persist.db`, writes, closes, re-opens, asserts PRAGMAs all still hold. |
| 4 | FK CASCADE is tested end-to-end: deleting an inbox removes its messages and attachment rows | `cascade.test.ts` cases 1 + 2 cover both cascade hops (inbox→messages, inbox→messages→attachments via `listAllSha256s`). |
| 5 | D-21 is verified by a test that spies on db.prepare / db.exec and asserts they're only called inside src/db/ | `prepared-statement-invariant.test.ts` uses `vi.spyOn(db, 'exec')` post-open and asserts `not.toHaveBeenCalled()` after every repo method exercised; separate test spies on `db.prepare` post-`createRepos` and asserts no re-prepare across 10 `createInbox` calls. |
| 6 | Every STORE-01..04 requirement has at least one failing-if-broken assertion | See traceability table above; every requirement is backed by explicit named cases. |

## Known Stubs

None. Every test uses real code paths — no mocks of production modules, no fake data flowing to UI. Fixture strings (`'a'.repeat(64)`, `'aa/aa/...'`) are intentional deterministic test inputs, not placeholders awaiting implementation.

## Coverage Gaps (minor, documented)

- **`writeAttachment` pipeline-error path** is not exercised directly. The production code has a try/catch that best-effort-unlinks the temp file and rethrows; no test forces the stream to throw mid-pipe (would require a stub Readable that emits `error`). Scope: low risk — the error path is a single `unlink().catch(() => {})` wrapped around the well-tested happy path. Future plan could add a Readable-that-throws fixture.
- **`discoverPendingMigrations` with a synthetic `schema-v2.sql`** is not directly tested in 02-05. The plan's `pragmas-integration.test.ts` case 3 proves idempotency of v1 (re-open doesn't re-apply), and plan 02-02's own smoke test (documented in 02-02 SUMMARY) exercised adding a v2 file. Re-proving it here would require writing a second SQL file into the `SCHEMA_DIR` at test time, which is fragile (the dir is compiled-next-to-source, not a test fixture dir). Deferred: out of scope for this plan's "tests only under tests/**" boundary.
- **Path-traversal refusal beyond `isValidSha256Hex`** is implicit: the plan's "sha256 regex violations throw" check is satisfied by `store.test.ts` "rejects invalid sha on read/stat/unlink" which covers `'nope'`. Exotic traversal-attempt inputs (e.g. `'../etc/passwd'`) are rejected by the same length + charset guard; explicit cases would be redundant.
- **Concurrent-write dedup race** (two writers for the same bytes at the same time) is not tested. The plan mentioned this but the actual product code is single-process-single-writer (D-19), so the race isn't a real concern; dedup correctness is proven by the serial case in `store.test.ts` "dedup: same bytes produce same path".

None of these gaps weaken the STORE-XX requirement coverage; they are edges where the production code's correctness is already constrained by simpler invariants already tested.

## Brittle Points

- **Timing-based assertions in `inbox-repo.test.ts`** use `Date.now()` as `before` reference. In the near-zero-cost `:memory:` test, the inserted timestamp is guaranteed `>= before` because `nowMs()` runs synchronously after `before` was sampled. If a future change made `createInbox` async or introduced a sleep, the assertion could flake — unlikely. The alternative (`vi.useFakeTimers` + explicit advances) would be overkill.
- **FK-rollback test** in `message-repo.test.ts` expects `toThrow(/FOREIGN KEY/)`. better-sqlite3's error message includes this literal phrase; if the driver ever changes its error text, this assertion breaks. Acceptable: we'd notice the driver change through the broken test, which is the point.
- **`'a'.repeat(64)` as a sha256 stand-in**: these are structurally valid but semantically meaningless digests. Tests never hash anything and compare; they just use the hex as a unique key. If `attachmentRepo`/`messageRepo` ever validates sha256 semantically (e.g. refusing all-same-char hex), these tests would break. Currently those validations live only in the filesystem layer, which IS tested with real hashed content in `attachments/store.test.ts`.

## Threat Flags

None. This plan adds only test code — no network surface, no auth path, no schema changes, no untrusted file access outside `withTmpDir` roots that are OS-provided and cleaned up. Threat surface scan of created files: clean.

## Self-Check: PASSED

Created files exist:
- `tests/support/tmpdir.ts` — FOUND
- `tests/support/db-helper.ts` — FOUND
- `tests/db/schema.test.ts` — FOUND
- `tests/db/pragmas-integration.test.ts` — FOUND
- `tests/db/inbox-repo.test.ts` — FOUND
- `tests/db/message-repo.test.ts` — FOUND
- `tests/db/attachment-repo.test.ts` — FOUND
- `tests/db/abuse-repo.test.ts` — FOUND
- `tests/db/cascade.test.ts` — FOUND
- `tests/db/prepared-statement-invariant.test.ts` — FOUND
- `tests/attachments/paths.test.ts` — FOUND
- `tests/attachments/store.test.ts` — FOUND

Deleted file no longer exists:
- `tests/smoke.test.ts` — CONFIRMED REMOVED (via `git rm` in commit `89d8f34`)

Commits exist in `git log`:
- `c227099` — test(db): add schema and PRAGMA integration tests
- `c790076` — test(db): add repository and FK cascade tests
- `89d8f34` — test(attachments,db): add attachment store tests and D-21 invariant test

Plan-level gates re-executed on final state:
- `npm run typecheck` → exit 0
- `npm run check` → exit 0 (31 files, 0 findings)
- `npm test` → exit 0 (10 files, 49 tests, ~450ms)

Phase 2 success criteria (from ROADMAP.md):
1. ✅ Migration creates all tables (`tests/db/schema.test.ts`)
2. ✅ PRAGMAs correct (`tests/db/pragmas-integration.test.ts`)
3. ✅ Attachment bytes land at hash path (`tests/attachments/store.test.ts`)
4. ✅ Every SQL via prepared statements (`tests/db/prepared-statement-invariant.test.ts`)

Phase 2 is complete.
