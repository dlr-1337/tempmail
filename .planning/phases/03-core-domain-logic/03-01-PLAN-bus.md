---
phase: 3
plan: 1
status: ready
type: execute
wave: 1
depends_on: []
requirements: [CORE-03]
files_modified:
  - src/core/bus.ts
  - tests/core/bus.test.ts
autonomous: true
tags: [core, bus, event-bus, typed-emitter]
must_haves:
  truths:
    - "A listener registered via bus.on('message', fn) receives every subsequent emit('message', payload) exactly once"
    - "A listener registered via bus.once('message', fn) receives the next emit exactly once and no subsequent emits"
    - "bus.on and bus.once return an unsubscribe function; after calling it, the listener receives no further emits"
    - "A throw from a listener does not prevent other listeners from receiving the same event, and does not propagate to the emitter"
    - "The bus does not persist events — a listener attached after an emit does not receive that past event"
    - "The bus sets a generous max-listeners ceiling (>=100) so many SSE subscribers do not produce dev-time warnings"
  artifacts:
    - path: "src/core/bus.ts"
      provides: "createBus() factory returning a typed pub/sub with emit, on, once"
      exports: ["createBus", "Bus", "BusEvents", "MessageEvent"]
    - path: "tests/core/bus.test.ts"
      provides: "Vitest coverage of bus semantics"
  key_links:
    - from: "src/core/bus.ts"
      to: "node:events"
      via: "internal EventEmitter instance (not exported)"
      pattern: "from 'node:events'"
    - from: "tests/core/bus.test.ts"
      to: "src/core/bus.js"
      via: "import { createBus }"
      pattern: "from '.*src/core/bus.js'"
---

<objective>
Deliver `src/core/bus.ts` — a typed in-process pub/sub wrapper around `node:events` — and its Vitest coverage. The bus is the single notification channel Phase 5's SSE handler will subscribe to; it is ephemeral, has no persistence, and must isolate listener failures from the emitter.

Purpose: Decouple `ingestMessage` (Phase 3 plan 03) from Phase 5 SSE handlers. Emitters do not know who listens; listeners do not block the emitter; a buggy listener does not crash the SMTP hot path.

Output: One production module, one test file, three conventional commits.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/03-core-domain-logic/03-CONTEXT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md

