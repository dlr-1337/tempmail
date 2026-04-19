---
phase: 03-core-domain-logic
plan: 01
subsystem: core
tags: [event-bus, typed-emitter, pub-sub, node-events, ephemeral, isolation]

# Dependency graph
requires:
  - phase: 02-storage-layer
    provides: "Biome + TypeScript + Vitest toolchain, ESM + NodeNext conventions"
provides:
  - "src/core/bus.ts — createBus() factory returning a typed in-process pub/sub"
  - "Exported types: Bus, BusEvents, MessageEvent, BusListener"
  - "Deterministic semantics: synchronous delivery, subscription-order, unsubscribe, no replay"
  - "Listener-failure isolation: throws are caught and logged; emitter and peers unaffected"
  - "Generous max-listeners ceiling (100) for SSE subscriber fan-out"
affects: [03-02-inboxes, 03-03-messages, 03-04-composition-root, 05-http-sse]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory-returning-bound-functions (Bus interface wraps node:events.EventEmitter)"
    - "Closed event union via BusEvents map — compiler rejects unknown event names"
    - "Wrapped listeners with try/catch + console.error isolation"

key-files:
  created:
    - src/core/bus.ts
    - tests/core/bus.test.ts
  modified: []

key-decisions:
  - "D-08: createBus() exposes emit/on/once; on/once return unsubscribe functions."
  - "D-09: No module-level singleton — composition root (src/core/index.ts) owns the process-wide instance; tests create their own bus."
  - "D-10: Ephemeral only. No persistence, no replay, no retry. Listener failures caught and logged, never propagated."
  - "Custom once() wrapper (not emitter.once) so an explicit unsubscribe before the first delivery also prevents delivery."
  - "setMaxListeners(100) to accommodate many SSE subscribers without dev-time emitWarning noise."

patterns-established:
  - "ESM relative imports use .js extensions even when source is .ts (NodeNext strict)."
  - "Biome organizeImports alphabetizes named specifiers (type imports included)."
  - "Tests import { describe, expect, it, vi } explicitly (globals: false)."
  - "Each test instantiates its own bus via createBus() — no shared state between cases."

requirements-completed: [CORE-03]

# Metrics
duration: ~15min
completed: 2026-04-19
---

# Phase 3 Plan 01: Typed Event Bus Summary

**Typed in-process pub/sub (`createBus`) wrapping `node:events.EventEmitter` with synchronous delivery, listener-failure isolation, unsubscribe semantics, and a 100-listener ceiling — the notification channel Phase 5's SSE handler will subscribe to.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-19T13:50Z (approx.)
- **Completed:** 2026-04-19T14:07Z
- **Tasks:** 3
- **Files modified:** 2 (created)

## Accomplishments

- `createBus()` factory returning a typed `Bus` with `emit`, `on`, `once`.
- Closed event-name union (`BusEvents.message → MessageEvent { inboxId, messageId, receivedAt }`).
- Listener-failure isolation via per-listener try/catch; `console.error` log, no propagation.
- Custom `once()` wrapper supports explicit pre-delivery unsubscribe.
- `setMaxListeners(100)` prevents dev-time memory-leak warnings with many SSE subscribers.
- Vitest coverage of all 8 documented semantics (delivery, order, unsubscribe, once, throw-isolation, no-replay, many-listeners).
- Full suite 57/57 pass (49 existing + 8 new). Typecheck and Biome clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create typed bus module** — `a037ead` (feat)
2. **Task 2: Write Vitest suite covering bus semantics** — `9c2c891` (test)
3. **Task 3: Plan-level gate** — no commit (verification-only task; no file changes)

**Plan metadata:** pending (docs commit created after this file is written)

## Files Created/Modified

- `src/core/bus.ts` — `createBus()` factory, `Bus`/`BusEvents`/`MessageEvent`/`BusListener` exports.
- `tests/core/bus.test.ts` — 8 Vitest cases covering bus semantics end-to-end.

## Verification Results

All three gates exit 0:

- `npm run typecheck` — 0 errors.
- `npm run check` — Biome clean across 33 files.
- `npx vitest run` — 57/57 tests pass (49 pre-existing + 8 new in `tests/core/bus.test.ts`).
- `npx vitest run tests/core/bus.test.ts` — 8/8 pass individually.

## Decisions Made

- Followed plan verbatim; module body and test skeleton matched the plan's `<action>` blocks exactly.
- Biome's `organizeImports` rewrote the test file's import specifiers to alphabetical order (`Bus, MessageEvent, createBus`); accepted the rewrite as pre-authorized by the plan.

## Deviations from Plan

None functional. The only adjustment was the Biome-driven import specifier alphabetization in `tests/core/bus.test.ts`, which the plan explicitly pre-authorized ("If biome organizeImports rewrites the file header ordering, accept the rewrite; the test bodies must remain intact"). Applied before the Task 2 commit, so no separate fix-up commit was needed.

## Issues Encountered

- First Biome check run after writing `tests/core/bus.test.ts` flagged import ordering. Resolved by alphabetizing named specifiers before commit. Not counted as a deviation per the plan's explicit allowance.

## User Setup Required

None — no external services, no env vars, no dashboard configuration.

## Next Phase Readiness

- Bus is ready for consumption by plan 03-03 (`ingestMessage` emits `'message'` after DB commit) and plan 03-04 (composition root instantiates the process-wide bus).
- Phase 5 SSE handler can subscribe with confidence in: sync delivery, unsubscribe, throw-isolation, no-replay (replay is the SSE handler's concern per D-11).
- No blockers. Plans 03-02 and 03-03 can proceed in any order; plan 03-04 must wait on 02/03/01.

## Known Stubs

None. The bus is a complete, production-ready module; no placeholder data flows or TODOs.

## Threat Flags

None. The bus introduces no new network surface, auth path, file access, or schema change. All data flowing through it is already derived from trusted internal callers (`ingestMessage`), and listener failures are contained (cannot crash the SMTP hot path).

## Self-Check: PASSED

- `src/core/bus.ts` — FOUND
- `tests/core/bus.test.ts` — FOUND
- `.planning/phases/03-core-domain-logic/03-01-SUMMARY.md` — FOUND
- Commit `a037ead` (feat(bus)) — FOUND
- Commit `9c2c891` (test(bus)) — FOUND
- Typecheck, Biome, full Vitest suite — all exit 0 with 57 passing tests.

---
*Phase: 03-core-domain-logic*
*Completed: 2026-04-19*
