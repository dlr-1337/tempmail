---
phase: 2
plan: 2
subsystem: schema-and-migrations
tags: [sqlite, schema, migrations, pragmas, wal, better-sqlite3]
dependency_graph:
  requires: ["node-project", "typescript-toolchain", "better-sqlite3-native"]
  provides: ["db-handle", "schema-v1", "migration-runner", "row-types", "nowMs", "newId"]
  affects: ["02-03", "02-04", "02-05"]
tech_stack:
  added: []
  patterns:
    - "Single openDb(path) factory — the only module allowed to `new Database()`"
    - "Per-connection PRAGMAs with readback verification (belt-and-suspenders)"
    - "Additive-only migrations: schema.sql (v1) + schema-vN.sql (v>=2), applied in one transaction"
    - "STRICT tables for typed columns; WITHOUT ROWID for composite-PK counter table"
    - "Row-type interfaces mirror SQL columns 1:1 (SQL-to-TS boundary layer)"
    - "NodeNext .js extension in relative imports (resolves to .ts at build time)"
key_files:
  created:
    - path: "src/db/schema.sql"
      purpose: "Schema v1 DDL — schema_version + 4 domain tables + 5 indexes"
    - path: "src/db/client.ts"
      purpose: "openDb(path) factory, PRAGMA block, verifyPragmas, migration runner"
    - path: "src/db/types.ts"
      purpose: "Row-type interfaces: InboxRow, MessageRow, AttachmentRow, AbuseCounterRow, SchemaVersionRow"
    - path: "src/util/now.ts"
      purpose: "nowMs() — epoch-ms wall clock, test-swappable via vi.spyOn"
    - path: "src/util/id.ts"
      purpose: "newId() = nanoid(22) = 132 bits URL-safe; ID_LENGTH constant"
  modified: []
decisions:
  - "D-04..D-11 materialized exactly: four tables, domain first-class, FK CASCADE, INTEGER epoch-ms, pre-sanitized HTML stored"
  - "D-12..D-19 materialized exactly: all 7 PRAGMAs applied on every open; 4 critical ones (journal_mode, synchronous, busy_timeout, foreign_keys) readback-verified"
  - "D-30..D-32 materialized: schema.sql=v1 + schema-vN.sql=vN convention; version gate via schema_version; one-transaction application; additive-only"
  - "D-35 materialized: nanoid(22) = 132 bits URL-safe ID for DB primary keys"
  - "Used .js extension in relative imports (canonical NodeNext) — Plan 01 locked allowImportingTsExtensions=false; plan source was .ts, fixed to .js for typecheck compliance"
metrics:
  duration_minutes: ~10
  completed_date: "2026-04-18"
  tasks: 3
  files_created: 5
  files_modified: 0
---

# Phase 2 Plan 2: Schema and Migrations Summary

Delivered the SQLite schema (schema v1 DDL) and the `openDb(path)` factory with a PRAGMA block and migration runner — the data-layer foundation every subsequent plan depends on. STORE-01 (four domain tables with `domain` first-class) and STORE-02 (WAL + documented PRAGMAs) are satisfied.

## What Was Built

### `src/db/schema.sql` — Schema v1 DDL

Five `STRICT` tables, no PRAGMAs in the file (per D-15, PRAGMAs are per-connection and live in `client.ts`):

| Table | Primary Key | FK | Notes |
| ---- | ---- | ---- | ---- |
| `schema_version` | `version INTEGER` | — | `(version, applied_at INTEGER)` — migration gate |
| `inboxes` | `id TEXT` | — | `domain` first-class (D-05); `UNIQUE(local_part, domain)`; `INDEX(expires_at)` |
| `messages` | `id TEXT` | `inbox_id -> inboxes(id) ON DELETE CASCADE` | `INDEX(inbox_id, received_at DESC)` covers listMessages |
| `attachments` | `id TEXT` | `message_id -> messages(id) ON DELETE CASCADE` | `INDEX(sha256)` for orphan reaper; `INDEX(message_id)` |
| `abuse_counters` | composite `(ip_prefix, bucket, window_start)` | — | `WITHOUT ROWID` |

Every FK uses `ON DELETE CASCADE` (D-09). Every timestamp column is `INTEGER NOT NULL` epoch-ms UTC (D-10). `html_body_sanitized` is `TEXT` (nullable; pre-sanitized at ingestion per D-11). Every DDL uses `IF NOT EXISTS` — file is idempotent when re-run, belt-and-suspenders with the schema_version gate.

