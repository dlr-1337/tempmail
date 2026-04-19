---
phase: 2
plan: 4
subsystem: attachment-store
tags: [attachments, filesystem, content-addressed, streaming, sha256]
dependency_graph:
  requires: ["02-01"]
  provides: ["attachment-store", "content-addressed-storage", "hash-sharded-paths"]
  affects: ["02-05", "04-*", "05-*", "06-*"]
tech_stack:
  added: []
  patterns:
    - "Content-addressed storage: filename = sha256(content), dedup is automatic"
    - "Atomic write: stream to `<root>/.incoming/tmp-<id>` then rename to final hash path"
    - "Two-level hash sharding: `<aa>/<bb>/<sha256>` caps directory fan-out"
    - "Factory-returned-record instead of class: `createAttachmentStore(root)` returns bound closures over `rootDir`"
    - "Structural guard before any filesystem use: `isValidSha256Hex()` gates every path build"
key_files:
  created:
    - path: "src/attachments/paths.ts"
      purpose: "Pure sha256 → sharded-path logic + hex validator; zero I/O, trivially unit-testable"
    - path: "src/attachments/store.ts"
      purpose: "createAttachmentStore() factory — writeAttachment, readAttachment, unlinkBySha256, statBySha256"
    - path: "src/attachments/index.ts"
      purpose: "Public barrel — re-exports everything external callers need"
  modified: []
decisions:
  - "D-24..D-29 confirmed and materialized in src/attachments/"
  - "Temp files live in `<root>/.incoming/` (not OS tmpdir) to guarantee same-FS rename (rename across filesystems fails with EXDEV)"
  - "sha256 hashing tapped via `source.on('data', ...)` in parallel with pipeline(); simpler than a Transform stage, fast enough for ≤10 MB messages"
  - "`createHash` imported lazily (dynamic import inside writeAttachment) so modules that only need the store *type* don't pay crypto init cost"
  - "`statBySha256` added alongside the plan's three must-have operations — callers need a size probe without opening a stream"
metrics:
  duration_minutes: ~6
  completed_date: "2026-04-18"
  tasks: 2
  files_created: 3
  files_modified: 0
---

# Phase 2 Plan 4: Hash-Sharded Attachment Store Summary

Built the single filesystem surface for attachment bytes: a content-addressed, streaming, hash-sharded store that SMTP ingestion (Phase 4) writes into and HTTP attachment-download (Phase 5) reads from. STORE-03 is satisfied end-to-end for the filesystem half — the DB half (metadata rows) is owned by plan 02-03's `attachmentRepo`.

## What Was Built

- **`src/attachments/paths.ts`** — two pure functions:
  - `shardPath(hex)` returns `<aa>/<bb>/<sha256>` (POSIX slashes, OS-independent).
  - `isValidSha256Hex(s)` returns true iff `s` is 64 lowercase hex chars. Uppercase is rejected because Node's `createHash('sha256').digest('hex')` emits lowercase — anything else was not produced by our hasher and must not be trusted as a path component (D-28).
  - Private `redact(s)` truncates rejected inputs before they hit error messages.
- **`src/attachments/store.ts`** — the `createAttachmentStore(rootDir)` factory. Side-effect-free at construction; directories are created lazily on first write. The returned `AttachmentStore` exposes:
  - `writeAttachment(source: Readable) → { sha256, storagePath, sizeBytes }`
  - `readAttachment(sha256: string) → Readable | null`
  - `unlinkBySha256(sha256: string) → boolean`
  - `statBySha256(sha256: string) → { exists: true, sizeBytes } | { exists: false }`
  - `readonly rootDir: string`
- **`src/attachments/index.ts`** — barrel re-exporting `createAttachmentStore`, `AttachmentStore`, `WriteResult`, `StatResult`, `shardPath`, `isValidSha256Hex`.

## Public API shape

```ts
export interface WriteResult {
  sha256: string;       // 64-char lowercase hex — goes into attachments.sha256
  storagePath: string;  // e.g. 'b9/4d/b94d27b9...' — goes into attachments.storage_path
  sizeBytes: number;    // observed during streaming — goes into attachments.size_bytes
}

export type StatResult = { exists: true; sizeBytes: number } | { exists: false };

export interface AttachmentStore {
  writeAttachment(source: Readable): Promise<WriteResult>;
  readAttachment(sha256: string): Promise<Readable | null>;
  unlinkBySha256(sha256: string): Promise<boolean>;
  statBySha256(sha256: string): Promise<StatResult>;
  readonly rootDir: string;
}

export function createAttachmentStore(rootDir: string): AttachmentStore;
```

