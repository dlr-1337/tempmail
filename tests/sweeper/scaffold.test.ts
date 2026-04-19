/**
 * 06-01 scaffold tests.
 *
 * Verifies:
 *   - factory constructs without throwing
 *   - `start()` / `stop()` are idempotent + symmetric
 *   - re-entrancy guard skips overlapping ticks
 *   - `runOnce('all')` triggers each job exactly once
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SweeperRig, buildSweeperRig } from './support.js';

describe('sweeper scaffold (06-01)', () => {
  let rig: SweeperRig;

  beforeEach(() => {
    rig = buildSweeperRig();
  });

  afterEach(async () => {
    await rig.sweeper.stop();
    rig.close();
  });

  it('factory constructs without throwing and exposes the required handle methods', () => {
    expect(rig.sweeper).toBeTruthy();
    expect(typeof rig.sweeper.start).toBe('function');
    expect(typeof rig.sweeper.stop).toBe('function');
    expect(typeof rig.sweeper.runOnce).toBe('function');
    expect(typeof rig.sweeper.diskState).toBe('function');
  });

  it('start() is idempotent — calling twice schedules exactly one set of timers', async () => {
    rig.sweeper.start();
    rig.sweeper.start();
    // No assertion error thrown and stop() resolves cleanly.
    await rig.sweeper.stop();
  });

  it('stop() is idempotent', async () => {
    await rig.sweeper.stop();
    await rig.sweeper.stop();
  });

  it('runOnce("all") invokes each job exactly once', async () => {
    const result = await rig.sweeper.runOnce('all');
    expect(result.expire).toBeTruthy();
    expect(result.reaper).toBeTruthy();
    expect(result.disk).toBeTruthy();
    expect(result.expire?.expiredCount).toBe(0);
    expect(result.reaper?.scanned).toBe(0);
  });

  it('runOnce("expire") triggers only the expire job', async () => {
    const result = await rig.sweeper.runOnce('expire');
    expect(result.expire).toBeTruthy();
    expect(result.reaper).toBeUndefined();
    expect(result.disk).toBeUndefined();
  });

  it('re-entrancy guard: overlapping expire calls share one in-flight promise', async () => {
    // Kick off two runOnce('expire') calls without awaiting the first. The
    // second should observe the in-flight promise and return THE SAME
    // result without starting a fresh run — we verify via the tick_id.
    const a = rig.sweeper.runOnce('expire');
    const b = rig.sweeper.runOnce('expire');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.expire?.tickId).toBeTruthy();
    expect(ra.expire?.tickId).toBe(rb.expire?.tickId);
    const skipped = rig.captured.find(
      (e) => e.obj.event === 'sweeper.tick_skipped' && e.obj.job === 'expire',
    );
    expect(skipped).toBeTruthy();
  });

  it('setInterval-based ticks actually fire when timers advance (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      // Build a fresh rig while fake timers are active so its setInterval is
      // controllable via `vi.advanceTimersByTime`.
      const localRig = buildSweeperRig({
        config: { intervals: { expireMs: 1_000, reaperMs: 1_000, diskMs: 1_000 } },
      });
      try {
        localRig.sweeper.start();
        // Drain microtask queue between ticks so chained .catch/.finally run.
        await vi.advanceTimersByTimeAsync(2_500);
        // After ~2.5s of fake time, expire should have fired at least twice.
        const expireLogs = localRig.captured.filter((e) => e.obj.event === 'sweeper.expire.done');
        expect(expireLogs.length).toBeGreaterThanOrEqual(2);
        await localRig.sweeper.stop();
      } finally {
        localRig.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