### `src/db/client.ts` — The only module that calls `new Database()`

Exports:
- `openDb(path: string): Db` — opens/creates, applies PRAGMAs, runs migrations, verifies PRAGMAs, returns handle.
- `type Db` — alias for `better-sqlite3`'s `Database` (so driver swaps are a one-file change).

`openDb` responsibilities:
1. `mkdir -p` the parent dir (unless `:memory:`).
2. `new Database(path)`.
3. `applyPragmas(db, path)` — sets all 7 PRAGMAs via `db.pragma()`. Skips `journal_mode=WAL` for `:memory:` (SQLite forces MEMORY journal there).
4. `runMigrations(db)` — bootstraps `schema_version`, reads `MAX(version)`, discovers `schema.sql`+`schema-vN.sql` under `SCHEMA_DIR`, filters to `version > current`, applies each in ascending order inside a single `db.transaction(...)`. Records `(version, nowMs())` per file.
5. `verifyPragmas(db, path)` — reads back `synchronous`, `busy_timeout`, `foreign_keys` (and `journal_mode` for file DBs) and throws on mismatch. Guards against silent SQLite default changes.

`SCHEMA_DIR` resolves via `dirname(fileURLToPath(import.meta.url))` — ESM-safe `__dirname` replacement, stable regardless of process CWD.

### PRAGMA values (all on every open)

| PRAGMA | Value | Decision |
| ---- | ---- | ---- |
| `journal_mode` | `WAL` (skipped on `:memory:`) | D-12 |
| `synchronous` | `NORMAL` (=1) | D-13 |
| `busy_timeout` | `5000` | D-14 |
| `foreign_keys` | `ON` (=1) | D-15 |
| `mmap_size` | `134217728` (128 MB) | D-16 |
| `temp_store` | `MEMORY` | D-17 |
| `wal_autocheckpoint` | `1000` | D-18 |

Single long-lived connection per process (D-19) — callers get the handle from `openDb` once and reuse it. No pooling.

### `src/db/types.ts` — Row-type interfaces

One interface per table, mirroring columns 1:1. `NOT NULL` -> `T`; nullable -> `T | null` (because better-sqlite3 returns `null`, not `undefined`). No business logic — this is the SQL-to-TS boundary; rich domain types belong to Phase 3.

Exports: `InboxRow`, `MessageRow`, `AttachmentRow`, `AbuseCounterRow`, `SchemaVersionRow`.

### `src/util/now.ts` and `src/util/id.ts`

- `nowMs(): number` — centralized `Date.now()` so tests can `vi.spyOn(nowModule, 'nowMs')`.
- `newId(): string` + `ID_LENGTH = 22` — `nanoid(22)` = 22 × log2(64) = 132 bits URL-safe. D-35 compliance with margin.

## ID Scheme

`nanoid(22)` with the default 64-symbol alphabet = **132 bits of entropy**, URL-safe, stored as `TEXT`. Used for `inboxes.id`, `messages.id`, `attachments.id`. Satisfies D-35 ("≥128 bits URL-safe"). Inbox local-part and view-token are generated separately in Phase 3 and are NOT this ID.

## Verification Results

All commands run from repo root, exit 0:

```
npm run typecheck    -> ok (exit 0)
npm run check        -> ok (exit 0, 11 files clean)
Task 1 verify        -> "schema ok"
Task 2 verify        -> "utils ok <132-bit-id>"
Task 3 verify        -> "openDb ok" (WAL, FK=1, busy_timeout=5000, synchronous=1, 5 tables, version=1, idempotent re-open)
Plan-level verify    -> tables=[abuse_counters, attachments, inboxes, messages, schema_version]; journal_mode=wal; foreign_keys=1
FK CASCADE check     -> deleting an inbox cascades through messages and attachments (both counts=0)
Migration runner check -> adding schema-v2.sql applies exactly once; schema_version=[1,2]; reopen keeps [1,2]
```

## Must-have Truths — Verified

