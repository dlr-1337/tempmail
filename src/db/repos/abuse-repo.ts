import type { Db } from '../client.js';

export interface AbuseRepo {
  /**
   * Atomically increments the counter for (ip_prefix, bucket, window_start).
   * Inserts the row if it doesn't exist (UPSERT). Returns the counter's new value.
   *
   * Time bucketing: the caller picks `window_start` by flooring nowMs() to the
   * window size (e.g., 60s buckets => `Math.floor(now/60000)*60000`). The repo
   * is bucket-size-agnostic.
   */
  incrementCounter(ipPrefix: string, bucket: string, windowStart: number): number;

  /** Returns the count for a specific (prefix, bucket, window). 0 if absent. */
  getCounter(ipPrefix: string, bucket: string, windowStart: number): number;

  /** Deletes counter rows whose `window_start < cutoff`. Returns rows deleted.
   *  Phase 6's sweeper calls this with a cutoff of ~1h ago. */
  pruneOldCounters(cutoff: number): number;
}

export function createAbuseRepo(db: Db): AbuseRepo {
  // UPSERT. On conflict on the composite PK, add 1 to the existing count.
  // RETURNING gives us the final count without a second SELECT round-trip.
  // SQLite 3.35+ supports RETURNING on UPSERT; better-sqlite3@12 ships >= 3.45.
  const upsertStmt = db.prepare<[string, string, number], { count: number }>(`
    INSERT INTO abuse_counters (ip_prefix, bucket, count, window_start)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (ip_prefix, bucket, window_start) DO UPDATE
      SET count = count + 1
    RETURNING count
  `);

  const getStmt = db.prepare<[string, string, number], { count: number }>(`
    SELECT count FROM abuse_counters
    WHERE ip_prefix = ? AND bucket = ? AND window_start = ?
  `);

  const pruneStmt = db.prepare<[number]>('DELETE FROM abuse_counters WHERE window_start < ?');

  return {
    incrementCounter(ipPrefix, bucket, windowStart) {
      const row = upsertStmt.get(ipPrefix, bucket, windowStart);
      return row?.count ?? 0;
    },
    getCounter(ipPrefix, bucket, windowStart) {
      const row = getStmt.get(ipPrefix, bucket, windowStart);
      return row?.count ?? 0;
    },
    pruneOldCounters(cutoff) {
      return pruneStmt.run(cutoff).changes;
    },
  };
}
