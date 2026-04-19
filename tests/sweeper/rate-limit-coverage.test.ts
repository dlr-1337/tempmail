/**
 * Plan 06-06 — ABUSE-01 rate-limit coverage tests.
 *
 * Phase 5's `tests/http/rate-limit.test.ts` already covers `mint` (5/min).
 * This file rounds out the buckets that weren't explicitly asserted:
 *   - `meta` bucket  (60/min on GET /api/inbox/:id)
 *
 * For each bucket, we spam until 429 + verify the canonical envelope +
 * Retry-After header are present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestRig, buildTestRig } from '../http/support.js';

describe('ABUSE-01 — per-route rate-limit coverage', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('meta bucket: GET /api/inbox/:id trips 429 after 60 reqs/min', async () => {
    // Mint an inbox first so we have a valid id + cookie.
    const mint = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(mint.statusCode).toBe(201);
    const setCookie = mint.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
    const m = /tempmail_vt_([^=]+)=([^;]+)/.exec(rawCookie);
    const inboxId = m?.[1] ?? '';
    const viewToken = m?.[2] ?? '';
    const cookies = { [`tempmail_vt_${inboxId}`]: viewToken };

    // 60 OK, 61st should 429.
    for (let i = 0; i < 60; i += 1) {
      const r = await rig.app.inject({
        method: 'GET',
        url: `/api/inbox/${inboxId}`,
        cookies,
      });
      expect(r.statusCode, `iteration ${i}`).toBe(200);
    }
    const blocked = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inboxId}`,
      cookies,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    const body = blocked.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rate_limited');
  });
});
