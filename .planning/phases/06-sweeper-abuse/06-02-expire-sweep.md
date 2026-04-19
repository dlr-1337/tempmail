---
phase: 06-sweeper-abuse
plan: 06-02
title: Expiry sweep — loop expired inboxes through core.expireInbox
depends_on: [06-01]
requirements:
  - RETN-01
  - RETN-02
decisions:
  - D-05
  - D-06
  - D-07
  - D-08
---

# Plan 06-02 — Expiry sweep

## Goal

`runExpireSweep` walks every inbox whose `expires_at <= now` OR
`hard_expires_at <= now` and calls `core.expireInbox({ inboxId })` per hit.
Aggregates counts into a single log line per tick (no per-inbox PII).

## Must-have checklist

- [ ] `src/sweeper/expire.ts` implements `runExpireSweep(deps)` that:
      - calls `repos.inboxes.listExpired(now, batchSize)` in a loop until an
        empty page is returned
      - calls `core.expireInbox({ inboxId })` for each row; accumulates
        `expired_count`, `deleted_messages`, `unlinked_blobs`
      - emits one log line at INFO with whitelisted fields
        `{ event, tick_id, expired_count, deleted_messages, unlinked_blobs, duration_ms }`
- [ ] `listExpired` must honor BOTH `expires_at` AND `hard_expires_at` — extend
      query if needed. (The idle TTL is already bumped on activity, so
      `expires_at <= now` already covers idle expiry; `hard_expires_at <= now`
      must expire even if a message arrived 1ms ago.)
- [ ] Batch size default = 500; caller may override via `SweeperConfig.expireBatchSize`.
- [ ] `tests/sweeper/expire.test.ts` covers:
      - idle-expired inbox is deleted (no new messages in > idleTtl)
      - active-but-hard-expired inbox is deleted (even with recent activity)
      - fresh inbox is NOT deleted
      - aggregate counts are reported correctly
      - log line uses whitelisted fields only (no addresses / local-parts)

## Tasks

### 06-02-01 Extend `listExpired` to honor hard cap `<automated>`

Update `src/db/repos/inbox-repo.ts`:
- Change `listExpiredStmt` SQL from
  `WHERE expires_at < ?` to
  `WHERE expires_at <= ? OR hard_expires_at <= ?`.
- Update the signature — still takes one cutoff param (callers always pass
  `nowMs`), pass it twice internally.
- Update docstring to mention hard-cap semantics.

Add regression test in `tests/db/inbox-repo.test.ts` if not already present.

Conventional commit: `fix(db): listExpired honors hard_expires_at ceiling`

### 06-02-02 Implement `runExpireSweep` `<automated>`

`src/sweeper/expire.ts`:

```ts
export interface ExpireResult {
  tickId: string;
  expiredCount: number;
  deletedMessages: number;
  unlinkedBlobs: number;
  durationMs: number;
}

export async function runExpireSweep(deps): Promise<ExpireResult> { ... }
```

- Loop `listExpired(now, 500)` until page returns empty or we've processed >
  `maxPerTick` (safety cap = 10_000) to bound event-loop hold.
- Per-row: `await core.expireInbox({ inboxId: row.id })`. Accumulate from
  result (`ok: true` gives `deletedMessages` + `unlinkedAttachments`).
- Emit exactly one log line at INFO level; no per-inbox logs.
- Return the aggregate for `runOnce` callers.

Update sweeper.ts to wire `runExpireSweep` into the expire tick.

Conventional commit: `feat(sweeper): implement expire sweep over core.expireInbox`

### 06-02-03 Tests `<automated>`

`tests/sweeper/expire.test.ts`:
- Builds an in-memory DB + real core + real attachment tmpdir.
- Creates multiple inboxes with an injected clock. Advances clock past idle
  TTL → runs `sweeper.runOnce('expire')` → asserts inbox count / attachment
  files deleted.
- Creates one inbox whose `hard_expires_at` < now but `expires_at` far future
  (mutate `last_activity_at`) → still expired.
- Captures logger output (pino destination + sink stub) and asserts only
  whitelisted fields present.

Conventional commit: `test(sweeper): cover idle, hard-TTL, and aggregate counts`

## Verification

- `npm test -- tests/sweeper/expire.test.ts tests/db/inbox-repo.test.ts` passes
- `npm run typecheck` / `npm run check` clean
