---
phase: 5
plan: 4
status: ready
type: execute
wave: 3
depends_on: [05-02]
requirements: [API-03, API-04, API-08, API-10]
files_modified:
  - src/http/routes/messages.ts
  - src/http/routes/attachments.ts
  - src/http/server.ts
  - tests/http/messages-routes.test.ts
  - tests/http/attachments-routes.test.ts
autonomous: true
tags: [routes, messages, attachments, streaming]
must_haves:
  truths:
    - "GET /api/inbox/:id/messages returns chronological message metadata"
    - "GET /api/inbox/:id/messages/:msgId returns full message (bodies + attachment metadata)"
    - "GET /api/attachments/:id streams bytes with Content-Disposition: attachment + X-Content-Type-Options: nosniff"
    - "Filename in Content-Disposition uses RFC 5987 encoding for non-ASCII"
    - "Auth via cookie for all three routes"
    - "Rate limits: 120/min for list + read, 60/min for attachment"
---

# Plan 05-04: Message routes + attachment streaming

## Goal

Ship `GET /api/inbox/:id/messages`, `GET /api/inbox/:id/messages/:msgId`, and `GET /api/attachments/:id` with streamed bytes.

## Must-have checklist

- [ ] Message list returns chronological metadata; no bodies
- [ ] Single message returns text + sanitized HTML + attachment metadata (never sha256)
- [ ] Attachment route streams from disk via `attachmentStore.readAttachment(sha256)`
- [ ] `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` when non-ASCII
- [ ] `X-Content-Type-Options: nosniff`, `Content-Type: application/octet-stream`
- [ ] Tests: list happy/empty, single happy/not-found, cookie failure modes, attachment stream bytes, attachment not-found, unknown attachment, filename encoding

## Tasks

