/**
 * Plan 06-02 tests — expiry sweep.
 *
 *   - idle-expired inbox deleted (no new messages in > idleTtl)
 *   - active-but-hard-expired inbox deleted (even with recent activity)
 *   - fresh inbox NOT deleted
 *   - aggregate counts reported correctly
 *   - log line uses whitelisted fields only (no addresses / local-parts)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SweeperRig, buildSweeperRig } from './support.js';

describe('expiry sweep (06-02 / RETN-01, RETN-02)', () => {
  let rig: SweeperRig;

  beforeEach(() => {
    rig = buildSweeperRig({
      initialNowMs: 1_700_000_000_000,
      idleTtlMs: 10 * 60_000, // 10min
      hardTtlMs: 60 * 60_000, // 1hr
    });
  });

  afterEach(async () => {
    await rig.sweeper.stop();
    rig.close();
  });

  it('idle-expired inbox is deleted by runOnce(expire)', async () => {
    const minted = rig.core.createInbox();
    // Jump forward past the sliding idle TTL.
    rig.setNow(rig.now() + 11 * 60_000);

    const result = await rig.sweeper.runOnce('expire');
    expect(result.expire?.expiredCount).toBe(1);
    expect(rig.core.getInbox(minted.inboxId).ok).toBe(false);
  });

  it('fresh inbox is NOT deleted', async () => {
    const minted = rig.core.createInbox();
    // Advance only 1s — well inside both TTLs.
    rig.setNow(rig.now() + 1_000);
    const result = await rig.sweeper.runOnce('expire');
    expect(result.expire?.expiredCount).toBe(0);
    expect(rig.core.getInbox(minted.inboxId).ok).toBe(true);
  });

  it('active-but-hard-expired inbox is deleted even with recent activity', async () => {
    const minted = rig.core.createInbox();
    // Simulate ongoing traffic by bumping last_activity_at at t=+30min. The
    // sliding expires_at gets pushed to (now+30min + 10min idle) = +40min,
    // but hard_expires_at is clamped at the 60-min ceiling.
    rig.setNow(rig.now() + 30 * 60_000);
    const newExpires = rig.now() + 10 * 60_000;
    rig.repos.inboxes.updateLastActivity(minted.inboxId, newExpires);

    // Jump to t=+65min — past the hard cap, still fresh on the sliding TTL
    // IF the updater hadn't clamped — which it did. Either way this row
    // must expire because hard_expires_at <= now.
    rig.setNow(1_700_000_000_000 + 65 * 60_000);

    const result = await rig.sweeper.runOnce('expire');
    expect(result.expire?.expiredCount).toBe(1);
    expect(rig.core.getInbox(minted.inboxId).ok).toBe(false);
  });

  it('aggregates counts across multiple inboxes', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(rig.core.createInbox().inboxId);
    }
    rig.setNow(rig.now() + 11 * 60_000);
    const result = await rig.sweeper.runOnce('expire');
    expect(result.expire?.expiredCount).toBe(3);
    for (const id of ids) {
      expect(rig.core.getInbox(id).ok).toBe(false);
    }
  });

  it('log line uses ONLY whitelisted aggregate fields (no addresses/inboxIds)', async () => {
    const minted = rig.core.createInbox();
    const addressLocal = minted.address.split('@')[0] ?? '';
    rig.setNow(rig.now() + 11 * 60_000);
    await rig.sweeper.runOnce('expire');

    const line = rig.captured.find((e) => e.obj.event === 'sweeper.expire.done');
    expect(line).toBeTruthy();
    const expectedKeys = [
      'event',
      'tick_id',
      'expired_count',
      'deleted_messages',
      'unlinked_blobs',
      'duration_ms',
    ];
    expect(Object.keys(line?.obj ?? {}).sort()).toEqual([...expectedKeys].sort());
    const joined = JSON.stringify(line);
    // Privacy-critical negatives.
    expect(joined).not.toContain(minted.inboxId);
    expect(joined).not.toContain(minted.address);
    expect(joined).not.toContain(addressLocal);
  });

  it('tick with zero expired inboxes still emits a log line with zeros', async () => {
    const result = await rig.sweeper.runOnce('expire');
    expect(result.expire?.expiredCount).toBe(0);
    expect(result.expire?.deletedMessages).toBe(0);
    expect(result.expire?.unlinkedBlobs).toBe(0);
    const line = rig.captured.find((e) => e.obj.event === 'sweeper.expire.done');
    expect(line?.obj.expired_count).toBe(0);
  });
});
