/**
 * Protocol-agnostic inbox operations — the surface the SMTP adapter (Phase 4)
 * and HTTP adapter (Phase 5) call into.
 *
 * Scope (CORE-01, CORE-02, CORE-05):
 *   - `createInbox()` mints a 22-char nanoid local-part (132 bits ≥ 64) and an
 *     independent 22-char view-token, stores only the SHA-256 hash of the
 *     token, and returns the plaintext exactly once (D-06, D-07).
 *   - `verifyViewToken(row, token)` constant-time-compares a candidate against
 *     the stored hash (D-15). Exported both standalone and via the factory
 *     object so plan 03-03 can reuse the same logic.
 *   - `expireInbox({ inboxId })` collects attachment sha256s BEFORE the DB
 *     delete (FK CASCADE drops the rows), then unlinks only orphaned blobs
 *     (D-17). Runs the delete inside `withTransaction` so a mid-delete throw
 *     leaves state unchanged.
 *
 * No direct `better-sqlite3`, no `node:fs`, no `db.prepare`/`db.exec` — only
 * the Phase 2 repos and attachment store (D-03).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { AttachmentStore } from '../attachments/index.js';
import type { Db } from '../db/client.js';
import type { Repos } from '../db/repos/index.js';
import { withTransaction } from '../db/transaction.js';
import type { InboxRow } from '../db/types.js';
import { newId } from '../util/id.js';
import { nowMs } from '../util/now.js';

export interface InboxesConfig {
  /** Domain the address is rooted at (e.g. `example.test`). Never hardcoded (D-05). */
  domain: string;
  /** Sliding idle TTL in ms. Added to creation time to produce `expires_at`. */
  idleTtlMs: number;
  /** Absolute ceiling in ms. Added to creation time to produce `hard_expires_at`. */
  hardTtlMs: number;
}

export interface InboxesDeps {
  /** Needed for `withTransaction` in `expireInbox`. Not used by `createInbox`. */
  db: Db;
  repos: Repos;
  attachmentStore: AttachmentStore;
  config: InboxesConfig;
  /** Override clock for determinism in tests. Defaults to `nowMs`. */
  now?: () => number;
  /** Override id generator for determinism in tests. Defaults to `newId`. */
  id?: () => string;
}

export interface CreateInboxResult {
  ok: true;
  inboxId: string;
  address: string;
  viewToken: string;
  expiresAt: number;
  hardExpiresAt: number;
}

export type ExpireInboxResult =
  | { ok: true; deletedMessages: number; unlinkedAttachments: number }
  | { ok: false; reason: 'not_found' };

export interface InboxesApi {
  createInbox(): CreateInboxResult;
  expireInbox(input: { inboxId: string }): Promise<ExpireInboxResult>;
  verifyViewToken(row: InboxRow, viewToken: string): boolean;
}

/**
 * Constant-time SHA-256 hex-digest compare for view-tokens.
 *
 * Exported standalone so plan 03-03's `listMessages` can reuse exactly the
 * same logic (single source of truth for D-15's wrong-token → forbidden
 * branch). The factory object below also exposes this as `api.verifyViewToken`.
 *
 * Never throws on mismatch — returns `false`. Both buffers are sha256 (32
 * bytes) so `timingSafeEqual`'s equal-length precondition is satisfied by
 * construction, but we check defensively.
 */
export function verifyViewToken(row: InboxRow, viewToken: string): boolean {
  const candidate = createHash('sha256').update(viewToken).digest(); // 32 bytes
  const stored = Buffer.from(row.view_token_hash, 'hex'); // 32 bytes on valid input
  if (candidate.length !== stored.length) return false; // defensive
  return timingSafeEqual(candidate, stored);
}

/**
 * Factory for the inbox operations bound to a specific set of deps.
 *
 * Every side effect flows through `deps.repos` or `deps.attachmentStore`; the
 * only direct Node API use is `node:crypto` for hashing + timing-safe compare.
 * Deps are never mutated.
 */
export function createInboxes(deps: InboxesDeps): InboxesApi {
  const now = deps.now ?? nowMs;
  const id = deps.id ?? newId;

  const createInbox = (): CreateInboxResult => {
    const localPart = id();
    const viewToken = id();
    if (viewToken === localPart) {
      // D-20: programmer/universe error (probability 2^-132 with default nanoid).
      // Throw instead of returning ok:false — this is not a business error.
      throw new Error('id() produced the same value twice — RNG broken');
    }

    const viewTokenHash = createHash('sha256').update(viewToken).digest('hex');
    const createdAt = now();
    const expiresAt = createdAt + deps.config.idleTtlMs;
    const hardExpiresAt = createdAt + deps.config.hardTtlMs;

    const row = deps.repos.inboxes.createInbox({
      local_part: localPart,
      domain: deps.config.domain,
      view_token_hash: viewTokenHash,
      expires_at: expiresAt,
      hard_expires_at: hardExpiresAt,
    });

    return {
      ok: true,
      inboxId: row.id,
      address: `${localPart}@${deps.config.domain}`,
      viewToken,
      expiresAt,
      hardExpiresAt,
    };
  };

  const expireInbox = async (input: { inboxId: string }): Promise<ExpireInboxResult> => {
    // --- Phase 1: read-only prep (outside the transaction).
    // If the inbox doesn't exist, this is a no-op — return early.
    const inbox = deps.repos.inboxes.findInboxById(input.inboxId);
    if (!inbox) return { ok: false, reason: 'not_found' };

    // Collect every sha256 currently referenced by this inbox's messages.
    // We walk messages → attachments because message-repo does not (and should
    // not) expose a join-query just for the sweeper. Inboxes are bounded
    // (minutes-hours, tens to low hundreds of messages) so this walk is cheap.
    // `limit: 100_000` is effectively "all" — paging is deferred per D-16.
    const messageRows = deps.repos.messages.listMessagesByInbox(input.inboxId, {
      limit: 100_000,
      offset: 0,
    });
    const candidateShas = new Set<string>();
    for (const m of messageRows) {
      for (const a of deps.repos.attachments.listAttachmentsByMessage(m.id)) {
        candidateShas.add(a.sha256);
      }
    }
    const deletedMessages = messageRows.length;

    // --- Phase 2: transactional delete. FK CASCADE drops messages +
    // attachments rows + abuse rows keyed on this inbox atomically. If the
    // delete throws, the transaction rolls back and no file is ever unlinked
    // (Phase 3 below only runs after a successful commit).
    withTransaction(deps.db, () => {
      deps.repos.inboxes.deleteInbox(input.inboxId);
    });

    // --- Phase 3: post-commit orphan unlink.
    // `listAllSha256s()` is a single DISTINCT query over the entire
    // attachments table — cheap and gives us the post-cascade reference set.
    // A sha is safe to unlink iff no surviving row still references it.
    const survivingShas = deps.repos.attachments.listAllSha256s();
    let unlinkedAttachments = 0;
    for (const sha of candidateShas) {
      if (survivingShas.has(sha)) continue; // another inbox still references it
      const unlinked = await deps.attachmentStore.unlinkBySha256(sha);
      if (unlinked) unlinkedAttachments += 1;
    }

    return { ok: true, deletedMessages, unlinkedAttachments };
  };

  return {
    createInbox,
    expireInbox,
    verifyViewToken,
  };
}
