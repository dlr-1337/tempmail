---
phase: 2
plan: 2
type: execute
wave: 2
status: ready
depends_on: [1]
files_modified:
  - src/db/schema.sql
  - src/db/client.ts
  - src/db/types.ts
  - src/util/now.ts
  - src/util/id.ts
autonomous: true
requirements: [STORE-01, STORE-02]
must_haves:
  truths:
    - "Opening a fresh DB path creates all four tables (inboxes, messages, attachments, abuse_counters) plus schema_version"
    - "Opening the same path a second time does NOT re-run migrations (idempotent)"
    - "After openDb, PRAGMA journal_mode returns 'wal', synchronous returns 1 (NORMAL), busy_timeout returns 5000, foreign_keys returns 1"
    - "PRAGMA integrity_check returns 'ok' on a freshly-initialized DB"
    - "Every FK is declared ON DELETE CASCADE (deleting an inbox deletes its messages; deleting a message deletes its attachment rows)"
    - "Adding a future schema-vN.sql file runs it exactly once on next openDb, inside a transaction"
  artifacts:
    - path: "src/db/schema.sql"
      provides: "Initial schema v1 — four domain tables + schema_version"
      contains: "CREATE TABLE inboxes"
    - path: "src/db/client.ts"
      provides: "openDb(path) factory + migration runner + PRAGMA block"
      exports: ["openDb", "type Db"]
    - path: "src/db/types.ts"
      provides: "TypeScript row types (InboxRow, MessageRow, AttachmentRow, AbuseCounterRow)"
      exports: ["InboxRow", "MessageRow", "AttachmentRow", "AbuseCounterRow"]
    - path: "src/util/now.ts"
      provides: "nowMs() — wall-clock epoch milliseconds, test-swappable via Vitest spy"
      exports: ["nowMs"]
    - path: "src/util/id.ts"
      provides: "newId() — URL-safe ≥128-bit random ID (nanoid)"
      exports: ["newId", "ID_LENGTH"]
  key_links:
    - from: "src/db/client.ts"
      to: "src/db/schema.sql"
      via: "fs.readFileSync at openDb()"
      pattern: "readFileSync.*schema"
    - from: "src/db/client.ts"
      to: "better-sqlite3"
      via: "new Database(path, options)"
      pattern: "new Database"
---

<objective>
Define the initial SQLite schema and write the `openDb(path)` factory that applies PRAGMAs, bootstraps the schema_version table, runs pending migrations in a single transaction, and returns a ready-to-use `better-sqlite3` `Database` handle.