<interfaces>
<!-- Existing helpers this plan can reuse. No imports from src/db/** in the bus. -->

From src/util/now.ts:
```typescript
export function nowMs(): number;
```

From tests/support/db-helper.ts + tmpdir.ts:
(not needed for this plan — the bus has no DB dependency)
</interfaces>

Conventions already locked by Phase 2 (apply verbatim):
- ESM + NodeNext — every relative import uses a `.js` extension (even though source is `.ts`).
- `tsconfig.json` sets `allowImportingTsExtensions: false`. Never write `from './foo.ts'`.
- Biome is the single lint+format tool; `biome.json` bans non-null assertions (`!`), `any`, and forces single quotes, trailing commas, semicolons, alphabetized imports, and numeric underscore separators (e.g. `1_000`, not `1000`). `npm run check` must exit 0.
- Vitest with `globals: false` — import `{ describe, expect, it, vi }` from `'vitest'` explicitly (alphabetized).
</context>

## Goal

Ship a dependency-free typed pub/sub that `ingestMessage` can emit to and an SSE handler can subscribe to, with deterministic semantics under listener failure and unsubscribe.

## Must-have checklist

- [x] **CORE-03** (partial): Provides the "emits an in-process event" half of `ingestMessage`. Plan 03 wires it in.

## Tasks

<task type="auto" tdd="true">
  <name>Task 1: Create typed bus module</name>
  <files>src/core/bus.ts</files>
  <behavior>
    - `createBus()` returns a `Bus` object with methods `emit`, `on`, `once`.
    - `Bus` type is exported alongside event payload types.
    - `emit('message', payload)` synchronously delivers to every currently-subscribed listener in subscription order.
    - `on('message', fn)` returns an `unsubscribe: () => void`; calling it removes the listener.
    - `once('message', fn)` returns an `unsubscribe: () => void`; listener auto-removes after the first delivery OR when the unsubscribe is called (whichever first).
    - A throw inside a listener is caught and logged to `console.error`; it must not (a) reach the emitter, (b) short-circuit other listeners for the same event.
    - Internal `EventEmitter` has `setMaxListeners(100)` to avoid dev-time warnings with many SSE subscribers.
    - No module-level singleton — `createBus()` is the only public entry point. The composition root (plan 04) is the only place that calls it for the process-wide bus.
  </behavior>
  <action>
    Create `src/core/bus.ts` containing exactly:

    ```typescript
    import { EventEmitter } from 'node:events';

    /**
     * Payload for the single event type the bus carries in v1.
     * Shape chosen so a subscriber (e.g. Phase 5 SSE) can either use it
     * directly (inboxId + messageId for replay query) or ignore the detail
     * and re-fetch the message via the repos.
     */
    export interface MessageEvent {
      inboxId: string;
      messageId: string;
      receivedAt: number;
    }

    /**
     * Map of event name -> payload. Extend here when a second event is added.
     * Keeping the union closed means the compiler rejects `emit('unknown', ...)`.
     */
    export interface BusEvents {
      message: MessageEvent;
    }

    export type BusListener<E extends keyof BusEvents> = (payload: BusEvents[E]) => void;

    export interface Bus {
      emit<E extends keyof BusEvents>(event: E, payload: BusEvents[E]): void;
      on<E extends keyof BusEvents>(event: E, listener: BusListener<E>): () => void;
      once<E extends keyof BusEvents>(event: E, listener: BusListener<E>): () => void;
    }

    /**
     * Creates an in-process event bus (D-08, D-09, D-10).
     *
     * - Ephemeral: no persistence, no replay (SSE handles replay separately per D-10).
     * - Isolated: a throwing listener is caught; other listeners still run.
     * - Typed: the `BusEvents` map closes the allowed event-name/payload universe.
     *
     * Tests instantiate their own bus via `createBus()`; the composition root
     * (src/core/index.ts) creates exactly one for the process.
     */
    export function createBus(): Bus {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(100);

      return {
        emit(event, payload) {
          // EventEmitter calls listeners synchronously in subscription order.
          // Any throw from a listener is caught inside the wrapper we installed
          // in `on`/`once`, so we never have to worry here.
          emitter.emit(event, payload);
        },

        on(event, listener) {
          const wrapped = (payload: BusEvents[typeof event]): void => {
            try {
              listener(payload);
            } catch (err) {
              // D-10: listener failures must not propagate to the emitter.
              console.error(`[bus] listener for '${event}' threw:`, err);
            }
          };
          emitter.on(event, wrapped);
          return () => {
            emitter.off(event, wrapped);
          };
        },

        once(event, listener) {
          // Can't use emitter.once directly because we need the wrapped listener
          // reference to support explicit unsubscribe before first delivery.
          let active = true;
          const wrapped = (payload: BusEvents[typeof event]): void => {
            if (!active) return;
            active = false;
            emitter.off(event, wrapped);
            try {
              listener(payload);
            } catch (err) {
              console.error(`[bus] once-listener for '${event}' threw:`, err);
            }
          };
          emitter.on(event, wrapped);
          return () => {
            if (!active) return;
            active = false;
            emitter.off(event, wrapped);
          };
        },
      };
    }
    ```

    Notes for the executor:
    - Do NOT add logging frameworks. `console.error` is the whole footprint.
    - Do NOT export the underlying `EventEmitter`; only the `Bus` interface.
    - If Biome's `organizeImports` rewrites the file, accept the rewrite.
  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>File exists, `npm run typecheck` exits 0, `npm run check` exits 0, module exports `createBus`, `Bus`, `BusEvents`, `MessageEvent`, `BusListener`.</done>
  <commit>feat(bus): add typed in-process event bus</commit>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Write Vitest suite covering bus semantics</name>
  <files>tests/core/bus.test.ts</files>
  <behavior>
    A single `describe('createBus', ...)` containing at minimum these cases:

    1. `emit delivers payload to every on() listener` — two listeners, one emit, both receive the exact payload (use `vi.fn()` + `toHaveBeenCalledWith`).
    2. `listeners are called synchronously in subscription order` — push receipt order into an array; after one emit, order matches subscription order.
    3. `unsubscribe from on() stops further delivery` — attach, unsubscribe, emit; listener called 0 times.
    4. `once() fires at most once` — attach with once, emit twice, listener called exactly once.
    5. `once() unsubscribe before any emit prevents delivery` — attach with once, call unsubscribe, emit; listener called 0 times.
    6. `a throwing listener does not break other listeners or propagate` — attach throwing-listener then good-listener, emit; good-listener called, emit does not throw. Silence `console.error` with `vi.spyOn(console, 'error').mockImplementation(() => {})` and assert it was called.
    7. `listener added after emit does not observe the past event` — emit, then attach, then assert listener called 0 times.
    8. `max listeners is set to >= 100` — dynamically attach 50 listeners to the same event via `bus.on` without the Node "possible EventEmitter memory leak detected" warning. (Verifiable by asserting no `process.emitWarning` occurred; simplest shape: attach 50, emit once, assert each called once.)

    Every test creates its own `createBus()` — no shared state.
  </behavior>
  <action>
    Create `tests/core/bus.test.ts` with all 8 cases above. Use this skeleton:

    ```typescript
    import { describe, expect, it, vi } from 'vitest';
    import { type Bus, createBus, type MessageEvent } from '../../src/core/bus.js';

    const samplePayload = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
      inboxId: 'ibx_1',
      messageId: 'msg_1',
      receivedAt: 1_700_000_000_000,
      ...overrides,
    });

    describe('createBus', () => {
      it('delivers payload to every on() listener', () => {
        const bus: Bus = createBus();
        const a = vi.fn();
        const b = vi.fn();
        bus.on('message', a);
        bus.on('message', b);
        const payload = samplePayload();
        bus.emit('message', payload);
        expect(a).toHaveBeenCalledWith(payload);
        expect(b).toHaveBeenCalledWith(payload);
      });

      it('calls listeners synchronously in subscription order', () => {
        const bus = createBus();
        const order: string[] = [];
        bus.on('message', () => order.push('first'));
        bus.on('message', () => order.push('second'));
        bus.emit('message', samplePayload());
        expect(order).toEqual(['first', 'second']);
      });

      it('unsubscribe from on() stops further delivery', () => {
        const bus = createBus();
        const listener = vi.fn();
        const unsubscribe = bus.on('message', listener);
        unsubscribe();
        bus.emit('message', samplePayload());
        expect(listener).not.toHaveBeenCalled();
      });

      it('once() fires at most once', () => {
        const bus = createBus();
        const listener = vi.fn();
        bus.once('message', listener);
        bus.emit('message', samplePayload());
        bus.emit('message', samplePayload({ messageId: 'msg_2' }));
        expect(listener).toHaveBeenCalledTimes(1);
      });

      it('once() unsubscribe before any emit prevents delivery', () => {
        const bus = createBus();
        const listener = vi.fn();
        const unsubscribe = bus.once('message', listener);
        unsubscribe();
        bus.emit('message', samplePayload());
        expect(listener).not.toHaveBeenCalled();
      });

      it('isolates a throwing listener from other listeners and the emitter', () => {
        const bus = createBus();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const thrower = vi.fn(() => {
          throw new Error('boom');
        });
        const good = vi.fn();
        bus.on('message', thrower);
        bus.on('message', good);
        expect(() => bus.emit('message', samplePayload())).not.toThrow();
        expect(thrower).toHaveBeenCalledTimes(1);
        expect(good).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
      });

      it('does not replay past emits to listeners added later', () => {
        const bus = createBus();
        bus.emit('message', samplePayload());
        const listener = vi.fn();
        bus.on('message', listener);
        expect(listener).not.toHaveBeenCalled();
      });

      it('supports many listeners without a memory-leak warning', () => {
        const bus = createBus();
        const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        const listeners = Array.from({ length: 50 }, () => vi.fn());
        for (const l of listeners) bus.on('message', l);
        bus.emit('message', samplePayload());
        for (const l of listeners) expect(l).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });
    ```

    If biome organizeImports rewrites the file header ordering, accept the rewrite; the test bodies must remain intact.
  </action>
  <verify>
    <automated>npx vitest run tests/core/bus.test.ts</automated>
  </verify>
  <done>All 8 cases pass; `npm run check` clean; `npm run typecheck` exit 0.</done>
  <commit>test(bus): cover typed bus semantics end-to-end</commit>
</task>

<task type="auto">
  <name>Task 3: Plan-level gate</name>
  <files>(none created)</files>
  <action>
    Run the full Phase 2 + Phase 3 (bus) test suite and the lint/typecheck gates to confirm no regressions:

    ```bash
    npm run typecheck
    npm run check
    npx vitest run
    ```

    Any red at this step means Task 1 or Task 2 left the tree dirty; fix in-plan and re-run.
  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run</automated>
  </verify>
  <done>All three commands exit 0. Phase 2's 49 tests still pass; the 8 new bus tests pass; total tests should be 57.</done>
</task>

## Verification

End-to-end verification for this plan:

```bash
# 1. Files exist
test -f src/core/bus.ts
test -f tests/core/bus.test.ts

# 2. Static checks
npm run typecheck        # exit 0
npm run check            # exit 0

# 3. Behavior
npx vitest run tests/core/bus.test.ts   # 8 passed
npx vitest run                          # 57 passed (49 existing + 8 new)
```

## Dependency Note

This plan is the leaf of Phase 3. Plans 03-02 (inboxes) and 03-03 (messages) may execute without it at the code level (they don't import `bus.ts`), but plan 03-04 (composition root) wires the bus into `createCore(deps)` and therefore depends on this plan completing first.

## Success Criteria

- `src/core/bus.ts` exists and exports `createBus`, `Bus`, `BusEvents`, `MessageEvent`, `BusListener`.
- `tests/core/bus.test.ts` has ≥ 8 passing cases covering emit, on, once, unsubscribe, throw-isolation, no-replay, and many-listeners.
- `npm run typecheck`, `npm run check`, and `npx vitest run` all exit 0.
- Three conventional commits on the branch: `feat(bus): ...`, `test(bus): ...`, and (if any auto-fix was needed) a single fix-up commit.

<output>
After completion, write `.planning/phases/03-core-domain-logic/03-01-SUMMARY.md` following `$HOME/.claude/get-shit-done/templates/summary.md`. Required sections: frontmatter (phase=3, plan=1, requirements: [CORE-03]), What Was Built, Verification Results, Commits, Deviations, Self-Check.
</output>
