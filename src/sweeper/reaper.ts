/**
 * Orphan attachment reaper (Plan 06-03, RETN-03).
 *
 * Walks `<attachmentStore.rootDir>/<aa>/<bb>/*` and deletes any blob whose
 * sha256 is NOT referenced by a row in the `attachments` table. The
 * reference set is fetched ONCE per run via `attachmentRepo.listAllSha256s()`;
 * any row inserted between the set snapshot and the unlink will simply be
 * picked up on the next pass (its blob can't be referenced if the file is
 * also new, and the content-addressed writer re-materializes on next ingest).
 *
 * Bound (D-10): at most 10k files per run. A pathologically full data dir
 * will just converge over multiple hourly ticks instead of starving the
 * event loop.
 *
 * Skips:
 *   - The `.incoming` directory (in-flight temp files; unlinking them mid-write
 *     would truncate active uploads).
 *   - Any filename that is not a 64-char lowercase hex string (defense against
 *     stray non-content-addressed files, e.g. editor swap files).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AttachmentStore } from '../attachments/index.js';
import { isValidSha256Hex } from '../attachments/paths.js';
import type { Repos } from '../db/repos/index.js';
import type { SweeperLogger } from './sweeper.js';

export interface OrphanReaperDeps {
  attachmentStore: AttachmentStore;
  repos: Repos;
  logger: SweeperLogger;
  now: () => number;
  tickId: string;
  maxPerRun?: number;
}

export interface ReaperResult {
  tickId: string;
  /** Files examined (valid-hex basenames only). */
  scanned: number;
  /** Files found with no DB reference. */
  orphaned: number;
  /** Files actually unlinked (unlink returns false iff already gone). */
  unlinked: number;
  durationMs: number;
}

const DEFAULT_MAX_PER_RUN = 10_000;
const INCOMING = '.incoming';

export async function runOrphanReaper(deps: OrphanReaperDeps): Promise<ReaperResult> {
  const startedAt = deps.now();
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;

  const referenced = deps.repos.attachments.listAllSha256s();
  let scanned = 0;
  let orphaned = 0;
  let unlinked = 0;

  // The root holds two-level shard dirs (`aa/bb/<sha>`). We enumerate top-
  // level entries and descend only into directories whose name looks like a
  // two-hex-char shard. Anything else is skipped (including `.incoming`).
  let topEntries: string[];
  try {
    topEntries = await readdir(deps.attachmentStore.rootDir);
  } catch (err) {
    // If the dir doesn't exist yet (fresh install, no ingests), nothing to do.
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return emitResult(0, 0, 0);
    }
    throw err;
  }

  outer: for (const top of topEntries) {
    if (top === INCOMING) continue;
    if (!isHexDir(top)) continue;
    const topPath = join(deps.attachmentStore.rootDir, top);

    let midEntries: string[];
    try {
      midEntries = await readdir(topPath);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }

    for (const mid of midEntries) {
      if (!isHexDir(mid)) continue;
      const midPath = join(topPath, mid);

      let leafEntries: string[];
      try {
        leafEntries = await readdir(midPath);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') continue;
        throw err;
      }

      for (const leaf of leafEntries) {
        if (!isValidSha256Hex(leaf)) continue;
        if (scanned >= maxPerRun) break outer;
        scanned += 1;

        if (referenced.has(leaf)) continue;
        orphaned += 1;
        // Defensive: unlinkBySha256 validates again and is idempotent.
        const ok = await deps.attachmentStore.unlinkBySha256(leaf);
        if (ok) unlinked += 1;
      }
    }
  }

  return emitResult(scanned, orphaned, unlinked);

  function emitResult(s: number, o: number, u: number): ReaperResult {
    const durationMs = deps.now() - startedAt;
    deps.logger.info(
      {
        event: 'sweeper.reaper.done',
        tick_id: deps.tickId,
        scanned: s,
        orphaned: o,
        unlinked: u,
        duration_ms: durationMs,
      },
      'sweeper.reaper.done',
    );
    return { tickId: deps.tickId, scanned: s, orphaned: o, unlinked: u, durationMs };
  }
}

function isHexDir(name: string): boolean {
  if (name.length !== 2) return false;
  for (let i = 0; i < 2; i += 1) {
    const c = name.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLowerHex = c >= 97 && c <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