This plan does NOT create the repositories (that's plan 03) and does NOT create the attachment store (plan 04). It produces the raw `Db` handle and schema every later plan depends on.

Purpose: Satisfies STORE-01 (four-table schema with `domain` first-class) and STORE-02 (WAL + documented PRAGMAs). Implements D-04..D-19 and D-30..D-32.

Output: A single exported `openDb(path: string): Db` function that is correct, idempotent, re-openable, and has a verifiable effect on the filesystem (creates `<path>`, `<path>-wal`, `<path>-shm`).
</objective>

<execution_context>
Depends on Plan 02-01 (scaffolding). Run `npm install` if not already done.

All code is TypeScript with strict mode + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` per tsconfig.json. Explicit `import type { X }` for type-only imports is mandatory.
</execution_context>

<context>
@.planning/phases/02-storage-layer/02-CONTEXT.md
@.planning/phases/02-storage-layer/02-01-PLAN-project-scaffolding.md
@.planning/research/STACK.md
@.planning/research/ARCHITECTURE.md
@.planning/research/PITFALLS.md
</context>

<locked_decisions>
### Schema (D-04..D-11)
- **D-04:** Four tables: `inboxes`, `messages`, `attachments`, `abuse_counters`
- **D-05:** `inboxes(id TEXT PK, local_part TEXT, domain TEXT, view_token_hash TEXT, created_at INT, last_activity_at INT, expires_at INT, hard_expires_at INT)` — `domain` is a first-class column (v1 ships single-domain; data model supports N)
- **D-06:** `messages(id TEXT PK, inbox_id TEXT FK, sender TEXT, subject TEXT, text_body TEXT, html_body_sanitized TEXT, received_at INT, size_bytes INT, envelope_from TEXT, envelope_to TEXT, headers_json TEXT)`
- **D-07:** `attachments(id TEXT PK, message_id TEXT FK, filename TEXT, content_type TEXT, size_bytes INT, sha256 TEXT, storage_path TEXT)` — `storage_path` stores the relative hash-sharded path
- **D-08:** `abuse_counters(ip_prefix TEXT, bucket TEXT, count INT, window_start INT, PRIMARY KEY(ip_prefix, bucket, window_start))`
- **D-09:** All FKs with `ON DELETE CASCADE`
- **D-10:** Timestamps are integer epoch milliseconds (UTC), not TEXT
- **D-11:** `html_body_sanitized` is stored already sanitized (sanitization happens at ingestion time in Phase 4; renderers trust this column)

### PRAGMAs (D-12..D-19)
- **D-12:** `journal_mode=WAL`
- **D-13:** `synchronous=NORMAL`
- **D-14:** `busy_timeout=5000`
- **D-15:** `foreign_keys=ON` (must set on every connection; not stored in DB file per CONTEXT.md gotchas)
- **D-16:** `mmap_size=134217728` (128 MB)
- **D-17:** `temp_store=MEMORY`
- **D-18:** `wal_autocheckpoint=1000`
- **D-19:** Single long-lived connection per process

### Migrations (D-30..D-32)
- **D-30:** No migrations framework — `schema.sql` + `schema-vN.sql` files, applied on open if `schema_version` is missing or lower than latest
- **D-31:** `schema_version` table tracks monotonically increasing integer; all pending migrations applied in one transaction on open
- **D-32:** Backward-compatible-only migrations in v1 (additive only)

### IDs (D-35)
- **D-35:** `nanoid` for IDs; choose ≥128-bit length. Decision: use `nanoid(22)` with default alphabet (URL-safe, 64 symbols) → 22*log2(64) = 132 bits. Store as `TEXT`.
</locked_decisions>

## Goal

An `openDb(path)` function that returns a fully-initialized `better-sqlite3` database handle with: four domain tables + `schema_version`, all seven PRAGMAs applied, FK CASCADE everywhere, and a migration runner that will cleanly apply future `schema-vN.sql` files. Opening the same path twice must be idempotent. Verifiable via unit tests in plan 05.

## Must-have checklist

- **STORE-01**: Four tables (`inboxes`, `messages`, `attachments`, `abuse_counters`) with `domain` as a first-class column on `inboxes`
- **STORE-02**: WAL + documented PRAGMAs (`synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`)

## Tasks

#### Task 1: Write the initial schema file (`src/db/schema.sql`)

**Files:**
- `src/db/schema.sql`

**Action:**

Create `src/db/schema.sql` with the EXACT contents below. This is schema version 1. It is pure DDL: no PRAGMAs (those belong to `client.ts` per D-15 because `foreign_keys` must be set per-connection and is not persisted in the DB file), no INSERT, no data.

```sql
-- Tempmail schema v1
-- This file is run once on a fresh DB, then recorded in schema_version.
-- PRAGMAs are set by the client wrapper on every connection (not here).

-- Schema version tracking (D-30, D-31).
-- The client reads MAX(version) on open; if missing or < latest, runs pending migrations.
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
) STRICT;

-- Inboxes (D-05). The `domain` column is first-class so multi-domain (v2) is a pure INSERT change.
CREATE TABLE IF NOT EXISTS inboxes (
  id                TEXT PRIMARY KEY,
  local_part        TEXT NOT NULL,
  domain            TEXT NOT NULL,
  view_token_hash   TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  hard_expires_at   INTEGER NOT NULL
) STRICT;

-- Public address is (local_part, domain). v1 ships single-domain; uniqueness still enforced across both columns.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inboxes_local_domain
  ON inboxes(local_part, domain);

-- Sweeper scans expired inboxes by expires_at. Index mandatory.
CREATE INDEX IF NOT EXISTS ix_inboxes_expires_at
  ON inboxes(expires_at);

