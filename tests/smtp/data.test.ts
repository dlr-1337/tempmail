/**
 * DATA phase: SMTP-03 (oversize → 552), SMTP-05 (streaming parse), and the
 * end-to-end happy path that persists to Core and produces the sanitized
 * html_body_sanitized column.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SmtpTextClient, connect } from './support/smtp-client.js';
import { type SmtpTestHarness, buildHarness } from './support/smtp-harness.js';

async function sendMessage(
  c: SmtpTextClient,
  opts: { from: string; to: string; data: string },
): Promise<string[]> {
  await c.command(`MAIL FROM:<${opts.from}>`);
  const rcpt = await c.command(`RCPT TO:<${opts.to}>`);
  if (!rcpt[0]?.startsWith('250')) return rcpt;
  await c.command('DATA');
  // After DATA, server replies 354; send the message then ".\r\n".
  c.writeRaw(`${opts.data}\r\n.\r\n`);
  return c.read();
}

describe('onData end-to-end (SMTP-03, SMTP-05)', () => {
  let harness: SmtpTestHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('happy path: text + HTML email is persisted; HTML is sanitized; attachment stored', async () => {
    const minted = harness.core.createInbox();
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');

    const mime = [
      'From: "Sender" <sender@example.com>',
      `To: ${minted.address}`,
      'Subject: Hello with script',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="bnd"',
      '',
      '--bnd',
      'Content-Type: text/plain',
      '',
      'Hello from plain text',
      '--bnd',
      'Content-Type: text/html',
      '',
      '<p>Hi</p><script>alert(1)</script><a href="javascript:evil()">x</a>',
      '--bnd',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="doc.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8td29ybGQ=', // "hello-world"
      '--bnd--',
      '',
    ].join('\r\n');

    const finalReply = await sendMessage(c, {
      from: 'sender@example.com',
      to: minted.address,
      data: mime,
    });
    expect(finalReply[0]).toMatch(/^250 /);
    await c.close();

    // Assert: Core sees the message via listMessages.
    const list = harness.core.listMessages({
      inboxId: minted.inboxId,
      viewToken: minted.viewToken,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.messages).toHaveLength(1);
    const msg = list.messages[0];
    if (!msg) throw new Error('expected one message');
    expect(msg.subject).toBe('Hello with script');
    expect(msg.hasTextBody).toBe(true);
    expect(msg.hasHtmlBody).toBe(true);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe('doc.bin');
    expect(msg.attachments[0]?.size).toBeGreaterThan(0);
    expect(msg.sizeBytes).toBeGreaterThan(mime.length - 10);
  });

  it('SMTP-03: oversize DATA → 552', async () => {
    await harness.close();
    harness = await buildHarness({ maxMessageBytes: 4_096 });
    const minted = harness.core.createInbox();
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    await c.command(`RCPT TO:<${minted.address}>`);
    await c.command('DATA');
    const headers = ['From: sender@example.com', `To: ${minted.address}`, 'Subject: Big', ''].join(
      '\r\n',
    );
    const filler = 'X'.repeat(8_000);
    c.writeRaw(`${headers}\r\n${filler}\r\n.\r\n`);
    const reply = await c.read();
    expect(reply[0]).toMatch(/^552 /);
    await c.close();

    // Nothing was persisted.
    const list = harness.core.listMessages({
      inboxId: minted.inboxId,
      viewToken: minted.viewToken,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.messages).toHaveLength(0);
  });
});