## How this composes with plan 02-03's `attachmentRepo`

The two plans meet at the `{sha256, storagePath, sizeBytes}` triple. The call order at SMTP ingestion time is non-negotiable (per plan's locked decisions & PITFALLS):

```ts
// 1. Bytes first — if the write fails we abort before any DB row is created.
const a = await store.writeAttachment(partStream);

// 2. Metadata second — the transaction inside insertMessageWithAttachments()
//    commits the message + attachment rows atomically. The attachments row
//    references the already-durable file.
messageRepo.insertMessageWithAttachments({
  message: { /* ... */ },
  attachments: [
    {
      filename: part.filename,
      contentType: part.contentType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      storagePath: a.storagePath,
    },
  ],
});
```

If the transaction rolls back, the orphan reaper (Phase 6) sweeps the unreferenced blob by checking `SELECT 1 FROM attachments WHERE sha256 = ?`.

## On-disk layout

```
<rootDir>/
├── .incoming/
│   └── tmp-<22-char-nanoid>     ← live temp files; orphan reaper sweeps by age
├── b9/
│   └── 4d/
│       └── b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
└── de/
    └── ad/
        └── deadbeef...(64 hex chars total)
```

Example: `"hello world"` → sha256 `b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9`, lands at `<root>/b9/4d/b94d27b9...`. Verified end-to-end in the Task 2 smoke script.

## Algorithm — writeAttachment

1. `mkdir -p <root>/.incoming/`.
2. Allocate `tempPath = <root>/.incoming/tmp-<newId()>`.
3. Create a sha256 hasher and a byte counter.
4. Attach a `source.on('data', chunk => { hasher.update(chunk); size += chunk.length; })` side-tap.
5. `pipeline(source, createWriteStream(tempPath))` — handles backpressure + close + cleanup.
6. On pipeline error: best-effort `unlink(tempPath)`; rethrow.
7. `sha256 = hasher.digest('hex')`; assert `isValidSha256Hex(sha256)`.
8. `relPath = shardPath(sha256); finalPath = join(rootDir, relPath)`.
9. `mkdir -p dirname(finalPath)`.
10. `rename(tempPath, finalPath)` — atomic on same filesystem; rename-over-top is supported on POSIX and on Windows NTFS since Node 16.19 (dedup is a no-op).
11. Return `{ sha256, storagePath: relPath, sizeBytes }`.

A mid-write crash leaves bytes only under `.incoming/` (harmless; no DB row references them; Phase 6's reaper cleans them by age).

## Verification

- `npx tsx <smoke.mts>` round-trips `"hello world"`, asserts the sha matches a reference `createHash`, asserts the shard path, re-reads the stream and compares buffers, stats the file, dedups a second write, returns null on missing, idempotent-unlinks, and rejects every invalid-sha input.
- **Result: `attachment-store ok`** (exit 0).
- `npm run typecheck` → exit 0.
- `npm run check` (biome) → 18 files, 0 findings.
- `npm test` → 1 passed (sentinel; plan 02-05 adds real tests).
- Leak scan for `from 'node:fs'` in `src/**/*.ts` confirms ONLY `src/db/client.ts` (schema bootstrap) and `src/attachments/*` import `node:fs`. No other module reaches around the store.

## Success criteria status

- STORE-03 satisfied: bytes land at `<root>/<aa>/<bb>/<sha256>`; the caller carries metadata to plan 02-03's `attachmentRepo`.
- Atomic writes: rename-from-temp-to-final — verified in smoke test (dedup path re-runs the full algorithm and ends at the same final path).
- Reads never accept a user-controlled path: `readAttachment('short')` rejects; only a 64-char lowercase hex is accepted.
- Content-addressed dedup: two writes of the same bytes produce identical `{sha256, storagePath}`.
- Store is the ONLY non-DB module in `src/` that imports `node:fs`.

## Commits

| Task | Commit    | Files                                                       |
| ---- | --------- | ----------------------------------------------------------- |
| 1    | `5c32675` | `src/attachments/paths.ts`                                  |
| 2    | `6a4a207` | `src/attachments/store.ts`, `src/attachments/index.ts`      |

Plan 03's `bdf877f` and `7dc84f0` landed concurrently in between; no file overlap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `.ts` import extensions in source files**
- **Found during:** Task 2 initial authoring.
- **Issue:** The plan snippet imports with `.ts` extensions. The project's `tsconfig.json` sets `allowImportingTsExtensions: false` (inherited from plan 02-01's scaffolding), and existing code (`src/db/client.ts`) imports with `.js` extensions per the NodeNext-ESM convention plan 02-01 established.
- **Fix:** Used `.js` extensions in `src/attachments/store.ts` and `src/attachments/index.ts` to match the project's existing convention. Plan's intent (module specifiers that resolve through NodeNext) is preserved; only the extension form changed.
- **Files modified:** `src/attachments/store.ts`, `src/attachments/index.ts`
- **Commit:** `6a4a207`

**2. [Rule 2 — Missing critical functionality] Dynamic `createHash` import**
- **Found during:** Task 2 authoring.
- **Issue:** The plan's snippet imports `createHash` at module top. That pulls crypto setup cost into every import of the barrel, even for consumers that only need `AttachmentStore` as a type. For a 1-2 GB VPS, any module-load cost that can be deferred should be.
- **Fix:** Import `createHash` via dynamic `await import('node:crypto')` inside `writeAttachment()`. The only operation that needs it is writing; reading / stat / unlink do not. Node caches the module after first import so repeated writes pay the cost once.
- **Impact:** Slightly hotter first-write (negligible — `node:crypto` is a built-in, no disk I/O), zero-cost elsewhere.
- **Files modified:** `src/attachments/store.ts`
- **Commit:** `6a4a207`

**3. [Rule 1 — Bug] biome organizeImports on `store.ts`**
- **Found during:** Task 2 verify (post-`biome check`).
- **Issue:** Biome's alphabetization rule ranks bare identifiers before aliases, so `{ constants as fsConstants, createReadStream, createWriteStream }` was rejected; it wants `{ createReadStream, createWriteStream, constants as fsConstants }`.
- **Fix:** Re-ordered the single import. Same symbols, same semantics.
- **Files modified:** `src/attachments/store.ts`
- **Commit:** `6a4a207` (same Task 2 commit; fixed before committing).

### Additions beyond the plan

- **`statBySha256` added alongside the plan's three required operations.** The plan's source snippet included it and its tests exercised it, but the checklist at the top only listed write / read / unlink. The method is useful for HEAD-style probes and the orphan reaper's reference check, and its presence matches the plan's Task 2 snippet — treated as the plan's actual intent.
- **`StatResult` exported from the barrel.** Callers that type-annotate the return shape benefit from a named discriminated union; internal-only would have worked but exporting costs nothing.
- **Extra invalid-sha rejection assertions in Task 2's local smoke** (items 11–13 in `tmp-verify-02-04.mts`, since deleted): validated that `statBySha256` and `unlinkBySha256` also reject structurally-invalid input. The committed plan-verify command exercises only `readAttachment`; my extended run exercised all three entry points. No code change resulted — the code already did the right thing.

### Out-of-scope discoveries (logged to `deferred-items.md`)

- Pre-existing typecheck + formatter issues in `src/db/repos/inbox-repo.ts` (plan 02-03's territory). These were auto-resolved by plan 02-03's own executor before I needed to touch anything — see `.planning/phases/02-storage-layer/deferred-items.md` for the audit trail.

## Known Stubs

None. All three files are production code paths. No placeholder returns, no TODOs, no hardcoded empties flowing anywhere.

## Self-Check: PASSED

Files created exist:
- `src/attachments/paths.ts` — FOUND
- `src/attachments/store.ts` — FOUND
- `src/attachments/index.ts` — FOUND

Commits exist in `git log`:
- `5c32675` — feat(attachments): add pure path/shard helpers
- `6a4a207` — feat(attachments): add streaming content-addressed attachment store

Verification re-run on final state:
- `npm run typecheck` → exit 0
- `npm run check` → 18 files checked, 0 findings
- `npm test` → 1 passed
- Task 2 end-to-end smoke → `attachment-store ok`
- `node:fs` leak scan → only `src/db/client.ts` + `src/attachments/*` (as expected)