-- Messages (D-06). FK to inboxes with CASCADE (D-09).
CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT PRIMARY KEY,
  inbox_id              TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  sender                TEXT,
  subject               TEXT,
  text_body             TEXT,
  html_body_sanitized   TEXT,
  received_at           INTEGER NOT NULL,
  size_bytes            INTEGER NOT NULL,
  envelope_from         TEXT,
  envelope_to           TEXT,
  headers_json          TEXT
) STRICT;

-- listMessages(inbox_id) ORDER BY received_at DESC — covered index.
CREATE INDEX IF NOT EXISTS ix_messages_inbox_received
  ON messages(inbox_id, received_at DESC);

-- Attachments (D-07). FK to messages with CASCADE (D-09). Bytes live on disk; this table is metadata only.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL
) STRICT;

-- Orphan reaper (Phase 6) will walk the attachments dir and ask "does this sha256 appear in the DB?" — index needed.
CREATE INDEX IF NOT EXISTS ix_attachments_sha256
  ON attachments(sha256);

-- Listing a message's attachments — covered by (message_id).
CREATE INDEX IF NOT EXISTS ix_attachments_message
  ON attachments(message_id);

-- Abuse counters (D-08). Composite PK on (ip_prefix, bucket, window_start).
-- ip_prefix is the /24 for IPv4 or /64 for IPv6 per the "Specific Ideas" section of CONTEXT.md.
-- bucket is a short string like 'inbox_create', 'msg_read', 'smtp_ingest'.
-- window_start is the floor of the rate-limit window start, unix ms.
CREATE TABLE IF NOT EXISTS abuse_counters (
  ip_prefix     TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  PRIMARY KEY (ip_prefix, bucket, window_start)
) STRICT, WITHOUT ROWID;
```

Notes:
- `STRICT` on every table — SQLite 3.37+ feature that actually enforces column types. Not the default; must be opted in. Our type assertions in TS depend on this (no silently-coerced TEXT-in-INTEGER-column rows).
- `WITHOUT ROWID` on `abuse_counters` — tiny rows, composite PK, no secondary indexes; avoids the rowid overhead.
- FK declarations are present on `messages.inbox_id` and `attachments.message_id`, but SQLite does NOT enforce FKs unless `PRAGMA foreign_keys = ON` is active on the connection. The client will set that PRAGMA on every open.
- `IF NOT EXISTS` on every DDL statement — makes this schema file idempotent when re-run, belt-and-suspenders with the schema_version gate.

**Verify:**

```xml
<verify>
  <automated>node --input-type=module -e "import Database from 'better-sqlite3';import {readFileSync} from 'node:fs';const sql=readFileSync('src/db/schema.sql','utf8');const db=new Database(':memory:');db.pragma('foreign_keys=ON');db.exec(sql);const tables=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name);const expected=['abuse_counters','attachments','inboxes','messages','schema_version'];if(JSON.stringify(tables)!==JSON.stringify(expected)){console.error('got',tables);process.exit(1)}const ic=db.pragma('integrity_check',{simple:true});if(ic!=='ok')process.exit(2);console.log('schema ok');db.close()"</automated>
</verify>
```

**Done:**
- `src/db/schema.sql` exists and parses without error when fed to a fresh `:memory:` SQLite.
- All five expected tables (`schema_version`, `inboxes`, `messages`, `attachments`, `abuse_counters`) exist after execution.
- `PRAGMA integrity_check` returns `ok`.
- File is idempotent (running it twice does not error thanks to `IF NOT EXISTS`).

**Commit message:** `feat(db): add initial schema v1 (inboxes, messages, attachments, abuse_counters)`

---

#### Task 2: Write utility helpers (`src/util/now.ts`, `src/util/id.ts`) and row types (`src/db/types.ts`)

**Files:**
- `src/util/now.ts`
- `src/util/id.ts`
- `src/db/types.ts`

**Action:**

1. Create `src/util/now.ts`. This exists because direct `Date.now()` is a pain to mock; `nowMs()` is trivially spied in Vitest with `vi.spyOn`:

```typescript
/**
 * Returns the current wall-clock time in epoch milliseconds (UTC).
 *
 * Why this exists:
 * - All timestamps in the schema are INTEGER epoch ms (D-10).
 * - Centralizing now() lets tests freeze time via `vi.spyOn(nowModule, 'nowMs')`.
 * - Matches the type expected by `inboxes.created_at`, etc., without casts.
 */