<task type="auto">
  <name>Task 1: Messages route module</name>
  <files>src/http/routes/messages.ts</files>
  <action>

  Create `src/http/routes/messages.ts`:

  ```typescript
  /**
   * Message endpoints (API-03, API-04, API-10).
   *
   * GET /api/inbox/:id/messages            — metadata list (no bodies)
   * GET /api/inbox/:id/messages/:msgId     — full message
   *
   * Cookie required. Rate limit: 120/min per IP for both (D-18).
   */

  import type { FastifyInstance } from 'fastify';
  import type { ZodTypeProvider } from 'fastify-type-provider-zod';
  import type { CoreApi } from '../../core/index.js';
  import { sendError } from '../errors.js';
  import { cookieNameFor } from '../plugins/auth.js';
  import { inboxIdParam, messageIdParam } from '../schemas.js';

  export interface MessageRoutesDeps {
    core: CoreApi;
  }

  export async function registerMessageRoutes(
    app: FastifyInstance,
    deps: MessageRoutesDeps,
  ): Promise<void> {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/api/inbox/:id/messages',
      {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: { params: inboxIdParam },
      },
      async (req, reply) => {
        const auth = req.authorizeInbox(req.params.id);
        if (!auth.ok) {
          return sendError(
            reply,
            auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'not_found',
            auth.status === 401 ? 'missing view-token' : auth.status === 403 ? 'bad view-token' : 'inbox not found',
          );
        }
        const token = req.cookies[cookieNameFor(req.params.id)] ?? '';
        const r = deps.core.listMessages({ inboxId: req.params.id, viewToken: token });
        if (!r.ok) {
          return sendError(
            reply,
            r.reason === 'not_found' ? 'not_found' : 'forbidden',
            r.reason === 'not_found' ? 'inbox not found' : 'bad view-token',
          );
        }
        return reply.status(200).send({ messages: r.messages });
      },
    );

    typed.get(
      '/api/inbox/:id/messages/:msgId',
      {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: { params: messageIdParam },
      },
      async (req, reply) => {
        const auth = req.authorizeInbox(req.params.id);
        if (!auth.ok) {
          return sendError(
            reply,
            auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'not_found',
            auth.status === 401 ? 'missing view-token' : auth.status === 403 ? 'bad view-token' : 'inbox not found',
          );
        }
        const token = req.cookies[cookieNameFor(req.params.id)] ?? '';
        const r = deps.core.getMessage({
          inboxId: req.params.id,
          messageId: req.params.msgId,
          viewToken: token,
        });
        if (!r.ok) {
          return sendError(
            reply,
            r.reason === 'not_found' ? 'not_found' : 'forbidden',
            r.reason === 'not_found' ? 'message not found' : 'bad view-token',
          );
        }
        return reply.status(200).send(r.message);
      },
    );
  }
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): add message list and single-message routes</commit>
</task>

<task type="auto">
  <name>Task 2: Attachment route module</name>
  <files>src/http/routes/attachments.ts</files>
  <action>

  Create `src/http/routes/attachments.ts`:

  ```typescript
  /**
   * Attachment download endpoint (API-08).
   *
   * GET /api/attachments/:id
   *
   * Auth: must possess the view-token cookie for the inbox that owns the
   * attachment's message. The route walks: attachmentId → message → inbox,
   * then asks core.verifyInboxAccess (via getAttachmentForInbox which does all
   * of this atomically). On success, streams the file from attachment storage.
   *
   * Because the URL carries only the attachmentId (not the inbox id), we must
   * look up the inbox id from the attachment row. The browser still sends the
   * relevant `tempmail_vt_<inboxId>` cookie because the path-scoped cookies
   * set at mint time aren't in scope for `/api/attachments/*`. That's the
   * trade-off of the per-inbox cookie model.
   *
   * SOLUTION: require the client to pass `?inbox=<inboxId>` as a query param
   * OR include the inboxId in the path as `/api/inbox/:id/attachments/:attId`.
   * The latter matches the view-token cookie scope automatically.
   *
   * Decision: ship `/api/inbox/:id/attachments/:attId` as the canonical route,
   * keep `/api/attachments/:id` as a deferred v2 convenience (skipped in v1).
   * This keeps the cookie auth story dead-simple: same pattern as other routes.
   *
   * Rate limit: 60/min per IP (D-18).
   */

  import type { FastifyInstance } from 'fastify';
  import type { ZodTypeProvider } from 'fastify-type-provider-zod';
  import { z } from 'zod';
  import type { AttachmentStore } from '../../attachments/index.js';
  import type { CoreApi } from '../../core/index.js';
  import { sendError } from '../errors.js';
  import { cookieNameFor } from '../plugins/auth.js';
  import { idSchema } from '../schemas.js';

  export interface AttachmentRoutesDeps {
    core: CoreApi;
    attachmentStore: AttachmentStore;
  }

  const paramsSchema = z.object({ id: idSchema, attId: idSchema });

  /**
   * RFC 5987: encode non-ASCII filenames as `filename*=UTF-8''<percent-encoded>`.
   * Keep a plain `filename="<ascii-fallback>"` for legacy clients.
   */
  export function formatContentDisposition(filename: string | null): string {
    if (!filename) return 'attachment';
    const asciiOnly = /^[\x20-\x7e]+$/.test(filename);
    if (asciiOnly) {
      const safe = filename.replace(/["\\]/g, '_');
      return `attachment; filename="${safe}"`;
    }
    const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
  }

  export async function registerAttachmentRoutes(
    app: FastifyInstance,
    deps: AttachmentRoutesDeps,
  ): Promise<void> {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/api/inbox/:id/attachments/:attId',
      {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: { params: paramsSchema },
      },
      async (req, reply) => {
        const auth = req.authorizeInbox(req.params.id);
        if (!auth.ok) {
          return sendError(
            reply,
            auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'not_found',
            auth.status === 401 ? 'missing view-token' : auth.status === 403 ? 'bad view-token' : 'inbox not found',
          );
        }
        const token = req.cookies[cookieNameFor(req.params.id)] ?? '';
        const r = deps.core.getAttachmentForInbox({
          inboxId: req.params.id,
          attachmentId: req.params.attId,
          viewToken: token,
        });
        if (!r.ok) {
          return sendError(
            reply,
            r.reason === 'not_found' ? 'not_found' : 'forbidden',
            r.reason === 'not_found' ? 'attachment not found' : 'bad view-token',
          );
        }

        const stream = await deps.attachmentStore.readAttachment(r.attachment.sha256);
        if (!stream) return sendError(reply, 'not_found', 'attachment missing from store');

        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', formatContentDisposition(r.attachment.filename));
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, no-store');
        reply.header('Content-Length', String(r.attachment.size));
        return reply.send(stream);
      },
    );
  }
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): add scoped attachment download route</commit>
</task>

