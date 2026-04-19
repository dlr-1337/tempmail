import { describe, expect, it, vi } from 'vitest';
import { type Bus, type MessageEvent, createBus } from '../../src/core/bus.js';

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
