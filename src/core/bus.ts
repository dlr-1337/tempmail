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