<task type="auto">
  <name>Task 3: Register routes in server factory</name>
  <files>src/http/server.ts</files>
  <action>

  Edit `src/http/server.ts`. Extend `HttpServerDeps` to accept an `attachmentStore`, and register the two new route modules after inbox routes:

  ```typescript
  import type { AttachmentStore } from '../attachments/index.js';
  import { registerAttachmentRoutes } from './routes/attachments.js';
  import { registerMessageRoutes } from './routes/messages.js';

  export interface HttpServerDeps {
    core: CoreApi;
    attachmentStore: AttachmentStore;
    config: HttpServerConfig;
    logger?: pino.Logger;
  }

  // inside createHttpServer, after registerInboxRoutes:
  await registerMessageRoutes(app, { core: deps.core });
  await registerAttachmentRoutes(app, { core: deps.core, attachmentStore: deps.attachmentStore });
  ```

  Also update `tests/http/support.ts` to pass `attachmentStore` through to `createHttpServer` — it was constructed but not forwarded; add it:

  ```typescript
  // inside buildTestRig:
  const app = await createHttpServer({
    core,
    attachmentStore,
    config: { ... },
  });
  ```

  And accept a `tmpDir` option on `buildTestRig` so tests that need a real attachment dir can provide one. Change the default: use `withTmpDir` internally when a tmpDir isn't passed. Concrete change: expose `buildTestRigInTmp` as a new helper that wraps `withTmpDir` for integration tests. Minimum viable: accept an `attachmentDir: string` argument and default it to a `mkdtempSync` when not provided, cleaning up in `close()`.

  Implementation (replace `support.ts` `buildTestRig`):

  ```typescript
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  export async function buildTestRig(cfg?: Partial<HttpServerConfig>): Promise<TestRig> {
    const attachmentDir = mkdtempSync(join(tmpdir(), 'tempmail-http-'));
    const { db, repos } = openTestDbWithRepos();
    const attachmentStore = createAttachmentStore(attachmentDir);
    const core = createCore({
      db,
      repos,
      attachmentStore,
      config: { domain: 'example.test', idleTtlMs: 10 * 60_000, hardTtlMs: 60 * 60_000 },
    });
    const app = await createHttpServer({
      core,
      attachmentStore,
      config: { cookieSecret: 'test', hardTtlMs: 60 * 60_000, trustProxy: false, ...cfg },
    });
    await app.ready();
    return {
      app,
      core,
      attachmentStore,
      close: async () => {
        await app.close();
        db.close();
        rmSync(attachmentDir, { recursive: true, force: true });
      },
    };
  }
  ```

  Expose `attachmentStore` on `TestRig`.

  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run tests/http</automated>
  </verify>
  <done>Compiles; existing Phase 5 tests still green.</done>
  <commit>feat(http): wire message and attachment routes into server factory</commit>
</task>

