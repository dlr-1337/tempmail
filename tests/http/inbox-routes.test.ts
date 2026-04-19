import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookieNameFor } from '../../src/http/plugins/auth.js';
import { type TestRig, buildTestRig } from './support.js';

describe('POST /api/inbox', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('mints an inbox, returns 201, sets cookie', async () => {
    const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { address: string; expiresAt: number };
    expect(body.address).toMatch(/@example\.test$/);
    expect(typeof body.expiresAt).toBe('number');

    // Cookie header should carry HttpOnly, SameSite=Lax, and a scoped Path.
    const rawCookie = r.headers['set-cookie'];
    const setCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    expect(setCookie).toBeTruthy();
    const cookieStr = String(setCookie);
    expect(cookieStr).toMatch(/HttpOnly/);
    expect(cookieStr).toMatch(/SameSite=Lax/i);
    expect(cookieStr).toMatch(/Path=\/api\/inbox\//);
  });

  it('body does NOT include viewToken (cookie-only per D-06)', async () => {
    const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    const body = r.json() as Record<string, unknown>;
    expect(body.viewToken).toBeUndefined();
  });
});

describe('GET /api/inbox/:id', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('returns metadata with the right cookie', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      address: string;
      createdAt: number;
      lastActivityAt: number;
      expiresAt: number;
      messageCount: number;
    };
    expect(body.address).toBe(inbox.address);
    expect(body.messageCount).toBe(0);
    expect(body.expiresAt).toBe(inbox.expiresAt);
  });

  it('401 without cookie', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({ method: 'GET', url: `/api/inbox/${inbox.inboxId}` });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: 'unauthorized', message: 'missing view-token' } });
  });

  it('403 with wrong cookie', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: 'nope' },
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('404 on unknown inbox (with any cookie)', async () => {
    const fakeId = 'a'.repeat(22);
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${fakeId}`,
      cookies: { [cookieNameFor(fakeId)]: 'anything' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('400 on malformed inbox id', async () => {
    const r = await rig.app.inject({ method: 'GET', url: '/api/inbox/not-a-valid-id-x' });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe('invalid_request');
  });
});
