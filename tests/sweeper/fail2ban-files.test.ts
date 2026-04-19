/**
 * Plan 06-05 — fail2ban template files are shipped with expected anchors.
 *
 * We don't try to boot fail2ban; these are static-content checks that catch
 * accidental deletion or mis-edits.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const OPS = resolve(__dirname, '..', '..', 'ops', 'fail2ban');

describe('fail2ban templates (06-05 / ABUSE-05)', () => {
  it('filter.d/tempmail-smtp.conf exists with a [Definition] and failregex on sender_ip + smtp_code', () => {
    const body = readFileSync(join(OPS, 'filter.d', 'tempmail-smtp.conf'), 'utf8');
    expect(body).toContain('[Definition]');
    expect(body).toContain('failregex');
    expect(body).toContain('sender_ip');
    expect(body).toContain('<HOST>');
    expect(body).toMatch(/smtp_code":\(452\|550\|554\)/);
  });

  it('filter.d/tempmail-http.conf exists with a failregex on 429 + host', () => {
    const body = readFileSync(join(OPS, 'filter.d', 'tempmail-http.conf'), 'utf8');
    expect(body).toContain('[Definition]');
    expect(body).toContain('failregex');
    expect(body).toContain('<HOST>');
    expect(body).toContain('429');
  });

  it('jail.d/tempmail.conf defines both jails with findtime+maxretry+bantime', () => {
    const body = readFileSync(join(OPS, 'jail.d', 'tempmail.conf'), 'utf8');
    expect(body).toContain('[tempmail-smtp]');
    expect(body).toContain('[tempmail-http]');
    expect(body).toContain('findtime');
    expect(body).toContain('maxretry');
    expect(body).toContain('bantime');
    expect(body).toContain('filter   = tempmail-smtp');
    expect(body).toContain('filter   = tempmail-http');
  });
});
