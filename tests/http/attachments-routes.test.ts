import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookieNameFor } from '../../src/http/plugins/auth.js';
import { formatContentDisposition } from '../../src/http/routes/attachments.js';
import { type TestRig, buildTestRig } from './support.js';

const seedWithAttachment = async (
  rig: TestRig,
  address: string,
  filename: string | null,
  body: string,
): Promise<{ messageId: string; sha256: string }> => {
  const w = await rig.attachmentStore.writeAttachment(Readable.from([Buffer.from(body)]));
  const r = rig.core.ingestMessage({
    envelopeTo: address,
    envelopeFrom: null,
    sender: null,
    subject: 'with-att',
    textBody: null,
    htmlBody: null,
    headers: null,
    attachments: [
      {
        filename,
        contentType: 'application/octet-stream',
        size: w.sizeBytes,
        sha256: w.sha256,
        path: w.storagePath,
      },
    ],
    sizeBytes: w.sizeBytes,
  });
  if (!r.ok) throw new Error('ingest failed');
  return { messageId: r.messageId, sha256: w.sha256 };
};

describe('GET /api/inbox/:id/attachments/:attId', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildTestRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('streams bytes with correct headers', async () => {
    const inbox = rig.core.createInbox();
    const bodyStr = 'hello world attachment body';
    await seedWithAttachment(rig, inbox.address, 'doc.txt', bodyStr);

    const list = rig.core.listMessages({ inboxId: inbox.inboxId, viewToken: inbox.viewToken });
    if (!list.ok) throw new Error('list failed');
    const first = list.messages[0];
    if (!first) throw new Error('no message');
    const attId = first.attachments[0]?.id;
    if (!attId) throw new Error('no attachment id');

    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/attachments/${attId}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-disposition'])).toContain('filename="doc.txt"');
    expect(r.body).toBe(bodyStr);
  });

  it('401 without cookie, 404 on unknown attId', async () => {
    const inbox = rig.core.createInbox();
    const fake = 'z'.repeat(22);
    const noAuth = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/attachments/${fake}`,
    });
    expect(noAuth.statusCode).toBe(401);
    const withAuth = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inbox.inboxId}/attachments/${fake}`,
      cookies: { [cookieNameFor(inbox.inboxId)]: inbox.viewToken },
    });
    expect(withAuth.statusCode).toBe(404);
  });

  it('404 on attachment that belongs to a different inbox', async () => {
    const a = rig.core.createInbox();
    const b = rig.core.createInbox();
    await seedWithAttachment(rig, a.address, 'x.bin', 'abc');
    const listA = rig.core.listMessages({ inboxId: a.inboxId, viewToken: a.viewToken });
    if (!listA.ok) throw new Error('list failed');
    const attInA = listA.messages[0]?.attachments[0]?.id;
    if (!attInA) throw new Error('no attachment');

    const r = await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${b.inboxId}/attachments/${attInA}`,
      cookies: { [cookieNameFor(b.inboxId)]: b.viewToken },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('formatContentDisposition (RFC 5987)', () => {
  it('ASCII filename', () => {
    expect(formatContentDisposition('photo.png')).toBe('attachment; filename="photo.png"');
  });
  it('null filename', () => {
    expect(formatContentDisposition(null)).toBe('attachment');
  });
  it('non-ASCII gets filename* encoded', () => {
    const r = formatContentDisposition('café.txt');
    expect(r).toContain('filename="caf_.txt"');
    expect(r).toContain("filename*=UTF-8''caf%C3%A9.txt");
  });
  it('escapes quotes in ASCII fallback', () => {
    const r = formatContentDisposition('a"b.txt');
    expect(r).toBe('attachment; filename="a_b.txt"');
  });
});
