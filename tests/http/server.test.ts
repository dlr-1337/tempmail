import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestRig, buildTestRig } from './support.js';

describe('createHttpServer', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('GET /healthz returns { ok: true }', async () => {
    const r = await rig.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('applies helmet headers', async () => {
    const r = await rig.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(String(r.headers['strict-transport-security'])).toContain('max-age=31536000');
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('404 on unknown route', async () => {
    const r = await rig.app.inject({ method: 'GET', url: '/nope' });
    expect(r.statusCode).toBe(404);
  });
});