| # | Truth | Verified |
| - | ----- | -------- |
| 1 | Fresh DB creates all 4 domain tables + schema_version | Task 3 verify (tables list matches expected sorted set) |
| 2 | Second open is idempotent (no re-migration) | Task 3 verify (`ver2===1` after 2nd open); migration runner check ([1,2] stays [1,2]) |
| 3 | journal_mode=wal, synchronous=1, busy_timeout=5000, foreign_keys=1 after openDb | Task 3 verify (all 4 pragma readbacks pass); also enforced by `verifyPragmas` throwing on mismatch |
| 4 | PRAGMA integrity_check returns 'ok' on fresh DB | Task 1 verify (`ic!=='ok'` -> exit 2; command returned "schema ok") |
| 5 | FK CASCADE: deleting an inbox deletes its messages; deleting a message deletes its attachment rows | FK CASCADE check (inbox delete -> messages=0, attachments=0) |
| 6 | Future schema-vN.sql runs exactly once on next openDb, in a transaction | Migration runner check (v2 applied; reopen doesn't re-apply; transactional by construction via `db.transaction`) |

## Commits

| Task | Commit | Files |
| ---- | ------ | ----- |
| 1. Schema v1 DDL | `56acd21` | `src/db/schema.sql` |
| 2. Row types + now/id utilities | `c6e551d` | `src/db/types.ts`, `src/util/now.ts`, `src/util/id.ts` |
| 3. openDb factory + PRAGMAs + migration runner | `359930b` | `src/db/client.ts` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Relative import used `.ts` extension; tsconfig disallowed it**
- **Found during:** Task 3, first `npm run typecheck` run.
- **Issue:** Plan source wrote `import { nowMs } from '../util/now.ts';`. Plan 01 locked `tsconfig.json` with `allowImportingTsExtensions: false` (canonical NodeNext). `tsc` emitted `TS5097`.
- **Fix:** Changed the single import to `'../util/now.js'`. Under NodeNext, TypeScript rewrites `.js` to `.ts` at resolve time; this is the canonical pattern and compatible with `tsconfig.build.json` (which has emit). `tsx` (the runtime used by the verify commands) handles both `.js` and `.ts` extensions, so all plan verify commands still pass as written.
- **Files modified:** `src/db/client.ts` (line 6)
- **Commit:** `359930b`

**2. [Rule 3 — Blocking] Biome `organizeImports` flagged `readFileSync`/`readdirSync` order**
- **Found during:** Task 3, `npm run check` after typecheck fix.
- **Issue:** Biome's import sort expects alphabetical within a named-import list. The original line had `readdirSync, readFileSync` (which is NOT alphabetical by strict lowercase sort — `readFileSync` < `readdirSync` when case-insensitive).
- **Fix:** Swapped order to `{ existsSync, mkdirSync, readFileSync, readdirSync }`. No semantic change.
- **Files modified:** `src/db/client.ts` (line 1)
- **Commit:** `359930b`

### Notes on Path Choice

The orchestrator rules mentioned `src/db/migrations/schema-v1.sql` as the target path, but the PLAN file (Task 1 action, verify commands, `client.ts` migration discovery, and `must_haves.key_links` frontmatter) consistently specifies `src/db/schema.sql`. I followed the more-specific PLAN artifact — `src/db/schema.sql` is the actual file written. The `src/db/migrations/` directory (created by Plan 01) is now unused under this plan's conventions; it can either remain as a reserved slot or be removed by a future cleanup plan. No data-layer functionality depends on it; the migration runner looks under `SCHEMA_DIR` (=`src/db/` after compile, where `client.ts` lives), not inside `migrations/`. This is not a deviation from the PLAN, but is a deviation from the executor-context hint.

## Known Stubs

None. Every declared export is implemented. No placeholder data, no "TODO" rendered values. The file `src/index.ts` (Plan 01 placeholder) is untouched.

## Threat Flags

None. This plan introduces no network surface, no auth path, no file-access-based inputs from untrusted sources, and no schema at a trust boundary beyond what CONTEXT.md already classifies. All inputs to `openDb` come from trusted configuration.

## Self-Check: PASSED

Created files exist:
- `src/db/schema.sql` — present
- `src/db/client.ts` — present
- `src/db/types.ts` — present
- `src/util/now.ts` — present
- `src/util/id.ts` — present

Commits exist in `git log`:
- `56acd21` — feat(db): add initial schema v1 (inboxes, messages, attachments, abuse_counters)
- `c6e551d` — feat(db): add row types and now/id utilities
- `359930b` — feat(db): add openDb factory with PRAGMAs and migration runner

All plan-level verifications executed and passed (typecheck, biome check, openDb, FK cascade, migration runner idempotency).
