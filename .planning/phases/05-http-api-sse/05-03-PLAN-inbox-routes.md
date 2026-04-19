---
phase: 5
plan: 3
status: ready
type: execute
wave: 3
depends_on: [05-02]
requirements: [API-01, API-02, API-09, API-10]
files_modified:
  - src/http/routes/inbox.ts
  - src/http/server.ts
  - tests/http/inbox-routes.test.ts
autonomous: true
tags: [routes, mint, inbox-metadata]
must_haves:
  truths:
    - "POST /api/inbox mints an inbox, sets the HttpOnly cookie, and returns { address, expiresAt }"
    - "GET /api/inbox/:id returns { address, createdAt, lastActivityAt, expiresAt, messageCount }"
    - "Cookie cannot be read from JS (HttpOnly), is scoped to the inbox path, and has SameSite=Lax"
    - "Rate-limit: 5/min for mint, 60/min for metadata"
    - "Malformed inbox id → 400 (zod guard before core)"
---

# Plan 05-03: Inbox routes (mint + metadata)

## Goal

Ship the first two REST endpoints: `POST /api/inbox` and `GET /api/inbox/:id`. Wire rate-limit overrides per D-18.

## Must-have checklist

- [ ] `POST /api/inbox` → 201 + cookie + body `{ address, expiresAt }`
- [ ] `GET /api/inbox/:id` → 200 with inbox metadata (requires cookie) or the proper error status
- [ ] Rate-limit: 5/min mint, 60/min metadata
- [ ] Zod validation on `:id` — 400 on malformed id (before touching Core)
- [ ] Tests: mint path, cookie attributes, metadata happy path, missing cookie → 401, wrong cookie → 403, unknown id → 404, malformed id → 400

## Tasks

<task type="auto">
  <name>Task 1: Inbox routes module</name>
  <files>src/http/routes/inbox.ts</files>
  <action>

  Create `src/http/routes/inbox.ts`:

  ```typescript
  /**
   * Inbox REST endpoints (API-01, API-02).
   *
   * POST /api/inbox      — mint a new inbox; cookie set per-inbox
   * GET  /api/inbox/:id  — return metadata for an existing inbox
   *
   * Rate limits (D-18): mint 5/min per IP, metadata 60/min per IP.
   */

  import type { FastifyInstance } from 'fastify';
  import type { ZodTypeProvider } from 'fastify-type-provider-zod';
  import { z } from 'zod';
  import type { CoreApi } from '../../core/index.js';
  import { sendError } from '../errors.js';
  import { cookieNameFor, viewTokenCookieOptions } from '../plugins/auth.js';
  import { inboxIdParam } from '../schemas.js';

  export interface InboxRoutesDeps {
    core: CoreApi;
    hardTtlMs: number;
  }

  export async function registerInboxRoutes(
    app: FastifyInstance,
    deps: InboxRoutesDeps,
  ): Promise<void> {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // POST /api/inbox — mint a new inbox (API-01, API-09, API-10).
    typed.post(
      '/api/inbox',
      {
        config: {
          rateLimit: { max: 5, timeWindow: '1 minute' },
        },
        schema: {
          response: {
            201: z.object({ address: z.string(), expiresAt: z.number() }),
          },
        },
      },
      async (_req, reply) => {
        const result = deps.core.createInbox();
        reply.setCookie(
          cookieNameFor(result.inboxId),
          result.viewToken,
          viewTokenCookieOptions(result.inboxId, deps.hardTtlMs),
        );
        return reply.status(201).send({ address: result.address, expiresAt: result.expiresAt });
      },
    );

    // GET /api/inbox/:id — metadata (API-02).
    typed.get(
      '/api/inbox/:id',
      {
        config: {
          rateLimit: { max: 60, timeWindow: '1 minute' },
        },
        schema: { params: inboxIdParam },
      },
      async (req, reply) => {
        const auth = req.authorizeInbox(req.params.id);
        if (!auth.ok) {
          const code = auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'not_found';
          const msg = auth.status === 401 ? 'missing view-token' : auth.status === 403 ? 'bad view-token' : 'inbox not found';
          return sendError(reply, code, msg);
        }
        const r = deps.core.getInbox(req.params.id);
        if (!r.ok) return sendError(reply, 'not_found', 'inbox not found');
        const { inbox } = r;
        return reply.status(200).send({
          address: inbox.address,
          createdAt: inbox.createdAt,
          lastActivityAt: inbox.lastActivityAt,
          expiresAt: inbox.expiresAt,
          messageCount: inbox.messageCount,
        });
      },
    );

    // Zod param validation errors — wrap to our envelope.
    app.setErrorHandler((err, _req, reply) => {
      if ((err as { validation?: unknown }).validation) {
        return sendError(reply, 'invalid_request', 'invalid request');
      }
      reply.log?.error({ err }, 'unhandled');
      return sendError(reply, 'server_error', 'internal error');
    });
  }
  ```

  **Note**: the error handler is set at the inbox-routes layer for v1; all subsequent route plans reuse it because `setErrorHandler` is instance-scoped and `app` is shared. If plan 05-04 or 05-05 adds another, the last one wins — we centralize it here so that's deterministic.

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Module compiles clean.</done>
  <commit>feat(http): add inbox mint and metadata routes</commit>
</task>

<task type="auto">
  <name>Task 2: Wire routes into server factory</name>
  <files>src/http/server.ts</files>
  <action>

  Edit `src/http/server.ts`. Add inbox route registration after `sensible` and before the healthz route:

  ```typescript
  import { registerInboxRoutes } from './routes/inbox.js';
  // ...inside createHttpServer, after sensible:
  await registerInboxRoutes(app, { core: deps.core, hardTtlMs: deps.config.hardTtlMs });
  ```

  Keep the healthz route where it is.

  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run tests/http/server.test.ts tests/http/auth.test.ts</automated>
  </verify>
  <done>Compiles; prior tests still green.</done>
  <commit>feat(http): register inbox routes in server factory</commit>
</task>

<task type="auto">
  <name>Task 3: Tests — inbox mint + metadata</name>
  <files>tests/http/inbox-routes.test.ts</files>
  <action>

  Create `tests/http/inbox-routes.test.ts`:

  ```typescript
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { cookieNameFor } from '../../src/http/plugins/auth.js';
  import { buildTestRig, type TestRig } from './support.js';

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

      // Cookie header should contain HttpOnly, SameSite=Lax, and a path scoped to the inbox.
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
      const r = await rig.app.inject({ method: 'GET', url: '/api/inbox/not-a-valid-id-$$' });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: { code: string } }).error.code).toBe('invalid_request');
    });
  });
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/inbox-routes.test.ts</automated>
  </verify>
  <done>All 7 tests pass.</done>
  <commit>test(http): cover inbox mint and metadata routes</commit>
</task>

## Verification

```bash
npm run typecheck && npm run check && npm test
```

## Success Criteria

- Mint sets HttpOnly + SameSite=Lax + scoped Path cookie; body has no viewToken.
- Metadata works with cookie, 401 without, 403 wrong, 404 unknown, 400 malformed.
- Existing tests still green.
