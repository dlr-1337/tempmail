import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type Database as BetterSqliteDb } from 'better-sqlite3';

import { nowMs } from '../util/now.js';

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
  ['journal_mode', 'WAL'], // D-12
  ['synchronous', 'NORMAL'], // D-13
  ['busy_timeout', 5000], // D-14
  ['foreign_keys', 'ON'], // D-15
  ['mmap_size', 134_217_728], // D-16: 128 MB
  ['temp_store', 'MEMORY'], // D-17
  ['wal_autocheckpoint', 1000], // D-18
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
    ['synchronous', 1], // NORMAL = 1 (D-13)
    ['busy_timeout', 5000], // D-14
    ['foreign_keys', 1], // ON = 1 (D-15)
  ];
  if (path !== ':memory:') {
    expectations.push(['journal_mode', 'wal']); // D-12 (string result, lowercased by SQLite)
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
    if (m?.[1]) {
      out.push({ version: Number.parseInt(m[1], 10), path: join(SCHEMA_DIR, name) });
    }
  }

  out.sort((a, b) => a.version - b.version);
  return out.filter((f) => f.version > current);
}
