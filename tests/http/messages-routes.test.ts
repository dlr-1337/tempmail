import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookieNameFor } from '../../src/http/plugins/auth.js';
import { type TestRig, buildTestRig } from './support.js';

const seedMessage = (core: TestRig['core'], address: string, subject: string): string => {
  const r = core.ingestMessage({
    envelopeTo: address,
    envelopeFrom: 'a@b.test',
    sender: 'Sender',
    subject,
    textBody: `text of ${subject}`,
    htmlBody: `<p>html of ${subject}</p>`,
    headers: null,
    attachments: [],
    sizeBytes: 100,
  });
  if (!r.ok) throw new Error(`ingest failed: ${r.reason}`);
  return r.messageId;
};

describe('GET /api/inbox/:id/messages', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('empty inbox returns []', async () => {
    const inbox = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ messages: [] });
  });

  it('returns ASC chronological metadata without bodies', async () => {
    const inbox = rig.core.createInbox();
    seedMessage(rig.core, inbox.address, 'first');
    seedMessage(rig.core, inbox.address, 'second');
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      messages: Array<{ subject: string; hasHtmlBody: boolean; hasTextBody: boolean }>;
    };
    expect(body.messages.map((m) => m.subject)).toEqual(['first', 'second']);
    for (const m of body.messages) {
      expect(m).not.toHaveProperty('textBody');
      expect(m).not.toHaveProperty('htmlBody');
      expect(m.hasTextBody).toBe(true);
      expect(m.hasHtmlBody).toBe(true);
    }
  });

  it('401 no cookie, 403 bad cookie', async () => {
    const inbox = rig.core.createInbox();
    const noCookie = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages`,
    });
    expect(noCookie.statusCode).toBe(401);

    const bad = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages`,
      cookies: { [cookieNameFor(inbox.inboxId)]: 'wrong' },
    });
    expect(bad.statusCode).toBe(403);
  });
});

describe('GET /api/inbox/:id/messages/:msgId', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('returns the full message (bodies + attachment metadata)', async () => {
    const inbox = rig.core.createInbox();
    const msgId = seedMessage(rig.core, inbox.address, 'hi');
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages/${msgId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      id: string;
      subject: string;
      textBody: string;
      htmlBody: string;
      attachments: unknown[];
    };
    expect(body.id).toBe(msgId);
    expect(body.subject).toBe('hi');
    expect(body.textBody).toBe('text of hi');
    expect(body.htmlBody).toBe('<p>html of hi</p>');
    expect(body.attachments).toEqual([]);
  });

  it('404 on unknown message id (valid shape)', async () => {
    const inbox = rig.core.createInbox();
    const fakeMsg = 'z'.repeat(22);
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages/${fakeMsg}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(404);
  });

  it('404 when the message belongs to a different inbox', async () => {
    const a = rig.core.createInbox();
    const b = rig.core.createInbox();
    const msgInA = seedMessage(rig.core, a.address, 'A-only');
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${b.inboxId}/messages/${msgInA}`,
      cookies: { [cookieNameFor(b.inboxId)]: b.viewToken },
    });
    expect(r.statusCode).toBe(404);
  });

  it('serves htmlBody verbatim (Core does not sanitize — SMTP already did)', async () => {
    const inbox = rig.core.createInbox();
    const ingest = rig.core.ingestMessage({
      envelopeTo: inbox.address,
      envelopeFrom: null,
      sender: null,
      subject: 'raw',
      textBody: null,
      htmlBody: '<p>safe</p>',
      headers: null,
      attachments: [],
      sizeBytes: 1,
    });
    if (!ingest.ok) throw new Error('ingest failed');
    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/messages/${ingest.messageId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    const body = r.json() as { htmlBody: string };
    expect(body.htmlBody).toBe('<p>safe</p>');
  });
});
