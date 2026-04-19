---
phase: 06-sweeper-abuse
plan: 06-01
title: Sweeper scaffold, setInterval runner, re-entrancy guard, composition
depends_on: []
requirements:
  - RETN-01
  - RETN-02
  - RETN-03
  - RETN-04
decisions:
  - D-01
  - D-02
  - D-03
  - D-04
---

# Plan 06-01 — Sweeper scaffold

## Goal

Stand up `src/sweeper/` module with the interval runner, re-entrancy guard, and
composition factory. This plan produces the skeleton; later plans (06-02..06-04)
fill in the three periodic jobs.

## Must-have checklist

- [ ] `src/sweeper/sweeper.ts` exports `createSweeper(deps) -> SweeperHandle`
      with `start()`, `stop()`, `runOnce()`, `diskState()`
- [ ] `start()` schedules three `setInterval` timers (expire=60_000,
      reaper=3_600_000, disk=30_000)
- [ ] `stop()` clears all intervals AND awaits any in-flight run
- [ ] Re-entrancy guard: one boolean per job; if still running, skip tick and
      log once (`{ event: 'sweeper.tick_skipped', job }`)
- [ ] `runOnce({ job?: 'expire' | 'reaper' | 'disk' | 'all' })` triggers the
      named job(s) synchronously for tests
- [ ] `src/sweeper/index.ts` barrel with public exports
- [ ] `tests/sweeper/scaffold.test.ts` verifies:
      - factory constructs without throwing
      - `start()` + `stop()` are idempotent + symmetric
      - re-entrancy guard skips overlapping ticks
      - `runOnce('all')` invokes each job exactly once

## Tasks

### 06-01-01 Sweeper factory skeleton `<automated>`

Create `src/sweeper/sweeper.ts`. Define `SweeperConfig`, `SweeperDeps`,
`SweeperHandle`, `createSweeper`. Jobs delegate to job functions (stubs here,
wired in later plans). Re-entrancy guard is per-job boolean with try/finally.
`stop()` clears timers and awaits any in-flight promise.

Conventional commit: `feat(sweeper): add createSweeper scaffold with re-entrancy guard`

### 06-01-02 Job stubs `<automated>`

Create three files with async function signatures:
  - `src/sweeper/expire.ts` — `runExpireSweep(deps): Promise<ExpireResult>`
  - `src/sweeper/reaper.ts` — `runOrphanReaper(deps): Promise<ReaperResult>`
  - `src/sweeper/disk.ts`   — `updateDiskState(deps): Promise<void>` plus a
    `createDiskProbe(deps): DiskProbe` returning a getter for current state.

All three are minimal (return zeros / no-op) — later plans flesh out.

Conventional commit: `feat(sweeper): add job stubs for expire, reaper, disk`

### 06-01-03 Barrel + tests `<automated>`

- `src/sweeper/index.ts` re-exports public API.
- `tests/sweeper/scaffold.test.ts` covers the must-have bullets using Vitest
  fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTime`).

Conventional commit: `test(sweeper): cover scaffold, timers, re-entrancy guard`

## Verification

- `npm run typecheck` → 0 errors
- `npm run check` → 0 errors
- `npm test -- tests/sweeper/scaffold.test.ts` passes (≥ 4 cases)
