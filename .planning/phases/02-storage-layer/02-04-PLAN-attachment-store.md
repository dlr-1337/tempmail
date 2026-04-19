---
phase: 2
plan: 4
type: execute
wave: 3
status: ready
depends_on: [1, 2]
files_modified:
  - src/attachments/paths.ts
  - src/attachments/store.ts
  - src/attachments/index.ts
autonomous: true
requirements: [STORE-03]
must_haves:
  truths:
    - "Writing an attachment stream produces a file at `<root>/<aa>/<bb>/<sha256>` where aa/bb are the first two hex-pairs of the content sha256"
    - "The write is atomic: bytes land in a temp file first, then rename() to the final path — a crash mid-write never leaves a partial file at the final path"
    - "Reading by sha256 returns a Readable stream or null; the caller never supplies a user-controlled path component"
    - "Two writes of the same content produce the same path (content-addressed dedup)"
    - "The storage root is created on first write (mkdir recursive), not at module load"
    - "unlinkBySha256() returns true on success, false if the file was already gone (not an error)"
  artifacts:
    - path: "src/attachments/paths.ts"
      provides: "shardPath(sha256) — pure function mapping a sha256 to relative hash-sharded path"
      exports: ["shardPath", "isValidSha256Hex"]
    - path: "src/attachments/store.ts"
      provides: "createAttachmentStore(root) — writer/reader/unlinker factory"
      exports: ["createAttachmentStore", "AttachmentStore", "WriteResult"]
    - path: "src/attachments/index.ts"
      provides: "Re-exports for external callers"
      exports: ["createAttachmentStore", "AttachmentStore", "WriteResult", "shardPath"]
  key_links:
    - from: "src/attachments/store.ts"
      to: "node:fs/promises + node:crypto + node:stream"
      via: "pipeline() + createHash() + rename()"
      pattern: "pipeline|createHash|rename"
    - from: "src/attachments/store.ts"
      to: "src/attachments/paths.ts"
      via: "shardPath(digest) for final path"
      pattern: "shardPath"
---

<objective>
Build the hash-sharded attachment store: a content-addressed, streaming writer and reader that satisfies STORE-03 ("Attachments stored on disk in hash-sharded directories (`/data/attachments/<aa>/<bb>/<sha256>`), metadata in DB").

This plan does NOT touch the database (that's plan 03's attachment-repo). The two meet at the `sha256` value + `storage_path`: the store computes them at write time, the repo persists them.

Purpose: Satisfies STORE-03 and implements D-24..D-29. Provides the single filesystem surface that SMTP ingestion (Phase 4) and attachment download (Phase 5 `GET /api/attachments/:id`) call.
Output: `createAttachmentStore(root)` factory returning `{ writeAttachment, readAttachment, unlinkBySha256, rootDir }`.
</objective>

<execution_context>
Depends on Plan 02-01 (scaffolding). Independent of Plan 02-02 (schema) and Plan 02-03 (repos) — they can run in the same wave in parallel on the DAG, but since waves are sequenced this plan lands in Wave 3 alongside repos (both only need Wave 1). No filename overlap: this plan owns `src/attachments/`, plan 03 owns `src/db/repos/`.

All code: TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. No `any`.

Node APIs used: `node:fs/promises` (mkdir, rename, unlink, access), `node:fs` (createWriteStream, createReadStream), `node:crypto` (createHash), `node:stream/promises` (pipeline), `node:path` (join, dirname), `node:os` (tmpdir is NOT used — we use an in-tree `.incoming/` dir to guarantee same-FS rename).
</execution_context>

<context>
@.planning/phases/02-storage-layer/02-CONTEXT.md
@.planning/research/ARCHITECTURE.md
@.planning/research/PITFALLS.md
</context>

<locked_decisions>
- **D-24:** Root directory is `/data/attachments` (dev: `./data/attachments`)
- **D-25:** Hash sharding is two-level: `<first-2-hex>/<next-2-hex>/<sha256>`
- **D-26:** Filename on disk is the sha256 — never the original filename (content-addressed, dedup, immune to traversal)
- **D-27:** Write path: open temp file → stream bytes → rename to final hash path (atomic)
- **D-28:** Read path: `createReadStream()` from the hash path — never from a user-controlled path component
- **D-29:** Content-addressed storage → identical attachments share a blob; DB row still per-message

