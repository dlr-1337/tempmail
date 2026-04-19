import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucketForPath, ipToPrefix } from '../../src/http/plugins/rate-limit.js';
import { type TestRig, buildTestRig } from './support.js';

describe('ipToPrefix', () => {
  it('IPv4 → /24', () => {
    expect(ipToPrefix('203.0.113.45')).toBe('203.0.113.0/24');
  });
  it('IPv6 → /64', () => {
    expect(ipToPrefix('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234:5678/64');
  });
  it('empty → 0.0.0.0/24 fallback', () => {
    expect(ipToPrefix('')).toBe('0.0.0.0/24');
  });
});

describe('bucketForPath', () => {
  const cases: Array<[string, string, string]> = [
    ['POST', '/api/inbox', 'mint'],
    ['GET', '/api/inbox/abc12345678901234567890', 'meta'],
    ['GET', '/api/inbox/abc/messages', 'read'],
    ['GET', '/api/inbox/abc/messages/def', 'read'],
    ['GET', '/api/inbox/abc/stream', 'stream'],
    ['GET', '/api/inbox/abc/attachments/xyz', 'attach'],
    ['GET', '/healthz', 'other'],
  ];
  for (const [m, p, expected] of cases) {
    it(`${m} ${p} → ${expected}`, () => {
      expect(bucketForPath(m, p)).toBe(expected);
    });
  }
});

describe('rate limit 429 envelope + recordAbuse', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('mint 6th request in 1 minute returns 429 with envelope + Retry-After', async () => {
    let calls = 0;
    const orig = rig.core.recordAbuse;
    rig.core.recordAbuse = (input) => {
      calls += 1;
      return orig(input);
    };

    // 5 OK, 6th should 429 (mint is 5/min per IP per D-18).
    for (let i = 0; i < 5; i += 1) {
      const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
      expect(r.statusCode).toBe(201);
    }
    const blocked = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    const body = blocked.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(calls).toBe(1);
  });
});
