import type { Db } from './client.js';

/**
 * Runs `fn` inside a SAVEPOINT-backed transaction.
 *
 * Semantics (better-sqlite3):
 *   - Begins on call, commits on return, rolls back on throw.
 *   - `fn` is synchronous (better-sqlite3 is sync). Do NOT return a Promise from it.
 *   - Nested `withTransaction` calls reuse the outer SAVEPOINT — safe to compose.
 *
 * Why a helper instead of inline `db.transaction(fn)()`:
 *   - Single call-site pattern (D-23) for readability.
 *   - Forces the `<T>` generic, so the return type is preserved without casts.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  // better-sqlite3's .transaction() returns a function that, when called,
  // runs the body in a transaction. We invoke it immediately.
  const wrapped = db.transaction(fn);
  return wrapped();
}
