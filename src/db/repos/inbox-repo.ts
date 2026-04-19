import { newId } from '../../util/id.js';
import { nowMs } from '../../util/now.js';
import type { Db } from '../client.js';
import type { InboxRow } from '../types.js';

/**
 * Input type for `createInbox`. Times are computed by the caller (Phase 3
 * core logic decides retention policy); we store what we're given. Caller
 * must provide `view_token_hash` pre-hashed — we never see the plaintext.
 */
export interface NewInbox {
  local_part: string;
  domain: string;
  view_token_hash: string;
  expires_at: number; // sliding TTL (idle) end
  hard_expires_at: number; // absolute ceiling (RETN-01, 1h from creation)
}

export interface InboxRepo {
  /** Inserts a new inbox row. `id`, `created_at`, `last_activity_at` assigned here. */
  createInbox(input: NewInbox): InboxRow;

  /** Returns the row or undefined. Never throws on missing. */
  findInboxById(id: string): InboxRow | undefined;

  /** Returns the row or undefined. Used by SMTP ingestion (RCPT TO check). */
  findInboxByLocalPart(localPart: string, domain: string): InboxRow | undefined;

  /** Bumps `last_activity_at` and extends `expires_at` to `newExpiresAt`, capped
   *  at `hard_expires_at`. Returns the updated row, or undefined if the inbox
   *  no longer exists (or is past its hard cap). */
  updateLastActivity(id: string, newExpiresAt: number): InboxRow | undefined;

  /** Deletes an inbox. FK CASCADE removes all messages + attachment rows.
   *  Returns true if a row was deleted, false otherwise. Does NOT touch disk. */
  deleteInbox(id: string): boolean;

  /** Returns inbox rows whose `expires_at <= cutoff` OR `hard_expires_at <= cutoff`,
   *  up to `limit`, oldest first. Used by the retention sweeper (Phase 6).
   *
   *  Hard-cap semantics matter here: an inbox with recent activity still has
   *  a sliding `expires_at` bumped forward, but its `hard_expires_at` never
   *  moves. The sweeper MUST expire such inboxes once the hard ceiling
   *  passes, even if the idle clock was just reset. */
  listExpired(cutoff: number, limit: number): readonly InboxRow[];
}

export function createInboxRepo(db: Db): InboxRepo {
  // Prepared statement cache. Created once, reused forever (D-21).
  const insertStmt = db.prepare<[string, string, string, string, number, number, number, number]>(`
    INSERT INTO inboxes (id, local_part, domain, view_token_hash,
      created_at, last_activity_at, expires_at, hard_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const findByIdStmt = db.prepare<[string], InboxRow>(`
    SELECT id, local_part, domain, view_token_hash,
           created_at, last_activity_at, expires_at, hard_expires_at
    FROM inboxes WHERE id = ?
  `);

  const findByLocalPartStmt = db.prepare<[string, string], InboxRow>(`
    SELECT id, local_part, domain, view_token_hash,
           created_at, last_activity_at, expires_at, hard_expires_at
    FROM inboxes WHERE local_part = ? AND domain = ?
  `);

  // Two-statement update: the UPDATE with a MIN() guard (can't exceed hard cap),
  // then a SELECT to return the row.
  // Param order matches the SQL: (last_activity_at, new-expires, id, now-for-hard-cap guard).
  const updateActivityStmt = db.prepare<[number, number, string, number]>(`
    UPDATE inboxes
    SET last_activity_at = ?,
        expires_at = MIN(?, hard_expires_at)
    WHERE id = ? AND hard_expires_at > ?
  `);

  const deleteStmt = db.prepare<[string]>('DELETE FROM inboxes WHERE id = ?');

  // Honors BOTH the sliding idle TTL (`expires_at`) AND the hard ceiling
  // (`hard_expires_at`). `<=` rather than `<` so an inbox whose TTL elapses
  // exactly on the tick boundary is picked up on this tick rather than next.
  const listExpiredStmt = db.prepare<[number, number, number], InboxRow>(`
    SELECT id, local_part, domain, view_token_hash,
           created_at, last_activity_at, expires_at, hard_expires_at
    FROM inboxes
    WHERE expires_at <= ? OR hard_expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `);

  return {
    createInbox(input) {
      const id = newId();
      const now = nowMs();
      insertStmt.run(
        id,
        input.local_part,
        input.domain,
        input.view_token_hash,
        now, // created_at
        now, // last_activity_at
        input.expires_at,
        input.hard_expires_at,
      );
      // We just inserted with known values — return a typed row without another roundtrip.
      return {
        id,
        local_part: input.local_part,
        domain: input.domain,
        view_token_hash: input.view_token_hash,
        created_at: now,
        last_activity_at: now,
        expires_at: input.expires_at,
        hard_expires_at: input.hard_expires_at,
      };
    },

    findInboxById(id) {
      return findByIdStmt.get(id);
    },

    findInboxByLocalPart(localPart, domain) {
      return findByLocalPartStmt.get(localPart, domain);
    },

    updateLastActivity(id, newExpiresAt) {
      const now = nowMs();
      const result = updateActivityStmt.run(now, newExpiresAt, id, now);
      if (result.changes === 0) return undefined;
      return findByIdStmt.get(id);
    },

    deleteInbox(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    listExpired(cutoff, limit) {
      // Cutoff is passed twice — once for each OR branch in the WHERE clause.
      return listExpiredStmt.all(cutoff, cutoff, limit);
    },
  };
}
