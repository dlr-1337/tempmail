/**
 * Server-bind + SMTP-01..03 + SMTP-06 smoke: port binds, banner arrives,
 * EHLO advertises SIZE and STARTTLS, AUTH is rejected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from './support/smtp-client.js';
import { type SmtpTestHarness, buildHarness } from './support/smtp-harness.js';

describe('SMTP server bind, banner, capabilities (SMTP-01, 02, 03, 06)', () => {
  let harness: SmtpTestHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('SMTP-01: listens on an ephemeral port and sends a 220 banner', async () => {
    const c = await connect({ port: harness.port });
    const greeting = await c.read();
    expect(greeting[0]).toMatch(/^220 /);
    expect(greeting[0]).toContain('tempmail SMTP');
    await c.close();
  });

  it('SMTP-03 + SMTP-06: EHLO advertises SIZE=10485760 and STARTTLS', async () => {
    const c = await connect({ port: harness.port });
    await c.read(); // greeting
    const lines = await c.command('EHLO client.example');
    const joined = lines.join('\n');
    expect(joined).toContain('SIZE 10485760');
    expect(joined).toContain('STARTTLS');
    await c.close();
  });

  it('SMTP-02: AUTH command is refused because it is in disabledCommands', async () => {
    const c = await connect({ port: harness.port });
    await c.read();
    await c.command('EHLO client.example');
    const reply = await c.command('AUTH PLAIN AGZvbwBiYXI=');
    // smtp-server replies 500/502/503 when AUTH is disabled.
    expect(reply[0]).toMatch(/^50[0235] /);
    await c.close();
  });

  it('SMTP-08: raw smtp-server options expose explicit socketTimeout and closeTimeout', () => {
    expect(harness.server.raw.options.socketTimeout).toBe(60_000);
    expect(harness.server.raw.options.closeTimeout).toBe(30_000);
  });
});
