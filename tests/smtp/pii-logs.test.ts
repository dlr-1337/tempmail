/**
 * SMTP-09 / D-28: after a full SMTP session, captured log events must contain
 * ZERO occurrences of the real recipient address, subject, body, or attachment
 * filename.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from './support/smtp-client.js';
import { type SmtpTestHarness, buildHarness } from './support/smtp-harness.js';

describe('PII-safe logging (SMTP-09)', () => {
  let harness: SmtpTestHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('captured log entries never contain the recipient address, subject, body, or filename', async () => {
    const minted = harness.core.createInbox();
    const [localPart] = minted.address.split('@');
    if (!localPart) throw new Error('invariant');

    const subject = 'Secret Subject That Must Never Log';
    const body = 'Body content: confidential-canary-string';
    const filename = 'confidential-filename.bin';

    const mime = [
      'From: "Sender" <sender@example.com>',
      `To: ${minted.address}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="bnd"',
      '',
      '--bnd',
      'Content-Type: text/plain',
      '',
      body,
      '--bnd',
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8td29ybGQ=',
      '--bnd--',
      '',
    ].join('\r\n');

    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    await c.command(`RCPT TO:<${minted.address}>`);
    await c.command('DATA');
    c.writeRaw(`${mime}\r\n.\r\n`);
    const reply = await c.read();
    expect(reply[0]).toMatch(/^250 /);
    await c.close();

    // Serialize all captured log events to a single string and grep for PII.
    const joined = JSON.stringify(harness.captured);
    expect(joined).not.toContain(minted.address);
    expect(joined).not.toContain(localPart);
    expect(joined).not.toContain(subject);
    expect(joined).not.toContain('confidential-canary-string');
    expect(joined).not.toContain(filename);
    // But it DOES contain the hashed local-part and the remote IP.
    const dataEvent = harness.captured.find((e) => e.msg === 'smtp.data.accept');
    expect(dataEvent?.obj.local_part_hash_first8).toMatch(/^[0-9a-f]{16}$/);
    expect(dataEvent?.obj.sender_ip).toBe('127.0.0.1');
    expect(dataEvent?.obj.sender_ip_prefix).toBe('127.0.0.0/24');
  });
});