export function nowMs(): number {
  return Date.now();
}
```

2. Create `src/util/id.ts`. Uses `nanoid` per D-35. Length 22 gives ~132 bits of entropy, URL-safe, well over the "≥128 bits" requirement:

```typescript
import { nanoid } from 'nanoid';

/**
 * Length of every ID produced by `newId()`.
 *
 * 22 chars * log2(64) alphabet = 132 bits of entropy.
 * Satisfies D-35 ("≥128-bit URL-safe ID") with margin.
 *
 * Used for all primary keys in the schema:
 * - inboxes.id, messages.id, attachments.id
 *
 * NOT used for:
 * - inbox local-part (that's a separate, shorter ID generated in Phase 3 core logic;
 *   see CORE-01, which requires ≥64 bits via `nanoid(16, base32)`).
 * - view_token (Phase 3 generates + hashes; this module doesn't own that).
 */
export const ID_LENGTH = 22;

/**
 * Generates a new URL-safe 132-bit random identifier.
 *
 * Use for DB primary keys only. Never expose raw IDs in URL paths that third
 * parties might log (per PITFALLS.md §9 enumeration — the address is separate).
 */
export function newId(): string {
  return nanoid(ID_LENGTH);
}
```

3. Create `src/db/types.ts`. These are the *row* types — exactly the columns as they come out of `better-sqlite3`. They mirror `schema.sql` one-to-one:

```typescript
/**
 * Row types for the tempmail schema v1.
 *
 * Every field corresponds exactly to a column in src/db/schema.sql.
 * Types follow SQLite STRICT + our NOT NULL declarations:
 *   - SQL `INTEGER NOT NULL` -> TS `number`
 *   - SQL `TEXT NOT NULL`    -> TS `string`
 *   - SQL `TEXT` (nullable)  -> TS `string | null`
 *
 * better-sqlite3 returns `null` (not `undefined`) for NULL columns.
 *
 * Do NOT add business-logic fields here. This file is the SQL-to-TS boundary;
 * richer domain types (e.g., `Inbox` with a `Date` field) belong to Phase 3.
 */

export interface InboxRow {
  id: string;
  local_part: string;
  domain: string;
  view_token_hash: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  hard_expires_at: number;
}

export interface MessageRow {
  id: string;
  inbox_id: string;
  sender: string | null;
  subject: string | null;
  text_body: string | null;
  html_body_sanitized: string | null;
  received_at: number;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string | null;
  headers_json: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
}

export interface AbuseCounterRow {
  ip_prefix: string;
  bucket: string;
  count: number;
  window_start: number;
}

export interface SchemaVersionRow {
  version: number;
  applied_at: number;
}
```

**Verify:**

```xml
<verify>
  <automated>npm run typecheck && node --input-type=module -e "import {newId,ID_LENGTH} from './src/util/id.ts';import {nowMs} from './src/util/now.ts';const id=newId();if(id.length!==ID_LENGTH)process.exit(1);if(typeof nowMs()!=='number')process.exit(2);console.log('utils ok',id)" 2>&1 || npx tsx -e "import {newId,ID_LENGTH} from './src/util/id.ts';import {nowMs} from './src/util/now.ts';const id=newId();if(id.length!==ID_LENGTH)process.exit(1);if(typeof nowMs()!=='number')process.exit(2);console.log('utils ok',id)"</automated>
</verify>
```

(The Node `--input-type=module` path may fail on `.ts` without a loader; the `npx tsx -e` fallback is the authoritative check. Either passing is fine.)

**Done:**
- `src/util/now.ts` exports `nowMs()` returning `number`.
- `src/util/id.ts` exports `newId()` returning a 22-char string + `ID_LENGTH` constant.
- `src/db/types.ts` exports `InboxRow`, `MessageRow`, `AttachmentRow`, `AbuseCounterRow`, `SchemaVersionRow` interfaces.
- `npm run typecheck` passes.

**Commit message:** `feat(db): add row types and now/id utilities`

---

#### Task 3: Write `openDb(path)` factory with PRAGMA block and migration runner (`src/db/client.ts`)

**Files:**
- `src/db/client.ts`

**Action:**

Create `src/db/client.ts`. This is the ONLY module in the codebase allowed to instantiate `better-sqlite3`. Every other module takes a `Db` handle.

```typescript
import Database, { type Database as BetterSqliteDb } from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowMs } from '../util/now.ts';

