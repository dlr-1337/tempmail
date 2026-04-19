/**
 * End-to-end SMTP-07: once the per-IP-prefix bucket is empty, subsequent
 * RCPT TO attempts receive 452 and the abuse counter is incremented (D-23).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from './support/smtp-client.js';
import { type SmtpTestHarness, buildHarness } from './support/smtp-harness.js';

describe('rate limiting (SMTP-07, D-21, D-23)', () => {
  let harness: SmtpTestHarness;

  beforeEach(async () => {
    // Tight bucket + frozen clock so the test is deterministic.
    harness = await buildHarness({
      tokensPerMinute: 6,
      burst: 3,
      initialNowMs: 1_700_000_000_000,
    });
  });
  afterEach(async () => {
    await harness.close();
  });

  it('returns 452 after the burst is exhausted and increments abuse_counters', async () => {
    const minted = harness.core.createInbox();
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');

    // First 3 RCPTs consume the burst.
    const ok1 = await c.command(`RCPT TO:<${minted.address}>`);
    expect(ok1[0]).toMatch(/^250 /);
    const ok2 = await c.command(`RCPT TO:<${minted.address}>`);
    expect(ok2[0]).toMatch(/^250 /);
    const ok3 = await c.command(`RCPT TO:<${minted.address}>`);
    expect(ok3[0]).toMatch(/^250 /);

    // 4th RCPT trips the limiter.
    const blocked = await c.command(`RCPT TO:<${minted.address}>`);
    expect(blocked[0]).toMatch(/^452 /);
    expect(blocked.join(' ')).toMatch(/Too many requests/);
    await c.close();

    // Log capture confirms rate_limited event was emitted with 452.
    const rate = harness.captured.find((e) => e.msg === 'smtp.rate_limited');
    expect(rate).toBeDefined();
    expect(rate?.obj.smtp_code).toBe(452);

    // Abuse counter row: the window is floor(nowMs / 60_000) * 60_000.
    const windowStart = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
    const count = harness.repos.abuse.getCounter('127.0.0.0/24', 'smtp_452', windowStart);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
