/**
 * RCPT TO coverage: SMTP-04 unknown recipient → 550, wrong domain → 550,
 * existing inbox → 250 (ready for DATA).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from './support/smtp-client.js';
import { type SmtpTestHarness, buildHarness } from './support/smtp-harness.js';

describe('onRcptTo (SMTP-04, no catch-all)', () => {
  let harness: SmtpTestHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('550 for unknown local-part on the configured domain', async () => {
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    const rcpt = await c.command('RCPT TO:<nobody@tempmail.local>');
    expect(rcpt[0]).toMatch(/^550 /);
    expect(rcpt.join(' ')).toMatch(/Unknown recipient/);
    await c.close();
  });

  it('550 for an otherwise-valid local-part on a wrong domain (Relay access denied)', async () => {
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    const rcpt = await c.command('RCPT TO:<anybody@not-our-domain.example>');
    expect(rcpt[0]).toMatch(/^550 /);
    expect(rcpt.join(' ')).toMatch(/Relay access denied/);
    await c.close();
  });

  it('250 for an existing inbox', async () => {
    const minted = harness.core.createInbox();
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    const rcpt = await c.command(`RCPT TO:<${minted.address}>`);
    expect(rcpt[0]).toMatch(/^250 /);
    await c.close();
  });
});
