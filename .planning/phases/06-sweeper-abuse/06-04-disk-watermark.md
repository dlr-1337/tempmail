---
phase: 06-sweeper-abuse
plan: 06-04
title: Disk watermark circuit breaker + SMTP/HTTP callback hooks + healthz
depends_on: [06-01]
requirements:
  - RETN-04
decisions:
  - D-12
  - D-13
  - D-14
  - D-15
  - D-16
---

# Plan 06-04 — Disk watermark

## Goal

Use `fs.statfs()` on the attachment-store root every 30s. Publish a state
getter consumed by SMTP (452 at 80%) and HTTP (503 at 90%). Healthz reflects
state but never 5xxs.

## Must-have checklist

- [ ] `src/sweeper/disk.ts` exports:
      - `DiskStatus = 'normal' | 'high' | 'critical'`
      - `DiskState = { percentUsed: number; bytesFree: number; bytesTotal: number; updatedAt: number; status: DiskStatus }`
      - `createDiskProbe(deps): { get(): DiskState; refresh(): Promise<DiskState> }`
      - `isAcceptingMail(state): boolean` (false when `high` OR `critical`)
      - `isAcceptingNewInboxes(state): boolean` (false when `critical`)
- [ ] Graceful degradation: if `fs.statfs` throws (Windows quirks), return a
      safe default `{ status: 'normal', percentUsed: 0 }` + warn once
- [ ] Thresholds configurable via `SweeperConfig.disk.{highWatermarkPct, criticalWatermarkPct}`
      with defaults 80/90
- [ ] `src/smtp/server.ts` gains optional dep `isAcceptingMail?: () => boolean`.
      When present and returns `false`, `onData` (or a thin MAIL-level gate)
      responds with `452 4.3.1 Insufficient system storage`.
- [ ] `src/http/server.ts` gains optional dep `diskState?: () => DiskState`.
      Inbox-mint route checks: critical → 503 with envelope `{error:{code:'server_error',message:'disk full'}}` (use a new code `unavailable` mapped to 503).
- [ ] `GET /healthz` augmented: when `diskState` provided, returns
      `{ status: 'ok'|'degraded', disk: { percentUsed, status } }`. Status
      'degraded' when high OR critical. Always 200.
- [ ] Tests:
      - `tests/sweeper/disk.test.ts` — probe returns state; transitions
        normal→high→critical given stubbed statfs
      - `tests/sweeper/smtp-mail-gate.test.ts` (or inline in data.test) —
        when `isAcceptingMail` returns false, SMTP session gets 452
      - `tests/sweeper/http-mint-gate.test.ts` — when `diskState` returns
        critical, POST /api/inbox returns 503
      - `tests/sweeper/healthz.test.ts` — healthz returns disk block when
        state provided; 200 either way

## Tasks

### 06-04-01 Disk probe module `<automated>`

`src/sweeper/disk.ts`:
- `createDiskProbe({ rootDir, config, logger, now, statfs? })` — statfs
  parameter injectable for tests.
- `refresh()` calls `fs.statfs(rootDir)` (dynamic import to avoid Windows
  crash at module load) → computes percent → updates in-memory state →
  returns state.
- `get()` returns last state (or initial `{ status: 'normal' }`).
- Helpers `isAcceptingMail(state)`, `isAcceptingNewInboxes(state)`.

Conventional commit: `feat(sweeper): add disk watermark probe with statfs`

### 06-04-02 Wire probe into sweeper `<automated>`

Update `src/sweeper/sweeper.ts`:
- `createSweeper` accepts `config.disk?` overrides + `attachmentStore` or
  explicit `rootDir`.
- The disk interval (30s) calls `probe.refresh()` and logs on transition.
- `SweeperHandle.diskState()` returns `probe.get()`.

Conventional commit: `feat(sweeper): schedule disk probe refresh every 30s`

### 06-04-03 SMTP `isAcceptingMail` hook `<automated>`

- Extend `SmtpServerDeps` with optional `isAcceptingMail?: () => boolean`.
- In `server.ts`, wrap `onData` in a check: if `isAcceptingMail` is provided
  AND returns false, respond 452 4.3.1 and log via `smtpLog.rateLimited` —
  or, cleaner, add `smtpLog.diskFull` that emits the same whitelisted fields
  with `smtp_code: 452`. Bump `abuse_counters` bucket `smtp_452` off (no —
  that's for rate limits; create new bucket `smtp_disk` OR reuse `smtp_452`
  if simpler — pick reuse for v1 to avoid schema work).
- Keep PII-safe: no envelope info in the log.

Conventional commit: `feat(smtp): 452 on DATA when disk watermark is high`

### 06-04-04 HTTP mint gate + healthz augmentation `<automated>`

- Add new error code `unavailable` → 503 in `src/http/errors.ts`.
- Extend `HttpServerDeps` with `diskState?: () => DiskState`.
- `POST /api/inbox` route: when `diskState` returns critical → `sendError(reply, 'unavailable', 'service temporarily unavailable')`.
- Replace the existing `GET /healthz` handler: returns `{ ok: true }` when no
  disk state provided; returns `{ status, disk }` when provided. Always 200.

Conventional commit: `feat(http): add disk-watermark gate to mint + healthz`

### 06-04-05 Tests `<automated>`

Four test files per must-have bullet. Use fake `statfs` injection for
determinism. Integration tests reuse existing smtp/http harnesses + pass the
disk callbacks.

Conventional commit: `test(sweeper): cover disk watermark, smtp 452, http 503, healthz`

## Verification

- All listed tests pass
- `npm run typecheck` / `npm run check` clean