<task type="auto">
  <name>Task 4: Tests — messages list + single</name>
  <files>tests/http/messages-routes.test.ts</files>
  <action>

  Create `tests/http/messages-routes.test.ts`:

  ```typescript
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { cookieNameFor } from '../../src/http/plugins/auth.js';
  import { buildTestRig, type TestRig } from './support.js';

  const seedMessage = (core: TestRig['core'], address: string, subject: string) => {
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
      const body = r.json() as { messages: Array<{ subject: string; hasHtmlBody: boolean; hasTextBody: boolean }> };
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
      const noCookie = await rig.app.inject({ method: 'GET', url: `/api/inbox/${inbox.inboxId}/messages` });
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
      const body = r.json() as { id: string; subject: string; textBody: string; htmlBody: string; attachments: unknown[] };
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

    it('404 when the message belongs to a different inbox (cross-inbox probe)', async () => {
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
      // Ingest with pre-sanitized HTML (Phase 4 is responsible for sanitization).
      const ingest = rig.core.ingestMessage({
        envelopeTo: inbox.address,
        envelopeFrom: null, sender: null, subject: 'raw',
        textBody: null, htmlBody: '<p>safe</p>',
        headers: null, attachments: [], sizeBytes: 1,
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
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/messages-routes.test.ts</automated>
  </verify>
  <done>All 7 tests pass.</done>
  <commit>test(http): cover message list and single-message routes</commit>
</task>

<task type="auto">
  <name>Task 5: Tests — attachment streaming</name>
  <files>tests/http/attachments-routes.test.ts</files>
  <action>

  Create `tests/http/attachments-routes.test.ts`:

  ```typescript
  import { Readable } from 'node:stream';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { formatContentDisposition } from '../../src/http/routes/attachments.js';
  import { cookieNameFor } from '../../src/http/plugins/auth.js';
  import { buildTestRig, type TestRig } from './support.js';

  const seedWithAttachment = async (rig: TestRig, address: string, filename: string | null, body: string) => {
    const w = await rig.attachmentStore.writeAttachment(Readable.from([Buffer.from(body)]));
    const r = rig.core.ingestMessage({
      envelopeTo: address,
      envelopeFrom: null, sender: null, subject: 'with-att',
      textBody: null, htmlBody: null, headers: null,
      attachments: [{ filename, contentType: 'application/octet-stream', size: w.sizeBytes, sha256: w.sha256, path: w.storagePath }],
      sizeBytes: w.sizeBytes,
    });
    if (!r.ok) throw new Error('ingest failed');
    const msg = rig.core.getMessage({ inboxId: (rig.core.getInbox(rig.core.listMessages({ inboxId: '', viewToken: '' }).ok ? '' : '') ? '' : '') || '', messageId: r.messageId, viewToken: '' });
    // Simpler: look up the attachment id via the core surface via listMessages.
    return { messageId: r.messageId, sha256: w.sha256, body };
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
  ```

  Note the seedWithAttachment helper has a vestigial messy block — simplified version below. Replace with this clean helper at the top:

  ```typescript
  const seedWithAttachment = async (rig: TestRig, address: string, filename: string | null, body: string) => {
    const w = await rig.attachmentStore.writeAttachment(Readable.from([Buffer.from(body)]));
    const r = rig.core.ingestMessage({
      envelopeTo: address,
      envelopeFrom: null, sender: null, subject: 'with-att',
      textBody: null, htmlBody: null, headers: null,
      attachments: [{ filename, contentType: 'application/octet-stream', size: w.sizeBytes, sha256: w.sha256, path: w.storagePath }],
      sizeBytes: w.sizeBytes,
    });
    if (!r.ok) throw new Error('ingest failed');
    return { messageId: r.messageId, sha256: w.sha256 };
  };
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/attachments-routes.test.ts</automated>
  </verify>
  <done>All 7 tests pass.</done>
  <commit>test(http): cover attachment streaming and filename encoding</commit>
</task>

## Verification

```bash
npm run typecheck && npm run check && npm test
```

## Success Criteria

- Messages list + single message + attachment all work.
- Cross-inbox probes return 404 (no enumeration leak).
- Filename encoding correct for ASCII, null, non-ASCII.
- All Phase 5 tests cumulative still green; prior 100 tests untouched.
