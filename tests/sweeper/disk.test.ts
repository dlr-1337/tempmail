/**
 * Plan 06-04 tests — disk watermark circuit breaker.
 *
 *   - Probe returns state; `get()` defaults to `normal`
 *   - Transitions normal → high → critical as fake statfs reports climbing %
 *   - Transition log lines use whitelisted fields
 *   - `isAcceptingMail` false at high/critical; true at normal
 *   - `isAcceptingNewInboxes` false ONLY at critical
 *   - Probe failure degrades gracefully (no throw, state stays `normal`)
 */

import type { StatsFs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAcceptingMail, isAcceptingNewInboxes } from '../../src/sweeper/index.js';
import { type SweeperRig, buildSweeperRig } from './support.js';

const makeStatfs = (percentUsed: number): ((_: string) => Promise<StatsFs>) => {
  // Pick blocks=1000 for easy math; bavail = (1-percent) * blocks.
  const blocks = 1000;
  const bavail = Math.max(0, Math.round(blocks * (1 - percentUsed / 100)));
  return async () =>
    ({
      type: 0,
      bsize: 4096,
      blocks,
      bfree: bavail,
      bavail,
      files: 0,
      ffree: 0,
    }) as StatsFs;
};

describe('disk watermark (06-04 / RETN-04)', () => {
  let rig: SweeperRig;
  let currentStatfs: (p: string) => Promise<StatsFs>;

  beforeEach(() => {
    currentStatfs = makeStatfs(0);
    rig = buildSweeperRig({ statfs: (p) => currentStatfs(p) });
  });

  afterEach(async () => {
    await rig.sweeper.stop();
    rig.close();
  });

  it('initial get() returns normal', () => {
    const state = rig.sweeper.diskState();
    expect(state.status).toBe('normal');
    expect(state.updatedAt).toBe(0);
  });

  it('transitions normal → high → critical as percent climbs', async () => {
    currentStatfs = makeStatfs(10);
    await rig.sweeper.runOnce('disk');
    expect(rig.sweeper.diskState().status).toBe('normal');

    currentStatfs = makeStatfs(85);
    await rig.sweeper.runOnce('disk');
    expect(rig.sweeper.diskState().status).toBe('high');

    currentStatfs = makeStatfs(95);
    await rig.sweeper.runOnce('disk');
    expect(rig.sweeper.diskState().status).toBe('critical');

    // Comes back down.
    currentStatfs = makeStatfs(50);
    await rig.sweeper.runOnce('disk');
    expect(rig.sweeper.diskState().status).toBe('normal');
  });

  it('transition log line uses whitelisted fields only', async () => {
    currentStatfs = makeStatfs(85);
    await rig.sweeper.runOnce('disk');
    const line = rig.captured.find((e) => e.obj.event === 'sweeper.disk.transition');
    expect(line).toBeTruthy();
    const keys = Object.keys(line?.obj ?? {}).sort();
    expect(keys).toEqual(['event', 'from', 'percent_used', 'to', 'updated_at']);
  });

  it('isAcceptingMail returns false at high or critical', async () => {
    currentStatfs = makeStatfs(85);
    await rig.sweeper.runOnce('disk');
    expect(isAcceptingMail(rig.sweeper.diskState())).toBe(false);
    currentStatfs = makeStatfs(10);
    await rig.sweeper.runOnce('disk');
    expect(isAcceptingMail(rig.sweeper.diskState())).toBe(true);
  });

  it('isAcceptingNewInboxes returns false ONLY at critical', async () => {
    currentStatfs = makeStatfs(85);
    await rig.sweeper.runOnce('disk');
    expect(isAcceptingNewInboxes(rig.sweeper.diskState())).toBe(true);
    currentStatfs = makeStatfs(95);
    await rig.sweeper.runOnce('disk');
    expect(isAcceptingNewInboxes(rig.sweeper.diskState())).toBe(false);
  });

  it('probe failure is swallowed and leaves state normal + logs a single warning', async () => {
    const failing = buildSweeperRig({
      statfs: async () => {
        throw new Error('EPERM: simulated');
      },
    });
    try {
      await failing.sweeper.runOnce('disk');
      await failing.sweeper.runOnce('disk');
      expect(failing.sweeper.diskState().status).toBe('normal');
      const warns = failing.captured.filter((e) => e.obj.event === 'sweeper.disk.probe_failed');
      expect(warns.length).toBe(1);
    } finally {
      await failing.sweeper.stop();
      failing.close();
    }
  });

  it('respects custom high/critical thresholds', async () => {
    const custom = buildSweeperRig({
      statfs: (_p) => makeStatfs(60)(_p),
      config: { disk: { highWatermarkPct: 50, criticalWatermarkPct: 70 } },
    });
    try {
      await custom.sweeper.runOnce('disk');
      expect(custom.sweeper.diskState().status).toBe('high');
    } finally {
      await custom.sweeper.stop();
      custom.close();
    }
  });
});