### Non-negotiables from PITFALLS.md
- Never construct a final path from user input. The sha256 is computed by us from the streamed bytes.
- Never commit the DB row before the file is flushed + renamed. The caller's order must be: `writeAttachment()` → `insertMessageWithAttachments()`. The DB row points at the file; if the file isn't there when the row commits, we've created an orphan-ref.
- Streaming is mandatory. A 10 MB message × 10 concurrent ingestions buffered = 100 MB heap on a 1 GB VPS (PITFALLS #7 inode/disk trap).
</locked_decisions>

## Goal

A `createAttachmentStore(root)` factory producing three operations that every other phase will use:

```typescript
const store = createAttachmentStore('./data/attachments');
const { sha256, storagePath, sizeBytes } = await store.writeAttachment(readableStream);
const maybeStream = await store.readAttachment(sha256);      // Readable or null
const unlinked = await store.unlinkBySha256(sha256);         // boolean
```

Satisfies STORE-03 end-to-end: bytes land in a sharded content-addressed path, metadata caller uses the returned sha256 and storagePath.

## Must-have checklist

- **STORE-03**: Attachments on disk in `<root>/<aa>/<bb>/<sha256>` shape; DB stores metadata (the repo plan already does this; this plan produces the files)

## Tasks

#### Task 1: Pure path logic (`src/attachments/paths.ts`)

**Files:**
- `src/attachments/paths.ts`

**Action:**

Create `src/attachments/paths.ts`. Pure functions only — no fs, no I/O. Easy to unit-test in plan 05:

```typescript
/**
 * Converts a sha256 hex digest into its relative two-level sharded path.
 *
 * Format (D-25): `<first-2-hex>/<next-2-hex>/<sha256>`
 *
 * Example:
 *   shardPath('de01ad02...rest64chars') === 'de/01/de01ad02...rest64chars'
 *
 * The path is POSIX-style with forward slashes regardless of the host OS.
 * Callers that need an OS-specific absolute path must prepend the root and
 * normalize via node:path#join (which writeAttachment / readAttachment do).
 *
 * @throws if `hex` is not a 64-char lowercase hex string (defense against
 *         accidental user-supplied input reaching this function).
 */
export function shardPath(hex: string): string {
  if (!isValidSha256Hex(hex)) {
    throw new Error(`shardPath: expected 64-char lowercase hex, got: ${redact(hex)}`);
  }
  return `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

/**
 * True iff `s` is exactly 64 lowercase hex characters — i.e., a valid
 * sha256 hex digest. Used as a guard before using any value as a path
 * component (D-28: never a user-controlled path).
 */
export function isValidSha256Hex(s: string): boolean {
  if (s.length !== 64) return false;
  // Manual loop is faster than regex for hot paths; attachment reads will call this.
  for (let i = 0; i < 64; i += 1) {
    const c = s.charCodeAt(i);
    // '0'-'9' = 48-57, 'a'-'f' = 97-102
    const isDigit = c >= 48 && c <= 57;
    const isLowerHex = c >= 97 && c <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

/**
 * Truncates + sanitizes a string for inclusion in an error message.
 * Never leak full user input into logs (PII-minimization, PITFALLS #4).
 */
function redact(s: string): string {
  const shown = s.slice(0, 8);
  return `${shown}...(${s.length} chars)`;
}
```

**Verify:**

```xml
<verify>
  <automated>npx tsx -e "import {shardPath,isValidSha256Hex} from './src/attachments/paths.ts';const hex='de01ad02'+'0'.repeat(56);if(shardPath(hex)!=='de/01/'+hex)process.exit(1);if(!isValidSha256Hex(hex))process.exit(2);if(isValidSha256Hex('DEADBEEF'))process.exit(3);if(isValidSha256Hex(hex+'x'))process.exit(4);if(isValidSha256Hex('zz'+hex.slice(2)))process.exit(5);try{shardPath('bad');process.exit(6)}catch{}console.log('paths ok')"</automated>
</verify>
```

**Done:**
- `src/attachments/paths.ts` exports `shardPath` and `isValidSha256Hex`.
- Uppercase hex is rejected (sha256 output from `node:crypto` is always lowercase).
- Non-hex characters are rejected.
- `shardPath` throws on invalid input.
- `npm run typecheck` passes.

**Commit message:** `feat(attachments): add pure path/shard helpers`

---

#### Task 2: The store itself (`src/attachments/store.ts`) + barrel (`src/attachments/index.ts`)

**Files:**
- `src/attachments/store.ts`
- `src/attachments/index.ts`

**Action:**

1. Create `src/attachments/store.ts`. This is the I/O module:

```typescript
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { shardPath, isValidSha256Hex } from './paths.ts';
import { newId } from '../util/id.ts';

/**
 * Result returned by `writeAttachment()`.
 *
 * - `sha256`: hex digest of the streamed bytes. This is the content address.
 * - `storagePath`: POSIX-style RELATIVE path from the store root (e.g.
 *    `de/01/de01...`). This is the string the DB's `attachments.storage_path`
 *    column should hold — the root can be reconfigured without rewriting rows.
 * - `sizeBytes`: byte count as observed during streaming. Source of truth for
 *    DB `attachments.size_bytes`; ignore any caller-supplied Content-Length.
 */
export interface WriteResult {
  sha256: string;
  storagePath: string;
  sizeBytes: number;
}

export interface AttachmentStore {
  /**
   * Streams the given Readable into the content-addressed store.
   *
   * Algorithm (D-27, atomic write):
   *   1. Open a temp file under `<root>/.incoming/<newId()>`.
   *   2. Pipe source → sha256 hasher + temp write stream in parallel.
   *   3. On 'finish': compute digest, compute final path = `<root>/<shard>/<digest>`.
   *   4. Ensure the shard directory exists (mkdir -p).
   *   5. rename(temp -> final). Atomic on same filesystem.
   *
   * Dedup: if the final path already exists, we rename-over-top (same content,
   * same path). On ext4/xfs/ntfs this is atomic. No dedup counter table — the
   * DB's `attachments` rows carry per-message references; orphan reaper checks
   * "does any row still reference this sha256?" before unlinking.
   */
  writeAttachment(source: Readable): Promise<WriteResult>;

  /**
   * Opens a Readable over the file identified by `sha256`. Returns null if
   * the file does not exist (do NOT throw on missing — caller distinguishes
   * 404 from 500 based on null vs rejection).
   *
   * Rejects the promise if the sha256 is structurally invalid (defense against
   * upstream bugs that forward user input here).
   */
  readAttachment(sha256: string): Promise<Readable | null>;

  /**
   * Deletes the file at `sha256`. Returns true if a file was removed, false if
   * it didn't exist (ENOENT is NOT an error — idempotent delete). Rejects only
   * on unexpected errors (EACCES, EIO, etc.).
   */
  unlinkBySha256(sha256: string): Promise<boolean>;

  /**
   * Returns { exists, sizeBytes } for quick existence + size check without
   * opening a stream. Used by the orphan reaper and by HEAD requests.
   */
  statBySha256(sha256: string): Promise<{ exists: true; sizeBytes: number } | { exists: false }>;

  /** The absolute root directory the store was opened against. Exposed for logging + tests. */
  readonly rootDir: string;
}

/**
 * Creates an attachment store rooted at `rootDir` (e.g. './data/attachments').
 *
 * Side effects at factory time: none — directories are created lazily on first
 * write. This keeps module import cheap and lets tests open stores against temp
 * directories without background setup.
 */
export function createAttachmentStore(rootDir: string): AttachmentStore {
  const incomingDir = join(rootDir, '.incoming');

  async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async function writeAttachment(source: Readable): Promise<WriteResult> {
    await ensureDir(incomingDir);

    const tempName = `tmp-${newId()}`;
    const tempPath = join(incomingDir, tempName);

    const hasher = createHash('sha256');
    let sizeBytes = 0;

    // Tap the stream to feed the hasher + count bytes, and pipe to disk.
    // We use the same trick as node's pipeline but with a side-effect transform:
    // we can't use a Transform here because pipeline() needs the source to
    // pipe to the writable. Instead, attach a 'data' listener for the hasher
    // alongside pipeline().
    //
    // NOTE: 'data' events can fire before pipeline's resolution if source is
    // synchronous. pipeline() itself awaits 'finish' on the writable. This is
    // well-defined for createWriteStream on POSIX + NTFS.
    source.on('data', (chunk: Buffer) => {
      hasher.update(chunk);
      sizeBytes += chunk.length;
    });

    const writeStream = createWriteStream(tempPath);

    try {
      await pipeline(source, writeStream);
    } catch (err) {
      // Streaming failed. Clean up the temp file; propagate.
      await unlink(tempPath).catch(() => {
        /* best-effort cleanup */
      });
      throw err;
    }

    const sha256 = hasher.digest('hex');
    // Defense in depth: the hasher only emits lowercase hex, but assert.
    if (!isValidSha256Hex(sha256)) {
      await unlink(tempPath).catch(() => {});
      throw new Error('writeAttachment: hasher returned invalid digest');
    }

    const relPath = shardPath(sha256);
    const finalPath = join(rootDir, relPath);
    await ensureDir(dirname(finalPath));

    // Atomic rename onto the content-addressed path. If the destination
    // already exists (dedup case), Node's rename overwrites on POSIX and,
    // on Windows (NTFS), rename-over-top of an existing file is supported
    // by fs.rename since Node 16.19 / 18.13. Good enough for our targets.
    await rename(tempPath, finalPath);

    return { sha256, storagePath: relPath, sizeBytes };
  }

  async function readAttachment(sha256: string): Promise<Readable | null> {
    if (!isValidSha256Hex(sha256)) {
      // Hard fail: something upstream passed user input.
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
      // ENOENT is fine (idempotent delete). Anything else we propagate.
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function statBySha256(
    sha256: string,
  ): Promise<{ exists: true; sizeBytes: number } | { exists: false }> {
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

/** Narrow a caught `unknown` to NodeJS.ErrnoException. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
```

Notes on the implementation:
- `pipeline(source, writeStream)` handles backpressure and cleanup. Errors propagate via the returned promise rejection.
- The sha256 is computed via a `source.on('data', ...)` listener in parallel with pipelining to disk. Both see the same bytes in the same order because `data` events fire before the writable consumes them — Node's stream contract.
- Alternative considered: a Transform stream that passes through while hashing. Rejected because it adds a pipeline stage and the listener approach is simpler and faster for our ≤10MB messages.
- Temp files live inside `<root>/.incoming/` (not OS tmpdir) to guarantee `rename()` stays on the same filesystem — cross-device rename fails with EXDEV.
- `.incoming/` files surviving a crash are harmless: they have no DB reference and the orphan reaper (Phase 6) will sweep them by age. We don't clean them up at startup in this plan — Phase 6 owns that.
- `access()` before `createReadStream()`: prevents returning a stream that immediately errors with ENOENT. Small race window (file unlinked between access and open) is acceptable; caller handles stream errors anyway.
- NTFS/Windows rename-over-existing is supported since Node 16.19 (STACK.md pins Node 22). No shim needed.

2. Create `src/attachments/index.ts` barrel file:

```typescript
export {
  createAttachmentStore,
  type AttachmentStore,
  type WriteResult,
} from './store.ts';
export { shardPath, isValidSha256Hex } from './paths.ts';
```

**Verify:**

```xml
<verify>
  <automated>npx tsx -e "import {createAttachmentStore} from './src/attachments/index.ts';import {Readable} from 'node:stream';import {createHash} from 'node:crypto';import {rm,mkdtemp,access,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';const root=await mkdtemp(join(tmpdir(),'tempmail-att-'));const store=createAttachmentStore(root);const data=Buffer.from('hello world','utf8');const expected=createHash('sha256').update(data).digest('hex');const src=Readable.from([data]);const w=await store.writeAttachment(src);if(w.sha256!==expected){console.error('sha mismatch',w.sha256,'vs',expected);process.exit(1)}if(w.sizeBytes!==data.length)process.exit(2);if(w.storagePath!==expected.slice(0,2)+'/'+expected.slice(2,4)+'/'+expected)process.exit(3);await access(join(root,w.storagePath));const stream=await store.readAttachment(w.sha256);if(!stream)process.exit(4);let buf=Buffer.alloc(0);for await(const c of stream)buf=Buffer.concat([buf,c]);if(!buf.equals(data))process.exit(5);const s=await store.statBySha256(w.sha256);if(!s.exists||s.sizeBytes!==data.length)process.exit(6);// Dedup: write the same bytes twice, same path.
const w2=await store.writeAttachment(Readable.from([data]));if(w2.sha256!==w.sha256||w2.storagePath!==w.storagePath)process.exit(7);// Missing: read a random sha.
const miss=await store.readAttachment('f'.repeat(64));if(miss!==null)process.exit(8);// Unlink: first time true, second time false (idempotent).
const u1=await store.unlinkBySha256(w.sha256);const u2=await store.unlinkBySha256(w.sha256);if(!u1||u2)process.exit(9);// Invalid sha rejected.
try{await store.readAttachment('short');process.exit(10)}catch{}await rm(root,{recursive:true,force:true});console.log('attachment-store ok')"</automated>
</verify>
```

**Done:**
- `src/attachments/store.ts` exports `createAttachmentStore`, `AttachmentStore`, `WriteResult`.
- `src/attachments/index.ts` re-exports the above + `shardPath` / `isValidSha256Hex`.
- Writing 'hello world' produces sha256 `b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9` and path `b9/4d/b94d27...`.
- `readAttachment(nonexistent)` returns null (NOT throws).
- `unlinkBySha256` is idempotent.
- `statBySha256` distinguishes exists/missing and reports accurate size.
- `npm run typecheck` passes.
- `npm run check` passes.

**Commit message:** `feat(attachments): add streaming content-addressed attachment store`

---

## Verification

From the repo root:

```bash
npm run typecheck
npm run check
# Functional smoke: see the Task 2 verify command — it exercises write, read,
# stat, unlink, dedup, and the invalid-sha rejection path end-to-end.
```

Plan 05 will add proper Vitest tests for edge cases (empty stream, 10MB stream, partial-write cleanup, concurrent writes of the same content).

Also scan for leaked abstractions: nothing outside `src/attachments/` should import `node:fs` for attachment I/O:

```bash
# Anything under src/ (excluding src/attachments/ and src/db/client.ts which may
# create DB file dirs) that reaches into node:fs for attachment bytes is a leak.
grep -rE "from 'node:fs" src/ --include="*.ts" | grep -v "src/attachments/" | grep -v "src/db/client.ts"
# Expected: zero matches for Phase 2 (SMTP + HTTP in later phases will import,
# but NOT for attachment bytes — they'll go through createAttachmentStore).
```

## Success criteria

- STORE-03 satisfied: bytes land at `<root>/<aa>/<bb>/<sha256>` with the first four hex chars of the content digest as the two shard directories; metadata (filename, content_type, size, sha256, storage_path) lives on the `attachments` DB row written by plan 03's `attachmentRepo`.
- Writes are atomic: rename-from-temp-to-final. A mid-write crash leaves bytes under `.incoming/` only (harmless; orphan reaper cleans).
- Reads never accept a user-controlled path component — only a sha256 hex, structurally validated.
- Dedup via content-addressing is automatic: writing identical bytes twice produces the same path (D-29).
- The store is the ONLY module in `src/` (outside `src/db/client.ts`) that imports `node:fs`.

## Output

Create `.planning/phases/02-storage-layer/02-04-SUMMARY.md` listing: the `AttachmentStore` interface, the `WriteResult` shape, how the store and `attachmentRepo` compose (writer returns sha256+storage_path → caller passes both to `insertMessageWithAttachments`), and the concrete on-disk layout with an example path.
