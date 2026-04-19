/**
 * Plan 06-04 — SMTP 452 on DATA when disk watermark is high.
 *
 * We build the SMTP harness without the disk-gate, then additionally a
 * parallel server with a `isAcceptingMail` stub that returns false — and
 * verify a DATA attempt produces 452.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { createCore } from '../../src/core/index.js';
import { openDb } from '../../src/db/client.js';
import { createRepos } from '../../src/db/repos/index.js';
import { type SmtpConfig, type SmtpPinoLike, createSmtpServer } from '../../src/smtp/index.js';
import { connect } from '../smtp/support/smtp-client.js';

interface MailGateRig {
  port: number;
  close: () => Promise<void>;
  captured: Array<{ level: string; obj: Record<string, unknown>; msg?: string }>;
  address: string;
}

async function buildRig(isAcceptingMail: () => boolean): Promise<MailGateRig> {
  const dir = mkdtempSync(join(tmpdir(), 'tempmail-smtpgate-'));
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const attachmentStore = createAttachmentStore(dir);
  const domain = 'tempmail.local';
  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: { domain, idleTtlMs: 10 * 60_000, hardTtlMs: 60 * 60_000 },
  });
  const minted = core.createInbox();

  const config: SmtpConfig = {
    port: 0,
    hostname: '127.0.0.1',
    domain,
    maxMessageBytes: 10 * 1024 * 1024,
    tls: { devGenerateSelfSigned: true },
    rateLimit: { tokensPerMinute: 10, burst: 20 },
    timeouts: { socketMs: 60_000, closeMs: 30_000 },
    piiLogSalt: 'test-salt-sufficiently-long',
  };

  const captured: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  const logger: SmtpPinoLike = {
    info: (o, m) => captured.push({ level: 'info', obj: o as Record<string, unknown>, msg: m }),
    warn: (o, m) => captured.push({ level: 'warn', obj: o as Record<string, unknown>, msg: m }),
    error: (o, m) => captured.push({ level: 'error', obj: o as Record<string, unknown>, msg: m }),
    debug: (o, m) => captured.push({ level: 'debug', obj: o as Record<string, unknown>, msg: m }),
  };

  const server = await createSmtpServer({
    core,
    attachmentStore,
    abuseRepo: repos.abuse,
    config,
    logger,
    isAcceptingMail,
  });
  const port = await server.listen();

  return {
    port,
    address: minted.address,
    captured,
    async close() {
      await server.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('SMTP disk-watermark gate (06-04 / RETN-04)', () => {
  let rig: MailGateRig;

  afterEach(async () => {
    if (rig) await rig.close();
  });

  it('DATA is rejected with 452 when isAcceptingMail returns false', async () => {
    rig = await buildRig(() => false);
    const c = await connect({ port: rig.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    await c.command(`RCPT TO:<${rig.address}>`);
    await c.command('DATA');
    c.writeRaw(
      [
        'From: <sender@example.com>',
        `To: ${rig.address}`,
        'Subject: blocked',
        '',
        'hello',
        '.',
        '',
      ].join('\r\n'),
    );
    const reply = await c.read();
    expect(reply[0]).toMatch(/^452 /);
    await c.close();
  });

  it('DATA succeeds with 250 when isAcceptingMail returns true', async () => {
    rig = await buildRig(() => true);
    const c = await connect({ port: rig.port });
    await c.read();
    await c.command('EHLO tester');
    await c.command('MAIL FROM:<sender@example.com>');
    await c.command(`RCPT TO:<${rig.address}>`);
    await c.command('DATA');
    c.writeRaw(
      [
        'From: <sender@example.com>',
        `To: ${rig.address}`,
        'Subject: ok',
        '',
        'hello',
        '.',
        '',
      ].join('\r\n'),
    );
    const reply = await c.read();
    expect(reply[0]).toMatch(/^250 /);
    await c.close();
  });
});
