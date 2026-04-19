/**
 * Expiry sweep (Plan 06-02, RETN-01, RETN-02).
 *
 * Walks every inbox whose `expires_at <= now` OR `hard_expires_at <= now` and
 * calls `core.expireInbox({ inboxId })` once per hit. Core handles cascade +
 * orphan-safe blob unlinking (see `src/core/inboxes.ts`); the sweeper just
 * loops + aggregates counts.
 *
 * Log output (D-07): exactly ONE whitelisted line per tick. Never individual
 * inbox IDs, addresses, or message IDs.
 */

import type { CoreApi } from '../core/index.js';
import type { Repos } from '../db/repos/index.js';
import type { SweeperLogger } from './sweeper.js';

export interface ExpireSweepDeps {
  core: CoreApi;
  repos: Repos;
  logger: SweeperLogger;
  now: () => number;
  tickId: string;
  batchSize?: number;
}

export interface ExpireResult {
  /** Correlation tag for this tick (log + test assertions). */
  tickId: string;
  /** Inboxes processed this tick. */
  expiredCount: number;
  /** Messages removed (summed across all inboxes). */
  deletedMessages: number;
  /** Attachment blobs removed from disk (summed, orphan-safe). */
  unlinkedBlobs: number;
  /** Wall time ms for this tick. */
  durationMs: number;
}

const DEFAULT_BATCH = 500;
const MAX_PER_TICK = 10_000;

export async function runExpireSweep(deps: ExpireSweepDeps): Promise<ExpireResult> {
  const startedAt = deps.now();
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;

  let expiredCount = 0;
  let deletedMessages = 0;
  let unlinkedBlobs = 0;

  // Loop pages of `listExpired(cutoff, limit)` until we either run out of
  // rows or hit the safety cap. The cutoff is captured ONCE at the start of
  // the tick so that inboxes whose TTL expires mid-sweep are picked up on
  // the *next* tick — deterministic behavior beats best-effort here.
  const cutoff = startedAt;

  // Safety: no more than MAX_PER_TICK inboxes per call to bound event-loop
  // occupancy.
  while (expiredCount < MAX_PER_TICK) {
    // Each iteration re-queries at the same cutoff. Because we DELETE rows
    // as we go, the page window naturally walks forward — no pagination
    // needed beyond the cutoff bound.
    const rows = deps.repos.inboxes.listExpired(cutoff, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (expiredCount >= MAX_PER_TICK) break;
      const result = await deps.core.expireInbox({ inboxId: row.id });
      expiredCount += 1;
      if (result.ok) {
        deletedMessages += result.deletedMessages;
        unlinkedBlobs += result.unlinkedAttachments;
      }
      // If `not_found`, another process already deleted it — ignore and move on.
    }

    // If we got fewer rows than we asked for, the table is drained. No need
    // to re-query.
    if (rows.length < batchSize) break;
  }

  const durationMs = deps.now() - startedAt;
  deps.logger.info(
    {
      event: 'sweeper.expire.done',
      tick_id: deps.tickId,
      expired_count: expiredCount,
      deleted_messages: deletedMessages,
      unlinked_blobs: unlinkedBlobs,
      duration_ms: durationMs,
    },
    'sweeper.expire.done',
  );

  return {
    tickId: deps.tickId,
    expiredCount,
    deletedMessages,
    unlinkedBlobs,
    durationMs,
  };
}