/**
 * The public Db handle type. Callers see `Db`, never `BetterSqliteDb`,
 * so swapping drivers in the future is a single-file change.
 */
export type Db = BetterSqliteDb;

/**
 * Directory containing schema.sql and any future schema-vN.sql migration files.
 * Resolved at module load so the path is stable regardless of process CWD.
 */
const SCHEMA_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The PRAGMAs applied to every connection on open (D-12..D-18).
 *
 * Order matters:
 *   1. `journal_mode=WAL` must be set BEFORE any write.
 *   2. `foreign_keys=ON` is per-connection and NOT persisted in the DB file —
 *      it MUST be re-applied on every open (see CONTEXT.md "Known Gotchas").
 *   3. `busy_timeout` must be high enough to survive the checkpoint pause.
 */
const PRAGMAS: ReadonlyArray<readonly [string, string | number]> = [
  ['journal_mode', 'WAL'],            // D-12
  ['synchronous', 'NORMAL'],          // D-13
  ['busy_timeout', 5000],             // D-14
  ['foreign_keys', 'ON'],             // D-15
  ['mmap_size', 134_217_728],         // D-16: 128 MB
  ['temp_store', 'MEMORY'],           // D-17
  ['wal_autocheckpoint', 1000],       // D-18
];

/**
 * Opens (or creates) a SQLite database at `path`, applies PRAGMAs, and runs any
 * pending migrations in a single transaction. Returns a ready-to-use `Db` handle.
 *
 * Idempotent: calling `openDb(path)` twice on the same path is safe; migrations
 * are gated by `schema_version`.
 *
 * Concurrency: the returned handle is single-process, single-connection (D-19).
 * Do NOT share the handle across processes; do NOT pool. better-sqlite3 is
 * synchronous and thread-safe only in the sense that SQLite itself is.
 *
 * Special values:
 *   - path === ':memory:' -> opens an ephemeral in-memory DB. PRAGMAs still apply,
 *     but journal_mode defaults to MEMORY regardless; that's SQLite behavior.
 *     Used by unit tests (D-33).
 *
 * @throws if the DB file is corrupt, if migrations fail, or if PRAGMA reads back
 *         an unexpected value (defense-in-depth: catches a future SQLite default change).
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') {
    // Ensure parent dir exists. Callers pass e.g. './data/tempmail.db'; on first
    // run './data' may not exist yet.
    const dir = dirname(resolve(path));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db: Db = new Database(path, {
    // `readonly: false` implicit. No `fileMustExist` — we want auto-create on first run.
  });

  applyPragmas(db, path);
  runMigrations(db);
  verifyPragmas(db, path);

  return db;
}

/**
 * Applies every PRAGMA from the PRAGMAS list. Uses db.pragma() which returns
 * the value after the SET, so we can't strictly verify here (SQLite silently
 * accepts unknown pragmas as no-ops); verifyPragmas() below does the readback.
 */
function applyPragmas(db: Db, path: string): void {
  for (const [name, value] of PRAGMAS) {
    // journal_mode on :memory: cannot be WAL — skip it silently; SQLite forces
    // MEMORY journal for in-memory DBs anyway.
    if (name === 'journal_mode' && path === ':memory:') continue;
    db.pragma(`${name} = ${value}`);
  }
}

/**
 * Reads back the PRAGMAs we care about and throws if any disagree.
 * This is belt-and-suspenders: SQLite silently ignores unknown pragmas, and
 * some pragmas have version-dependent defaults. We want to fail loudly at
 * startup, not silently during a 3am crisis.
 */
