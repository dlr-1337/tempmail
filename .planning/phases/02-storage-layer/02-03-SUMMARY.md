---
phase: 2
plan: 3
subsystem: repositories
tags: [sqlite, repositories, prepared-statements, transactions, better-sqlite3, typescript]
dependency_graph:
  requires: ["db-handle", "row-types", "nowMs", "newId"]
  provides:
    - "inbox-repo"
    - "message-repo"
    - "attachment-repo"
    - "abuse-repo"
    - "repos-aggregate"
    - "withTransaction"
  affects: ["02-05", "03-*", "04-*", "05-*", "06-*"]
tech_stack:
  added: []
  patterns:
    - "Repo = factory function taking Db, returning an object whose methods are closures over prepared statements (D-21)"
    - "Intent-named methods only — no query()/run()/exec() passthroughs (D-22)"
    - "withTransaction<T>(db, fn) — generic wrapper around db.transaction(fn)() preserving return type (D-23)"
    - "Atomic multi-row ingestion via withTransaction for message + attachments (CORE-03 foundation)"
    - "UPSERT + RETURNING for atomic counter increment (abuse-repo)"
    - "Typed param tuples + typed row generics on every db.prepare — no `any` anywhere"
    - "ReadonlySet<T> return for the orphan-reaper's sha256 lookup (O(1) membership test)"
key_files:
  created:
    - path: "src/db/transaction.ts"
      purpose: "withTransaction<T>(db, fn) — single-call-site wrapper around db.transaction(fn)()"
    - path: "src/db/repos/inbox-repo.ts"
      purpose: "createInboxRepo(db) — createInbox, findInboxById, findInboxByLocalPart, updateLastActivity, deleteInbox, listExpired"
    - path: "src/db/repos/message-repo.ts"
      purpose: "createMessageRepo(db) — insertMessageWithAttachments (atomic), findMessageById, listMessagesByInbox, countMessagesByInbox, deleteMessagesByInbox"
    - path: "src/db/repos/attachment-repo.ts"
      purpose: "createAttachmentRepo(db) — findAttachmentById, listAttachmentsByMessage, listAllSha256s (for orphan reaper), deleteAttachmentsByMessage"
    - path: "src/db/repos/abuse-repo.ts"
      purpose: "createAbuseRepo(db) — incrementCounter (UPSERT+RETURNING), getCounter, pruneOldCounters"
    - path: "src/db/repos/index.ts"
      purpose: "createRepos(db) aggregate factory + Repos type; re-exports all per-repo types"
  modified: []
decisions:
  - "D-20 materialized: createRepos(db) is the single aggregator; outside callers never touch db.prepare() directly"
  - "D-21 materialized: every SQL statement in the repo layer is a prepared statement cached in a closure on the repo object"
  - "D-22 materialized: every public method is intent-named; no query/run/exec passthroughs anywhere in src/db/repos/"
  - "D-23 materialized: withTransaction<T>(db, fn) is the single transaction call-site; used by insertMessageWithAttachments"
  - "Tuple-ordering fix on updateActivityStmt — plan source had the param tuple wrong for the SQL bind order (Rule 1 auto-fix)"
  - "nowMs() used for received_at default on message insert (plan source used bare Date.now()); consistent with util/now.ts test-swap pattern"
metrics:
  duration_minutes: ~12
  completed_date: "2026-04-18"
  tasks: 3
  files_created: 6
  files_modified: 0
requirements: [STORE-04]
---

# Phase 2 Plan 3: Repositories Summary

Built the four typed repositories (`inboxRepo`, `messageRepo`, `attachmentRepo`, `abuseRepo`) plus a transaction helper, all wired through a single `createRepos(db)` factory — the only surface the rest of the codebase will ever use to touch SQLite. STORE-04 is satisfied: every SQL statement in the repo layer is a prepared statement cached on the repo object, and callers cannot reach `db.prepare()` except through intent-named methods.

## What Was Built

### `src/db/transaction.ts` — `withTransaction<T>(db, fn): T`

A thin wrapper around `db.transaction(fn)()` with a generic so the return type is preserved without casts. Single call-site (D-23) for all multi-row atomicity in the codebase. Semantics mirror better-sqlite3: sync fn, commits on return, rolls back on throw, nested calls reuse the outer SAVEPOINT.

### `src/db/repos/inbox-repo.ts` — `InboxRepo`

