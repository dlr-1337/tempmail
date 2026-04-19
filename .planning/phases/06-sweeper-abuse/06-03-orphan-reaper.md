---
phase: 06-sweeper-abuse
plan: 06-03
title: Orphan reaper — walk attachment dir, unlink blobs with no DB references
depends_on: [06-01]
requirements:
  - RETN-03
decisions:
  - D-09
  - D-10
  - D-11
---

# Plan 06-03 — Orphan reaper

## Goal

Hourly pass over `<attachmentStore.rootDir>/**` that unlinks any blob whose
sha256 is NOT present in `attachmentRepo.listAllSha256s()`. Bounded to
10k files per run to avoid event-loop starvation.

## Must-have checklist

- [ ] `src/sweeper/reaper.ts` implements `runOrphanReaper(deps): Promise<ReaperResult>`
- [ ] Walks `<root>/<xx>/<yy>/*` recursively but skips `<root>/.incoming/*`
- [ ] Uses `attachmentRepo.listAllSha256s()` (existing) to build the reference
      set once per run
- [ ] For each on-disk file: if its basename is a valid sha256 hex AND it's
      not in the reference set, call `attachmentStore.unlinkBySha256(sha)`
- [ ] Cap processed = 10_000 files per run; resume on next tick
- [ ] Log one aggregate line: `{ event: 'sweeper.reaper.done', scanned, orphaned, unlinked, duration_ms }`
- [ ] `tests/sweeper/reaper.test.ts` covers:
      - blob referenced by DB row is NOT deleted
      - blob with NO reference IS deleted
      - `.incoming/*` temp files are never touched
      - invalid filenames (not sha256 hex) are skipped gracefully
      - bound is respected (seeding 15k files only scans 10k)

## Tasks

### 06-03-01 Implement `runOrphanReaper` `<automated>`

`src/sweeper/reaper.ts`:
- Import `readdir`, `stat` from `node:fs/promises`.
- Walk two-level shards `<root>/<aa>/<bb>/`.
- Skip `.incoming` directory entirely.
- For each basename of length 64 matching hex: check set; if orphan, unlink
  via `attachmentStore.unlinkBySha256`.
- Respect `maxPerRun` safety cap.
- Update sweeper.ts to wire this into the hourly tick.

Conventional commit: `feat(sweeper): add orphan attachment reaper`

### 06-03-02 Tests `<automated>`

`tests/sweeper/reaper.test.ts`:
- Allocate tmpdir + attachment store.
- Write 3 blobs via `attachmentStore.writeAttachment(...)`.
- Insert attachment rows for 2 of the 3 via repos.
- Also create a `.incoming/tmp-xxx` file manually (should survive).
- Also create a malformed filename (not 64 hex) (should survive).
- Run `runOrphanReaper` → assert only the 1 unreferenced blob is deleted.
- Bound test: seed maxPerRun + extras; assert scanned <= maxPerRun.

Conventional commit: `test(sweeper): cover orphan reaper bounds and safety`

## Verification

- `npm test -- tests/sweeper/reaper.test.ts` passes
- `npm run typecheck` / `npm run check` clean
