import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookieNameFor } from '../../src/http/plugins/auth.js';
import { type TestRig, buildTestRig } from './support.js';

describe('authorizeInbox decorator', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig({ ready: false });
    // Register a test-only route that exposes the decorator's result so we can
    // assert each branch without depending on the public routes (which land in
    // plans 05-03/04/05). Must land BEFORE `app.ready()`.
    rig.app.get<{ Params: { id: string } }>(
      '/_test/auth/:id',
      { config: { rateLimit: false } },
      async (req, reply) => {
        const r = req.authorizeInbox(req.params.id);
        if (r.ok) return { ok: true };
        return reply.status(r.status).send({ ok: false, status: r.status });
      },
    );
    await rig.app.ready();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('missing cookie → 401', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({ method: 'GET', url: `/_test/auth/${inbox.inboxId}` });
    expect(r.statusCode).toBe(401);
  });

  it('wrong cookie → 403', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'GET',
      url: `/_test/auth/${inbox.inboxId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: 'definitely-wrong' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('right cookie → 200 ok', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'GET',
      url: `/_test/auth/${inbox.inboxId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('unknown inbox with cookie → 404', async () => {
    const fakeId = 'a'.repeat(22);
    const r = await rig.app.inject({
      method: 'GET',
      url: `/_test/auth/${fakeId}`,
      cookies: { [cookieNameFor(fakeId)]: 'anything' },
    });
    expect(r.statusCode).toBe(404);
  });
});