```typescript
export interface NewInbox {
  local_part: string;
  domain: string;
  view_token_hash: string;
  expires_at: number;        // sliding TTL (idle) end
  hard_expires_at: number;   // absolute ceiling (RETN-01)
}

export interface InboxRepo {
  createInbox(input: NewInbox): InboxRow;
  findInboxById(id: string): InboxRow | undefined;
  findInboxByLocalPart(localPart: string, domain: string): InboxRow | undefined;
  updateLastActivity(id: string, newExpiresAt: number): InboxRow | undefined;
  deleteInbox(id: string): boolean;
  listExpired(cutoff: number, limit: number): readonly InboxRow[];
}

export function createInboxRepo(db: Db): InboxRepo;
```

Six prepared statements cached at construction. `updateLastActivity` enforces the RETN-01 hard cap at the SQL layer via `expires_at = MIN(?, hard_expires_at)` and guards past-cap extensions with `WHERE hard_expires_at > ?` — never in app code. `deleteInbox` relies on schema-level FK CASCADE to clean messages + attachment rows (disk unlinking is Plan 04's concern).

### `src/db/repos/message-repo.ts` — `MessageRepo`

```typescript
export interface NewMessage {
  inbox_id: string;
  sender: string | null;
  subject: string | null;
  text_body: string | null;
  html_body_sanitized: string | null;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string | null;
  headers_json: string | null;
  received_at?: number;  // default nowMs()
  id?: string;           // default newId()
}

export interface NewAttachment {
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  id?: string;           // default newId()
}

export interface InsertResult {
  messageId: string;
  attachmentIds: readonly string[];
}

export interface MessageRepo {
  insertMessageWithAttachments(
    message: NewMessage,
    attachments: readonly NewAttachment[],
  ): InsertResult;
  findMessageById(id: string): MessageRow | undefined;
  listMessagesByInbox(
    inboxId: string,
    opts: { limit: number; offset: number },
  ): readonly MessageRow[];
  countMessagesByInbox(inboxId: string): number;
  deleteMessagesByInbox(inboxId: string): number;
}

export function createMessageRepo(db: Db): MessageRepo;
```

Six prepared statements cached at construction. `insertMessageWithAttachments` is the hot path for Phase 4's SMTP ingestion: it wraps the message insert + N attachment inserts in a single `withTransaction`, so either everything commits or everything rolls back (CORE-03 atomicity foundation). Attachment IDs are pre-generated outside the transaction so the caller sees them back regardless of transaction nesting. `listMessagesByInbox` is the covered-index query backing Phase 5's GET `/inbox/:id/messages` listing (`ORDER BY received_at DESC` is served by `ix_messages_inbox_received` from Plan 02-02).

### `src/db/repos/attachment-repo.ts` — `AttachmentRepo`

```typescript
export interface AttachmentRepo {
  findAttachmentById(id: string): AttachmentRow | undefined;
  listAttachmentsByMessage(messageId: string): readonly AttachmentRow[];
  listAllSha256s(): ReadonlySet<string>;
  deleteAttachmentsByMessage(messageId: string): number;
}

export function createAttachmentRepo(db: Db): AttachmentRepo;
```

Four prepared statements cached at construction. `listAllSha256s` returns a `ReadonlySet<string>` so Phase 6's orphan reaper can walk the on-disk hash-shard tree and do O(1) "does this sha256 exist in the DB?" checks. `deleteAttachmentsByMessage` exists for the caller-delete-message-and-get-orphans pattern; in practice Phase 6 will just cascade via `deleteInbox`.

### `src/db/repos/abuse-repo.ts` — `AbuseRepo`

```typescript
export interface AbuseRepo {
  incrementCounter(ipPrefix: string, bucket: string, windowStart: number): number;
  getCounter(ipPrefix: string, bucket: string, windowStart: number): number;
  pruneOldCounters(cutoff: number): number;
}

export function createAbuseRepo(db: Db): AbuseRepo;
```

Three prepared statements cached at construction. `incrementCounter` is a single-SQL UPSERT with `RETURNING count` (SQLite 3.35+ / better-sqlite3@12 ships 3.45+): no read-modify-write race, one round-trip. Caller picks the window size by flooring `nowMs()` to e.g. 60000 — the repo is bucket-size-agnostic. `pruneOldCounters` is Phase 6's sweeper hook.

### `src/db/repos/index.ts` — `createRepos(db)` aggregator

```typescript
export interface Repos {
  inboxes: InboxRepo;
  messages: MessageRepo;
  attachments: AttachmentRepo;
  abuse: AbuseRepo;
}

export function createRepos(db: Db): Repos;

// Re-exports from each repo so callers import from one path:
export type { InboxRepo, NewInbox } from './inbox-repo.js';
export type { MessageRepo, NewMessage, NewAttachment, InsertResult } from './message-repo.js';
export type { AttachmentRepo } from './attachment-repo.js';
export type { AbuseRepo } from './abuse-repo.js';
```

Every outside caller (Phase 3 core, Phase 4 SMTP, Phase 5 HTTP, Phase 6 sweeper) imports from `src/db/repos/index.ts`. The four repos share one long-lived `Db` handle per D-19; `createRepos(db)` is called exactly once at process startup.

## Must-have Truths — Verified

| # | Truth | Verified |
| - | ----- | -------- |
| 1 | Every SQL op in the repo layer goes through a prepared statement cached on the repo object | Visual inspection: all SQL in `src/db/repos/*.ts` is `db.prepare(...)` assigned to a const in the factory closure; `.run`/`.get`/`.all` only on those consts. Zero ad-hoc `db.prepare(...)` calls inside method bodies. |
| 2 | No caller can get a raw `db.prepare()` / `db.exec()` — repos expose intent-named methods only | Grep of `src/` for `\.(prepare\|exec)\(` returns 3 hits, all in `src/db/client.ts` (the one module allowed to — migrations). Zero hits in `src/db/repos/` method bodies or anywhere else under `src/`. D-21 boundary intact. |
| 3 | `insertMessageWithAttachments()` is atomic: both the message row and all attachment rows commit, or neither does | End-to-end verify: (a) Task 2 verify shows 1 message + 1 attachment land together; (b) plan-level verify intentionally throws inside a `withTransaction` body and confirms the row it attempted did not land (counter stays 0 after the throw). |
| 4 | Repos return typed rows (InboxRow, MessageRow, AttachmentRow, AbuseCounterRow) — never `any` or untyped objects | All `db.prepare<Params, Result>` calls specify the `Result` generic explicitly (`InboxRow`, `MessageRow`, `AttachmentRow`, `{ count: number }`, `{ sha256: string }`). `tsc --strict --noUncheckedIndexedAccess` passes with zero `any`. |
| 5 | `createRepos(db)` is the single entry point that wires all four repos to a Db handle | `src/db/repos/index.ts` exports exactly `createRepos(db): Repos` + the per-repo types. One call, one handle, four repos. |

## Verification Results

All commands run from repo root:

```
npm run typecheck                                     -> exit 0 (no errors, no warnings)
npx biome check src/db/ src/util/                     -> exit 0 (10 files, clean)
Task 1 smoke (inbox-repo)                             -> "inbox-repo ok"
Task 2 smoke (message + attachment, FK CASCADE)       -> "message+attachment repos ok"
Task 3 smoke (abuse + createRepos aggregate)          -> "abuse-repo + createRepos ok"
Plan-level end-to-end verify                          -> "plan 02-03 end-to-end verify: ok"
```

End-to-end verify covers:
- Create inbox via `inboxRepo.createInbox`
- Insert message + 2 attachments atomically via `messageRepo.insertMessageWithAttachments`
- `countMessagesByInbox`, `listAttachmentsByMessage`, `listAllSha256s` all return expected values
- **Transaction rollback**: throwing inside `withTransaction` reverts the write (`incrementCounter` row does not land)
- **FK CASCADE**: deleting the inbox removes both message and attachment rows in the same DB
- `listExpired(cutoff, limit)` returns inboxes past the cutoff

D-21 boundary check:
```
grep -rE "\.(prepare|exec)\(" src/ --include="*.ts"
```
3 hits, all in `src/db/client.ts` (migration runner). Zero in `src/db/repos/` method bodies. Zero in `src/attachments/`. Zero elsewhere. STORE-04 boundary intact.

## Commits

| Task | Commit  | Files                                                  |
| ---- | ------- | ------------------------------------------------------ |
| 1. transaction helper + inbox repo | `bdf877f` | `src/db/transaction.ts`, `src/db/repos/inbox-repo.ts` |
| 2. message + attachment repos with atomic insert | `7dc84f0` | `src/db/repos/message-repo.ts`, `src/db/repos/attachment-repo.ts` |
| 3. abuse repo + createRepos aggregate | `6673d4a` | `src/db/repos/abuse-repo.ts`, `src/db/repos/index.ts` |
| 4. deferred-items update | `2537532` | `.planning/phases/02-storage-layer/deferred-items.md` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Tuple-ordering error on `updateActivityStmt`**
- **Found during:** Task 1, first `npm run typecheck` run.
- **Issue:** Plan source declared `db.prepare<[number, number, number, string]>(...)` for the `updateLastActivity` SQL. But the SQL binds its 4 params in the order (last_activity_at=number, new-expires=number, id=string, now-for-hard-cap=number). That is `[number, number, string, number]`. The plan had the 3rd and 4th positions swapped. `tsc` caught it at the `.run(now, newExpiresAt, id, now)` call site (`'string' is not assignable to parameter of type 'number'`).
- **Fix:** Corrected the tuple to `[number, number, string, number]` and added a clarifying comment above the `db.prepare` call. Zero runtime behavior change — the SQL itself and the `.run` argument order were both correct; only the TS tuple annotation was wrong.
- **Files modified:** `src/db/repos/inbox-repo.ts`
- **Commit:** `bdf877f` (Task 1)

**2. [Rule 3 — Blocking] Biome formatter wanted the 8-element param tuple on one line**
- **Found during:** Task 1, first `npm run check` run.
- **Issue:** Biome's line-break heuristic wants short-enough `db.prepare<[...]>(\`...\`)` calls with the generic on one line. The plan source had it broken across three lines.
- **Fix:** Collapsed `insertStmt`'s generic onto a single line. Identical semantics.
- **Files modified:** `src/db/repos/inbox-repo.ts`
- **Commit:** `bdf877f` (Task 1)

**3. [Rule 3 — Blocking] Biome formatter wanted the short SELECT/DELETE prepares on one line**
- **Found during:** Task 2, first `npm run check` run.
- **Issue:** Biome's line-break heuristic wanted `listShaStmt` and `deleteByMessageStmt` on a single line (short-enough calls).
- **Fix:** Collapsed the two calls. Identical semantics.
- **Files modified:** `src/db/repos/attachment-repo.ts`
- **Commit:** `7dc84f0` (Task 2)

**4. [Rule 1 — Consistency nit] Replaced bare `Date.now()` with `nowMs()` in `insertMessageWithAttachments`**
- **Found during:** Task 2, reading the plan source alongside `src/util/now.ts`.
- **Issue:** The plan source used `Date.now()` directly for the `received_at` default. Every other timestamp in the codebase (`createInbox`, `updateLastActivity`, migration runner) goes through `nowMs()` so tests can freeze time via `vi.spyOn(nowModule, 'nowMs')`. Leaving a bare `Date.now()` would create a hole in the test-swap story.
- **Fix:** Import `nowMs` and use it. Zero runtime behavior change in production; enables deterministic test freeze.
- **Files modified:** `src/db/repos/message-repo.ts`
- **Commit:** `7dc84f0` (Task 2)

### Out-of-scope Finding (Deferred)

**Biome `organizeImports` violation in `src/attachments/store.ts`**
- Untracked file belonging to Plan 02-04 (currently in-flight, concurrent). Plan 02-03's executor context explicitly forbids modifying `src/attachments/*`.
- Documented in `.planning/phases/02-storage-layer/deferred-items.md` item 3 for the 02-04 executor to address.
- Impact on Plan 02-03: `biome check .` (whole-tree) fails because of this unrelated file. `biome check src/db/ src/util/` (this plan's scope) passes clean. My `Done` criteria is therefore satisfied at the scope boundary.

## Known Stubs

None. Every declared export is implemented with real SQL. No placeholder values rendered to any UI. No mocks, no TODOs.

## Threat Flags

None. This plan adds no network surface, no auth path, no untrusted-file-access, and no schema changes at a trust boundary. All inputs (local_part, domain, view_token_hash, message fields, attachment metadata) come from upstream plans (Phase 3 core and Phase 4 SMTP) that handle sanitization and validation; the repos simply persist typed values. Threat surface scan of created files: clean.

## Self-Check: PASSED

Created files exist:
- `src/db/transaction.ts` — present
- `src/db/repos/inbox-repo.ts` — present
- `src/db/repos/message-repo.ts` — present
- `src/db/repos/attachment-repo.ts` — present
- `src/db/repos/abuse-repo.ts` — present
- `src/db/repos/index.ts` — present

Commits exist in `git log`:
- `bdf877f` — feat(db): add transaction helper and inbox repository
- `7dc84f0` — feat(db): add message and attachment repositories with atomic insert
- `6673d4a` — feat(db): add abuse counter repository and repos aggregate factory
- `2537532` — docs(02-03): note resolved items and new deferred finding

All plan-level verifications executed and passed (typecheck, biome check on scope, three task-level smokes, plan-level end-to-end verify covering atomic ingestion, transaction rollback, FK CASCADE, and listExpired).
