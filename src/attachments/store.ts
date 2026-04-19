/**
 * Hash-sharded, content-addressed attachment store.
 *
 * This is the single filesystem surface the rest of the codebase uses for
 * attachment bytes. SMTP ingestion (Phase 4) streams received MIME parts into
 * `writeAttachment()`; the HTTP attachment-download route (Phase 5) pulls them
 * back out via `readAttachment()`; the orphan reaper (Phase 6) prunes via
 * `unlinkBySha256()`.
 *
 * Design pillars (see plan 02-04 `<locked_decisions>`):
 *   - D-26  Filenames are the sha256 of the content — never user-controlled.
 *   - D-27  Atomic write: stream to temp file, then rename() to final path.
 *   - D-28  Reads never accept a user-controlled path component.
 *   - D-29  Content-addressed dedup: two writes of the same bytes share a blob.
 *
 * No database knowledge here — the caller persists `sha256` + `storagePath`
 * in the `attachments` row after this module returns.
 */

import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { access, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { newId } from '../util/id.js';
import { isValidSha256Hex, shardPath } from './paths.js';

/**
 * Result returned by `writeAttachment()`.
 *
 * - `sha256`: hex digest of the streamed bytes. This is the content address
 *   and the value that goes into the `attachments.sha256` column.
 * - `storagePath`: POSIX-style RELATIVE path from the store root (e.g.
 *   `de/01/de01...`). This is the string the DB's `attachments.storage_path`
 *   column should hold — keeping it relative means the store root can be
 *   reconfigured without rewriting rows.
 * - `sizeBytes`: byte count observed during streaming. Source of truth for
 *   DB `attachments.size_bytes`; ignore any caller-supplied Content-Length.
 */
export interface WriteResult {
  sha256: string;
  storagePath: string;
  sizeBytes: number;
}

/**
 * Result of a cheap existence + size probe via `statBySha256()`.
 *
 * Modeled as a discriminated union so callers must handle the missing case.
 */
export type StatResult = { exists: true; sizeBytes: number } | { exists: false };

export interface AttachmentStore {
  /**
   * Streams the given Readable into the content-addressed store.
   *
   * Algorithm (D-27, atomic write):
   *   1. Open a temp file under `<root>/.incoming/<newId()>`.
   *   2. Hash + count bytes via a `data` listener on the source, piping the
   *      same stream to disk with `pipeline()`.
   *   3. On 'finish': compute digest, compute final path = `<root>/<shard>/<digest>`.
   *   4. Ensure the shard directory exists (mkdir -p).
   *   5. rename(temp -> final). Atomic on same filesystem; rename-over-top on
   *      Windows NTFS has been supported since Node 16.19 (we're on 22 LTS).
   *
   * Dedup: if the final path already exists, rename overwrites. No refcount
   * table — the DB's `attachments` rows carry per-message references; the
   * orphan reaper (Phase 6) checks "does any row still reference this sha?"
   * before unlinking.
   *
   * Errors: if the stream fails mid-pipe, the temp file is best-effort
   * unlinked and the rejection is propagated. No partial file ever lands at
   * the final path.
   */
  writeAttachment(source: Readable): Promise<WriteResult>;

  /**
   * Opens a Readable over the file identified by `sha256`. Returns `null` if
   * the file does not exist (do NOT throw on missing — callers distinguish
   * 404 from 500 based on null vs rejection).
   *
   * Rejects the promise if `sha256` is structurally invalid (defense against
   * upstream bugs that forward user input here).
   */
  readAttachment(sha256: string): Promise<Readable | null>;

  /**
   * Deletes the file at `sha256`. Returns `true` if a file was removed,
   * `false` if it was already gone (ENOENT is NOT an error — idempotent
   * delete is an explicit requirement). Rejects only on unexpected errors
   * (EACCES, EIO, etc.).
   */
  unlinkBySha256(sha256: string): Promise<boolean>;

  /**
   * Cheap existence + size check without opening a stream. Used by the
   * orphan reaper and by HEAD-like probes.
   */
  statBySha256(sha256: string): Promise<StatResult>;

  /** Root directory the store was opened against. Exposed for logging + tests. */
  readonly rootDir: string;
}

/**
 * Creates an attachment store rooted at `rootDir` (e.g. `./data/attachments`).
 *
 * Side effects at factory time: none — directories are created lazily on the
 * first write. This keeps module import cheap and lets tests open stores
 * against temp directories without background setup.
 */
export function createAttachmentStore(rootDir: string): AttachmentStore {
  // Temp files live INSIDE the root so `rename()` stays on the same
  // filesystem. Cross-device rename fails with EXDEV on Linux; using OS
  // tmpdir would regress this on containers that bind-mount `/data`.
  const incomingDir = join(rootDir, '.incoming');

  async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async function writeAttachment(source: Readable): Promise<WriteResult> {
    await ensureDir(incomingDir);

    const tempName = `tmp-${newId()}`;
    const tempPath = join(incomingDir, tempName);

    // Lazy-loaded so we don't pay the crypto init cost on modules that import
    // the store type but never call writeAttachment.
    const { createHash } = await import('node:crypto');
    const hasher = createHash('sha256');
    let sizeBytes = 0;

    // Tap the stream to feed the hasher + count bytes, and pipe to disk.
    // The 'data' listener runs on every chunk before the writable consumes
    // it — Node's stream contract guarantees the ordering. This is simpler
    // (and faster for ≤10 MB messages) than inserting a Transform stage.
    source.on('data', (chunk: Buffer) => {
      hasher.update(chunk);
      sizeBytes += chunk.length;
    });

    const writeStream = createWriteStream(tempPath);

    try {
      await pipeline(source, writeStream);
    } catch (err) {
      // Streaming failed. Clean up the temp file; propagate the original error.
      await unlink(tempPath).catch(() => {
        /* best-effort cleanup — the temp file may not exist yet */
      });
      throw err;
    }

    const sha256 = hasher.digest('hex');
    // Defense in depth: the hasher only emits lowercase hex, but assert before
    // using the string as a path component (D-28).
    if (!isValidSha256Hex(sha256)) {
      await unlink(tempPath).catch(() => {});
      throw new Error('writeAttachment: hasher returned invalid digest');
    }

    const relPath = shardPath(sha256);
    const finalPath = join(rootDir, relPath);
    await ensureDir(dirname(finalPath));

    // Atomic rename onto the content-addressed path. On dedup (same content
    // written twice) this overwrites an identical file — a no-op in content
    // terms, safe on POSIX and on Windows NTFS since Node 16.19.
    await rename(tempPath, finalPath);

    return { sha256, storagePath: relPath, sizeBytes };
  }

  async function readAttachment(sha256: string): Promise<Readable | null> {
    if (!isValidSha256Hex(sha256)) {
      // Hard fail: something upstream forwarded user input here.
      throw new Error('readAttachment: invalid sha256 digest');
    }
    const relPath = shardPath(sha256);
    const fullPath = join(rootDir, relPath);

    try {
      await access(fullPath, fsConstants.R_OK);
    } catch {
      return null;
    }

    return createReadStream(fullPath);
  }

  async function unlinkBySha256(sha256: string): Promise<boolean> {
    if (!isValidSha256Hex(sha256)) {
      throw new Error('unlinkBySha256: invalid sha256 digest');
    }
    const relPath = shardPath(sha256);
    const fullPath = join(rootDir, relPath);

    try {
      await unlink(fullPath);
      return true;
    } catch (err) {
      // ENOENT is fine (idempotent delete). Anything else propagates.
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function statBySha256(sha256: string): Promise<StatResult> {
    if (!isValidSha256Hex(sha256)) {
      throw new Error('statBySha256: invalid sha256 digest');
    }
    const relPath = shardPath(sha256);
    const fullPath = join(rootDir, relPath);
    try {
      const s = await stat(fullPath);
      return { exists: true, sizeBytes: s.size };
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return { exists: false };
      throw err;
    }
  }

  return {
    writeAttachment,
    readAttachment,
    unlinkBySha256,
    statBySha256,
    rootDir,
  };
}

/** Narrow a caught `unknown` to `NodeJS.ErrnoException` for `.code` access. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
