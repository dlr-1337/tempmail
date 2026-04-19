# Phase 2 — Deferred Items (out-of-scope discoveries)

Logged per GSD executor Scope Boundary rule: these findings are NOT caused by
the current plan's changes and belong to another plan's scope.

## From Plan 02-04 execution (2026-04-18)

### 1. Pre-existing typecheck failure in plan 02-03's `inbox-repo.ts`

- **Where:** `src/db/repos/inbox-repo.ts:122`
- **Error:** `TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`
- **Scope owner:** Plan 02-03 (repositories). Plan 02-04 is explicitly forbidden from touching `src/db/repos/*`.
- **Action:** Left for Plan 02-03 executor / Plan 02-05 verifier to address.

### 2. Pre-existing biome formatter diff in plan 02-03's `inbox-repo.ts`

- **Where:** `src/db/repos/inbox-repo.ts:43-47`
- **Finding:** Biome wants the generic-typed `db.prepare<[...]>` call on a single line.
- **Scope owner:** Plan 02-03. Not introduced by plan 02-04's files.
- **Action:** Left for Plan 02-03 executor to address (e.g. via `npm run check:fix`).

## Confirmation that plan 02-04's own files are clean

- `src/attachments/paths.ts`, `src/attachments/store.ts`, `src/attachments/index.ts`
  typecheck standalone with the project's strict settings (target ES2023, NodeNext,
  strict, noUncheckedIndexedAccess, verbatimModuleSyntax).
- Biome formatting was run with `check:fix` on the three plan 02-04 files only —
  they emit no diagnostics.

## From Plan 02-03 execution (2026-04-18)

### Resolution of items 1 and 2 above

Both items 1 (tuple-ordering typecheck error on `updateActivityStmt`) and
2 (formatter diff on the long generic) were auto-fixed by Plan 02-03's
Task 1 commit (`feat(db): add transaction helper and inbox repository`)
as Rule 1 / Rule 3 deviations. Items 1 and 2 can be considered CLOSED.

### 3. New finding: biome organizeImports on `src/attachments/store.ts`

- **Where:** `src/attachments/store.ts:20`
- **Finding:** Biome wants
  `{ createReadStream, createWriteStream, constants as fsConstants }`;
  file has `{ constants as fsConstants, createReadStream, createWriteStream }`.
- **Scope owner:** Plan 02-04 (attachment-store). Plan 02-03 is explicitly
  forbidden from touching `src/attachments/*`.
- **Action:** Left for Plan 02-04 executor / Plan 02-05 verifier to address.
  Fix is a one-line import re-order. Plan 02-03's own files
  (`src/db/repos/*`, `src/db/transaction.ts`) pass `biome check` cleanly
  when scoped to those directories.