function verifyPragmas(db: Db, path: string): void {
  const expectations: Array<[string, string | number]> = [
    ['synchronous', 1],          // NORMAL = 1 (D-13)
    ['busy_timeout', 5000],      // D-14
    ['foreign_keys', 1],         // ON = 1 (D-15)
  ];
  if (path !== ':memory:') {
    expectations.push(['journal_mode', 'wal']);  // D-12 (string result, lowercased by SQLite)
  }

  for (const [name, expected] of expectations) {
    const actual = db.pragma(name, { simple: true });
    if (actual !== expected) {
      throw new Error(
        `PRAGMA ${name} readback mismatch: expected ${String(expected)}, got ${String(actual)}`,
      );
    }
  }
}

/**
 * Applies any pending migration files.
 *
 * Migration discovery rule (D-30, D-31):
 *   - Initial schema:      src/db/schema.sql        -> version 1
 *   - Future migrations:   src/db/schema-vN.sql     -> version N (N >= 2)
 *
 * Algorithm:
 *   1. Create `schema_version` (no-op if already present).
 *   2. Read current max(version). 0 means fresh DB.
 *   3. Find all files matching `schema.sql` (v1) and `schema-v\d+.sql` (v >= 2),
 *      sort by version ascending, take those with version > current.
 *   4. Inside ONE transaction: for each pending file, exec its contents, then
 *      INSERT INTO schema_version(version, applied_at).
 *
 * Rollback: if any file fails, the transaction rolls back and no version is
 * recorded. The next openDb() will retry from the same point.
 */
function runMigrations(db: Db): void {
  // Bootstrap the version table itself. Needs to happen outside the migration
  // transaction because we query it to decide what to apply.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const currentRow = db
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_version')
    .get();
  const current = currentRow?.version ?? 0;

  const pending = discoverPendingMigrations(current);
  if (pending.length === 0) return;

  const tx = db.transaction((files: ReadonlyArray<{ version: number; path: string }>) => {
    const insertVersion = db.prepare<[number, number]>(
      'INSERT INTO schema_version(version, applied_at) VALUES (?, ?)',
    );
    for (const file of files) {
      const sql = readFileSync(file.path, 'utf8');
      db.exec(sql);
      insertVersion.run(file.version, nowMs());
    }
  });

  tx(pending);
}

/**
 * Finds migration files under SCHEMA_DIR whose version is strictly greater
 * than `current`. Returns in ascending version order.
 *
 * Naming:
 *   - `schema.sql`       -> version 1 (the initial schema)
 *   - `schema-v2.sql`    -> version 2
 *   - `schema-v3.sql`    -> version 3
 *   - `schema-v10.sql`   -> version 10  (numeric sort, NOT lexical)
 */
function discoverPendingMigrations(
  current: number,
): ReadonlyArray<{ version: number; path: string }> {
  const entries = readdirSync(SCHEMA_DIR);
  const out: Array<{ version: number; path: string }> = [];

  for (const name of entries) {
    if (name === 'schema.sql') {
      out.push({ version: 1, path: join(SCHEMA_DIR, name) });
      continue;
    }
    const m = /^schema-v(\d+)\.sql$/.exec(name);
    if (m && m[1]) {
      out.push({ version: Number.parseInt(m[1], 10), path: join(SCHEMA_DIR, name) });
    }
  }

  out.sort((a, b) => a.version - b.version);
  return out.filter((f) => f.version > current);
}
```

Notes on the implementation:
- `import Database, { type Database as BetterSqliteDb }` — default + named type import. `verbatimModuleSyntax` forces the `type` keyword on `BetterSqliteDb`.
- `db.prepare<[], { version: number | null }>(...)` — `better-sqlite3` generic parameters: `[ParamsTuple, RowType]`. `MAX(v)` returns NULL on empty table, hence `number | null`.
- `db.transaction(fn)` — `better-sqlite3`'s transaction helper. Opens SAVEPOINT, auto-rolls-back on throw, commits on return. This is the D-23 "transactions as arrow functions" pattern, used here for the migration runner specifically.
- `SCHEMA_DIR` via `fileURLToPath(import.meta.url)` + `dirname` — ESM-safe __dirname replacement. Required because `import.meta.url` resolves relative to the module file, not process CWD.
- No `@types/better-sqlite3` unresolved import issues expected — we installed it in plan 01.

**Verify:**

```xml
<verify>
  <automated>npx tsx -e "import {openDb} from './src/db/client.ts';import {existsSync,rmSync,mkdirSync} from 'node:fs';const p='./data/.plan02-test.db';if(existsSync(p))rmSync(p);if(existsSync(p+'-wal'))rmSync(p+'-wal');if(existsSync(p+'-shm'))rmSync(p+'-shm');mkdirSync('./data',{recursive:true});const db=openDb(p);const jm=db.pragma('journal_mode',{simple:true});if(jm!=='wal'){console.error('journal_mode=',jm);process.exit(1)}const fk=db.pragma('foreign_keys',{simple:true});if(fk!==1){console.error('fk=',fk);process.exit(2)}const bt=db.pragma('busy_timeout',{simple:true});if(bt!==5000){console.error('bt=',bt);process.exit(3)}const sy=db.pragma('synchronous',{simple:true});if(sy!==1){console.error('sy=',sy);process.exit(4)}const tables=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name);const want=['abuse_counters','attachments','inboxes','messages','schema_version'];if(JSON.stringify(tables)!==JSON.stringify(want)){console.error('tables=',tables);process.exit(5)}const ver=db.prepare('SELECT MAX(version) v FROM schema_version').get().v;if(ver!==1){console.error('ver=',ver);process.exit(6)}db.close();const db2=openDb(p);const ver2=db2.prepare('SELECT MAX(version) v FROM schema_version').get().v;if(ver2!==1){console.error('idempotent failed, ver2=',ver2);process.exit(7)}db2.close();rmSync(p);if(existsSync(p+'-wal'))rmSync(p+'-wal');if(existsSync(p+'-shm'))rmSync(p+'-shm');console.log('openDb ok')"</automated>
</verify>
```

**Done:**
- `src/db/client.ts` exports `openDb(path: string): Db` and `type Db`.
- First call on a fresh path: creates file, creates 5 tables, applies PRAGMAs, records schema_version=1.
- Second call on the same path: applies PRAGMAs again (per-connection), sees version=1, runs zero migrations.
- PRAGMA readback confirms `journal_mode=wal`, `synchronous=1`, `busy_timeout=5000`, `foreign_keys=1` on a file DB.
- `:memory:` path works (skips `journal_mode=WAL` assertion).
- `npm run typecheck` passes.
- `npm run check` passes.

**Commit message:** `feat(db): add openDb factory with PRAGMAs and migration runner`

---

## Verification

Run from repo root:

```bash
npm run typecheck
npm run check
# Functional check: create, verify PRAGMAs, re-open idempotently, clean up.
npx tsx -e "import {openDb} from './src/db/client.ts'; const db=openDb('./data/.verify.db'); console.log('tables=', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name).sort()); console.log('journal_mode=', db.pragma('journal_mode',{simple:true})); console.log('foreign_keys=', db.pragma('foreign_keys',{simple:true})); db.close();"
rm -f data/.verify.db data/.verify.db-wal data/.verify.db-shm
```

Expected final output includes `tables= [ 'abuse_counters', 'attachments', 'inboxes', 'messages', 'schema_version' ]` and `journal_mode= wal` and `foreign_keys= 1`.

Plan 05 will add proper Vitest tests for all this.

## Success criteria

- STORE-01 satisfied: all four domain tables exist with `domain` as a first-class column on `inboxes`.
- STORE-02 satisfied: all four mandated PRAGMAs (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`) are applied AND verified by readback on every `openDb()` call.
- Migration runner correctly applies `schema.sql` as v1; future `schema-vN.sql` additive-only files will run in order, in one transaction (D-31/D-32).
- Opening the same DB twice is idempotent — version number stays 1, no duplicate rows, no errors.
- FK CASCADE is real (verified in plan 05 tests; the declaration itself is here).

## Output

Create `.planning/phases/02-storage-layer/02-02-SUMMARY.md` listing the exact table DDL shipped, the PRAGMA values, the ID scheme chosen (`nanoid(22)` = 132 bits), and any deviations from CONTEXT.md (there should be none).
