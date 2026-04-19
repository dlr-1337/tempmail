---
phase: 5
plan: 2
status: ready
type: execute
wave: 2
depends_on: [05-01]
requirements: [API-01, API-02, API-09, API-10, API-11]
files_modified:
  - src/http/schemas.ts
  - src/http/errors.ts
  - src/http/plugins/auth.ts
  - src/http/plugins/helmet.ts
  - src/http/plugins/rate-limit.ts
  - src/http/server.ts
  - src/core/index.ts
  - src/core/messages.ts
  - src/core/inboxes.ts
  - tests/http/server.test.ts
  - tests/http/auth.test.ts
autonomous: true
tags: [bootstrap, auth, plugins, helmet, core-extension]
must_haves:
  truths:
    - "src/http/server.ts exports createHttpServer(deps) returning a FastifyInstance with zod type provider"
    - "src/http/plugins/auth.ts decorates request with authorizeInbox(inboxId) that reads the per-inbox cookie and routes to core"
    - "src/http/plugins/helmet.ts registers @fastify/helmet with the D-21 config (CSP off, frameguard deny, HSTS, no-referrer, same-origin COOP/CORP)"
    - "src/http/plugins/rate-limit.ts registers @fastify/rate-limit globally with in-memory store"
    - "src/http/errors.ts defines the { error: { code, message } } envelope + helper throwers"
    - "src/http/schemas.ts defines zod schemas for inboxIdParam, messageIdParam, attachmentIdParam, errorResponse"
    - "Core extended with getInbox(id) and getMessage(inboxId, msgId) passthroughs that respect D-03 (no DB/fs)"
    - "Baseline health route GET /healthz returns { ok: true } — exempt from rate-limit and auth"
    - "Helmet headers land on every response (including healthz)"
---

# Plan 05-02: Server bootstrap + auth plugin + helmet + Core extensions

## Goal

Stand up the empty Fastify app with security plugins and the cookie-based auth helper — no routes yet, except `/healthz`. Extend Core with two passthroughs Phase 5's routes will need.

## Must-have checklist

- [ ] `createHttpServer({ core, config, logger })` builds a `FastifyInstance`.
- [ ] Helmet + rate-limit registered globally.
- [ ] `@fastify/cookie` registered with `cookieSecret` from config (signed optional — we don't sign, cookie contains the token plaintext).
- [ ] `request.authorizeInbox(inboxId)` decorator returns `{ ok: true, row } | { ok: false, status: 401|403|404 }` by reading `tempmail_vt_<inboxId>` cookie, calling `core.getInbox(id)` to check existence, then `verifyViewToken`. Per D-07: missing cookie → 401, missing inbox → 404, wrong token → 403.
- [ ] `GET /healthz` returns `{ ok: true }`.
- [ ] 6 tests covering server boot, helmet headers, healthz, missing cookie → 401, wrong cookie → 403, missing inbox → 404.

## Tasks

<task type="auto">
  <name>Task 1: Extend Core with getInbox + getMessage passthroughs</name>
  <files>src/core/inboxes.ts, src/core/messages.ts, src/core/index.ts</files>
  <behavior>
    Phase 5's routes need three pieces of Core data the current api doesn't expose directly:

    1. `getInbox(inboxId)` — returns `{ ok: true, address, createdAt, lastActivityAt, expiresAt, messageCount } | { ok: false, reason: 'not_found' }` for `GET /api/inbox/:id` (API-02).
    2. `getMessage(inboxId, msgId, viewToken)` — returns the full message with bodies + attachment metadata (NOT sha256 / storage_path) for `GET /api/inbox/:id/messages/:msgId` (API-04). Enforces view-token internally with the same timing-safe compare as `listMessages`.
    3. `verifyInboxAccess(inboxId, viewToken)` — cheap existence + token check used by the auth plugin and the attachment route. Returns `{ ok: true } | { ok: false, status: 401|403|404 }` (status already mapped to HTTP vocabulary — saves the plugin translating twice).

    Approach: add these three as sibling methods on the composed `core` without changing `inboxes.ts` / `messages.ts` shape if we can. **Decision:** keep the D-03 boundary clean — put `getInbox` and `getMessage` into `inboxes.ts` and `messages.ts` respectively, expose via `createCore`.

    Also: add `getAttachmentForInbox({ inboxId, viewToken, attachmentId })` to `messages.ts` because attachment lookup must verify ownership through the inbox's view-token. Returns `{ ok: true, sha256, filename, contentType, size } | { ok: false, reason: 'not_found' | 'forbidden' }`. This is the only method that returns `sha256` to its caller — used internally by the attachment route which streams bytes; it never leaves the HTTP layer.

    All four methods are synchronous, call only `repos.*` and `verifyViewToken`. Zero DB / fs direct access — D-03 grep test stays green.

    For `recordAbuse({ipPrefix, bucket})`: separate Task 2, adds to `messages.ts` is wrong scope. Put it in a new file `src/core/abuse.ts` to keep modules cohesive.
  </behavior>
  <action>

  **A. Edit `src/core/inboxes.ts`** — add `getInbox(id)` to the api:

  Append a new method on the returned factory. New shape:

  ```typescript
  export interface InboxView {
    inboxId: string;
    address: string;
    createdAt: number;
    lastActivityAt: number;
    expiresAt: number;
    hardExpiresAt: number;
    messageCount: number;
  }

  export type GetInboxResult =
    | { ok: true; inbox: InboxView }
    | { ok: false; reason: 'not_found' };

  export interface InboxesApi {
    createInbox(): CreateInboxResult;
    expireInbox(input: { inboxId: string }): Promise<ExpireInboxResult>;
    verifyViewToken(row: InboxRow, viewToken: string): boolean;
    getInbox(inboxId: string): GetInboxResult;
    verifyInboxAccess(inboxId: string, viewToken: string): { ok: true; row: InboxRow } | { ok: false; reason: 'not_found' | 'forbidden' };
  }
  ```

  Implementation inside `createInboxes`:

  ```typescript
  const getInbox = (inboxId: string): GetInboxResult => {
    const row = deps.repos.inboxes.findInboxById(inboxId);
    if (!row) return { ok: false, reason: 'not_found' };
    const messageCount = deps.repos.messages.countMessagesByInbox(inboxId);
    return {
      ok: true,
      inbox: {
        inboxId: row.id,
        address: `${row.local_part}@${row.domain}`,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        expiresAt: row.expires_at,
        hardExpiresAt: row.hard_expires_at,
        messageCount,
      },
    };
  };

  const verifyInboxAccess = (inboxId: string, viewToken: string):
    | { ok: true; row: InboxRow }
    | { ok: false; reason: 'not_found' | 'forbidden' } => {
    const row = deps.repos.inboxes.findInboxById(inboxId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (!verifyViewToken(row, viewToken)) return { ok: false, reason: 'forbidden' };
    return { ok: true, row };
  };
  ```

  Return both from the factory.

  **B. Edit `src/core/messages.ts`** — add `getMessage` + `getAttachmentForInbox`:

  ```typescript
  export interface FullMessageView {
    id: string;
    receivedAt: number;
    sender: string | null;
    subject: string | null;
    textBody: string | null;
    htmlBody: string | null;
    sizeBytes: number;
    attachments: readonly AttachmentView[];
  }

  export type GetMessageResult =
    | { ok: true; message: FullMessageView }
    | { ok: false; reason: 'not_found' | 'forbidden' };

  export interface AttachmentDescriptor {
    id: string;
    sha256: string;
    filename: string | null;
    contentType: string | null;
    size: number;
  }

  export type GetAttachmentResult =
    | { ok: true; attachment: AttachmentDescriptor }
    | { ok: false; reason: 'not_found' | 'forbidden' };
  ```

  Add to `MessagesApi`:

  ```typescript
  getMessage(input: { inboxId: string; messageId: string; viewToken: string }): GetMessageResult;
  getAttachmentForInbox(input: { inboxId: string; attachmentId: string; viewToken: string }): GetAttachmentResult;
  ```

  Implementation inside `createMessages`:

  ```typescript
  const getMessage = ({ inboxId, messageId, viewToken }: { inboxId: string; messageId: string; viewToken: string }): GetMessageResult => {
    const inboxRow = deps.repos.inboxes.findInboxById(inboxId);
    if (!inboxRow) return { ok: false, reason: 'not_found' };
    if (!verifyViewToken(inboxRow, viewToken)) return { ok: false, reason: 'forbidden' };
    const msg = deps.repos.messages.findMessageById(messageId);
    if (!msg || msg.inbox_id !== inboxId) return { ok: false, reason: 'not_found' };
    const attachments = deps.repos.attachments.listAttachmentsByMessage(msg.id).map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      size: a.size_bytes,
    }));
    return {
      ok: true,
      message: {
        id: msg.id,
        receivedAt: msg.received_at,
        sender: msg.sender,
        subject: msg.subject,
        textBody: msg.text_body,
        htmlBody: msg.html_body_sanitized,
        sizeBytes: msg.size_bytes,
        attachments,
      },
    };
  };

  const getAttachmentForInbox = ({ inboxId, attachmentId, viewToken }: { inboxId: string; attachmentId: string; viewToken: string }): GetAttachmentResult => {
    const inboxRow = deps.repos.inboxes.findInboxById(inboxId);
    if (!inboxRow) return { ok: false, reason: 'not_found' };
    if (!verifyViewToken(inboxRow, viewToken)) return { ok: false, reason: 'forbidden' };
    const att = deps.repos.attachments.findAttachmentById(attachmentId);
    if (!att) return { ok: false, reason: 'not_found' };
    const msg = deps.repos.messages.findMessageById(att.message_id);
    if (!msg || msg.inbox_id !== inboxId) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      attachment: {
        id: att.id,
        sha256: att.sha256,
        filename: att.filename,
        contentType: att.content_type,
        size: att.size_bytes,
      },
    };
  };
  ```

  **C. Edit `src/core/index.ts`** — surface the new methods via `createCore`:

  ```typescript
  export interface CoreApi {
    readonly bus: Bus;
    createInbox: InboxesApi['createInbox'];
    expireInbox: InboxesApi['expireInbox'];
    getInbox: InboxesApi['getInbox'];
    verifyInboxAccess: InboxesApi['verifyInboxAccess'];
    ingestMessage: MessagesApi['ingestMessage'];
    listMessages: MessagesApi['listMessages'];
    getMessage: MessagesApi['getMessage'];
    getAttachmentForInbox: MessagesApi['getAttachmentForInbox'];
  }
  ```

  Wire them in the returned object. Export the new types from `index.ts`: `InboxView`, `GetInboxResult`, `FullMessageView`, `GetMessageResult`, `AttachmentDescriptor`, `GetAttachmentResult`.

  Also add to `src/core/types.ts` the same new type exports.

  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npm test</automated>
  </verify>
  <done>Core extensions compile; D-03 grep invariant still green; existing 100 tests still pass.</done>
  <commit>feat(core): add getInbox, getMessage, getAttachmentForInbox, verifyInboxAccess passthroughs</commit>
</task>

<task type="auto">
  <name>Task 2: Add core.recordAbuse passthrough</name>
  <files>src/core/abuse.ts, src/core/index.ts, src/core/types.ts</files>
  <behavior>
    `recordAbuse({ ipPrefix, bucket })` increments the abuse counter for the current 60s window. Called by the rate-limit plugin when a 429 fires (D-20).

    - ipPrefix: `/24` for IPv4 (first 3 octets), `/64` for IPv6 (first 4 hextets). Canonicalized by the HTTP layer before calling; core doesn't parse.
    - bucket: short string ('mint', 'read', 'stream', 'attach').

    Window: 60s floored. Exported helper `currentAbuseWindow(now = nowMs)` lives in this module so tests can drive it.
  </behavior>
  <action>

  Create `src/core/abuse.ts`:

  ```typescript
  /**
   * Phase 5 hook: record 429 / rate-limit trips into abuse_counters via the
   * existing Phase 2 repo. Scoped by (ipPrefix, bucket, window_start), where
   * window_start is a 60s-floored timestamp.
   *
   * No direct DB / fs access — all persistence flows through deps.repos.abuse
   * (D-03). The HTTP layer builds ipPrefix + bucket and calls core.recordAbuse.
   */

  import type { Repos } from '../db/repos/index.js';
  import { nowMs } from '../util/now.js';

  /** 60s window floor — single source of truth for abuse bucketing. */
  export const ABUSE_WINDOW_MS = 60_000;

  export const currentAbuseWindow = (now: number = nowMs()): number =>
    Math.floor(now / ABUSE_WINDOW_MS) * ABUSE_WINDOW_MS;

  export interface RecordAbuseInput {
    ipPrefix: string;
    bucket: string;
  }

  export interface AbuseApi {
    recordAbuse(input: RecordAbuseInput): number;
  }

  export interface AbuseDeps {
    repos: Repos;
    now?: () => number;
  }

  export function createAbuse(deps: AbuseDeps): AbuseApi {
    const now = deps.now ?? nowMs;
    return {
      recordAbuse({ ipPrefix, bucket }) {
        return deps.repos.abuse.incrementCounter(ipPrefix, bucket, currentAbuseWindow(now()));
      },
    };
  }
  ```

  Edit `src/core/index.ts` to compose it:

  ```typescript
  import { type AbuseApi, createAbuse } from './abuse.js';
  // inside createCore:
  const abuse = createAbuse({ repos: deps.repos, now: deps.now });
  // inside the returned object:
  recordAbuse: abuse.recordAbuse,
  ```

  And `CoreApi`:

  ```typescript
  recordAbuse: AbuseApi['recordAbuse'];
  ```

  Export `AbuseApi`, `RecordAbuseInput`, `ABUSE_WINDOW_MS`, `currentAbuseWindow` from `index.ts`. Mirror in `types.ts`.

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles clean. D-03 still green.</done>
  <commit>feat(core): add recordAbuse passthrough for rate-limit trips</commit>
</task>

<task type="auto">
  <name>Task 3: Error envelope + zod schemas</name>
  <files>src/http/errors.ts, src/http/schemas.ts</files>
  <action>

  Create `src/http/errors.ts`:

  ```typescript
  /**
   * Phase 5 error envelope (D-24).
   *
   * Shape: `{ error: { code: string, message: string } }`. Stable codes listed
   * in HTTP_ERROR_CODES. Helper throwers produce Fastify-sensible HttpError
   * instances whose JSON serialization matches the envelope.
   */

  import type { FastifyReply } from 'fastify';

  export const HTTP_ERROR_CODES = {
    unauthorized: 'unauthorized',
    forbidden: 'forbidden',
    not_found: 'not_found',
    rate_limited: 'rate_limited',
    invalid_request: 'invalid_request',
    server_error: 'server_error',
  } as const;

  export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[keyof typeof HTTP_ERROR_CODES];

  export interface ErrorBody {
    error: { code: HttpErrorCode; message: string };
  }

  const CODE_TO_STATUS: Record<HttpErrorCode, number> = {
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    rate_limited: 429,
    invalid_request: 400,
    server_error: 500,
  };

  export function sendError(reply: FastifyReply, code: HttpErrorCode, message: string): FastifyReply {
    return reply.status(CODE_TO_STATUS[code]).send({ error: { code, message } } satisfies ErrorBody);
  }
  ```

  Create `src/http/schemas.ts`:

  ```typescript
  /**
   * Phase 5 zod schemas for param/body/response validation (D-22, D-23).
   *
   * The nanoid alphabet is URL-safe base64 (21 chars but we use 22 for entropy
   * headroom). Inbox ids, message ids, and attachment ids all share the shape
   * because all three are minted via `newId()` from `src/util/id.ts`.
   */

  import { z } from 'zod';

  /** nanoid v5 default alphabet: 0-9A-Za-z_- (64 chars). 22-char length. */
  export const ID_REGEX = /^[0-9A-Za-z_-]{22}$/;

  export const idSchema = z.string().regex(ID_REGEX, 'invalid_id');

  export const inboxIdParam = z.object({ id: idSchema });
  export const messageIdParam = z.object({ id: idSchema, msgId: idSchema });
  export const attachmentIdParam = z.object({ id: idSchema });

  export const errorResponseSchema = z.object({
    error: z.object({
      code: z.enum(['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'invalid_request', 'server_error']),
      message: z.string(),
    }),
  });
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Files compile. No runtime changes yet.</done>
  <commit>feat(http): add error envelope and zod schemas</commit>
</task>

<task type="auto">
  <name>Task 4: Helmet plugin</name>
  <files>src/http/plugins/helmet.ts</files>
  <action>

  Create `src/http/plugins/helmet.ts`:

  ```typescript
  /**
   * @fastify/helmet registration — D-21.
   *
   * - contentSecurityPolicy: false (API serves JSON + SSE + octet-stream; the
   *   static frontend in Phase 7 gets its own CSP via Caddy)
   * - frameguard: deny (no embedding)
   * - hsts: one year, includeSubDomains (respected at the Caddy edge)
   * - noSniff: true
   * - referrerPolicy: no-referrer
   * - crossOriginOpenerPolicy: same-origin
   * - crossOriginResourcePolicy: same-origin
   */

  import helmet from '@fastify/helmet';
  import type { FastifyInstance } from 'fastify';

  export async function registerHelmet(app: FastifyInstance): Promise<void> {
    await app.register(helmet, {
      contentSecurityPolicy: false,
      frameguard: { action: 'deny' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      noSniff: true,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    });
  }
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): register helmet security headers plugin</commit>
</task>

<task type="auto">
  <name>Task 5: Rate-limit plugin</name>
  <files>src/http/plugins/rate-limit.ts</files>
  <action>

  Create `src/http/plugins/rate-limit.ts`:

  ```typescript
  /**
   * @fastify/rate-limit registration — D-18, D-19.
   *
   * Keyed by request.ip (Fastify respects trustProxy to pull it from
   * X-Forwarded-For behind Caddy). Per-route overrides live on each route's
   * config; this plugin just sets the sane defaults.
   */

  import rateLimit from '@fastify/rate-limit';
  import type { FastifyInstance } from 'fastify';

  export async function registerRateLimit(app: FastifyInstance): Promise<void> {
    await app.register(rateLimit, {
      global: false, // per-route opt-in via config.rateLimit
      max: 120,
      timeWindow: '1 minute',
    });
  }
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): register rate-limit plugin</commit>
</task>

<task type="auto">
  <name>Task 6: Auth plugin (cookie-per-inbox view-token guard)</name>
  <files>src/http/plugins/auth.ts</files>
  <action>

  Create `src/http/plugins/auth.ts`:

  ```typescript
  /**
   * Cookie-per-inbox view-token auth plugin (D-05, D-06, D-07).
   *
   * Cookie name: `tempmail_vt_<inboxId>`. HttpOnly, Secure (auto), SameSite=Lax.
   * Path is scoped to `/api/inbox/<inboxId>` so the browser only sends the
   * token when talking about that inbox (per-tab isolation for free).
   *
   * The plugin decorates requests with `authorizeInbox(inboxId)`, returning:
   *   - `{ ok: true, row }` on success
   *   - `{ ok: false, status: 401 }` if cookie missing
   *   - `{ ok: false, status: 403 }` if cookie present but token wrong
   *   - `{ ok: false, status: 404 }` if inbox does not exist
   *
   * Route handlers call this and map the result to the error envelope.
   */

  import cookie from '@fastify/cookie';
  import type { FastifyInstance, FastifyRequest } from 'fastify';
  import fp from 'fastify-plugin';
  import type { CoreApi } from '../../core/index.js';

  export type AuthorizeResult =
    | { ok: true }
    | { ok: false; status: 401 | 403 | 404 };

  export const cookieNameFor = (inboxId: string): string => `tempmail_vt_${inboxId}`;

  declare module 'fastify' {
    interface FastifyRequest {
      authorizeInbox(inboxId: string): AuthorizeResult;
    }
  }

  export interface AuthPluginOptions {
    core: CoreApi;
    cookieSecret: string;
  }

  export const authPlugin = fp(async (app: FastifyInstance, opts: AuthPluginOptions) => {
    await app.register(cookie, {
      secret: opts.cookieSecret,
      parseOptions: {},
    });

    app.decorateRequest('authorizeInbox', function (this: FastifyRequest, inboxId: string): AuthorizeResult {
      const name = cookieNameFor(inboxId);
      const raw = this.cookies[name];
      if (!raw) return { ok: false, status: 401 };
      const result = opts.core.verifyInboxAccess(inboxId, raw);
      if (result.ok) return { ok: true };
      if (result.reason === 'not_found') return { ok: false, status: 404 };
      return { ok: false, status: 403 };
    });
  }, { name: 'tempmail-auth' });

  /**
   * Cookie options for setting the view-token cookie on POST /api/inbox.
   * Extracted so the mint route and tests use exactly the same options.
   */
  export function viewTokenCookieOptions(inboxId: string, hardTtlMs: number): {
    httpOnly: true;
    secure: 'auto';
    sameSite: 'lax';
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
      path: `/api/inbox/${inboxId}`,
      maxAge: Math.floor(hardTtlMs / 1000),
    };
  }
  ```

  Note: `secure: 'auto'` lets @fastify/cookie set Secure only behind x-forwarded-proto=https (Caddy's default). Tests running over plain HTTP still work.

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles. No tests yet.</done>
  <commit>feat(http): add cookie-per-inbox auth plugin</commit>
</task>

<task type="auto">
  <name>Task 7: Server factory</name>
  <files>src/http/server.ts</files>
  <action>

  Create `src/http/server.ts`:

  ```typescript
  /**
   * Phase 5 HTTP server factory (D-03, D-04).
   *
   * `createHttpServer({ core, config, logger })` returns a configured Fastify
   * instance ready to `.listen()`. Production caller binds to 127.0.0.1 — never
   * a public interface — and Caddy (Phase 8) reverse-proxies with TLS.
   *
   * Plugins registered in order:
   *   1. helmet (security headers)
   *   2. rate-limit (per-route opt-in)
   *   3. auth (cookie + authorizeInbox decorator)
   *   4. sensible (httpErrors helpers)
   *   5. (routes — registered by Plans 05-03, 05-04, 05-05)
   */

  import sensible from '@fastify/sensible';
  import { type FastifyInstance, fastify } from 'fastify';
  import {
    type ZodTypeProvider,
    serializerCompiler,
    validatorCompiler,
  } from 'fastify-type-provider-zod';
  import type pino from 'pino';
  import type { CoreApi } from '../core/index.js';
  import { authPlugin } from './plugins/auth.js';
  import { registerHelmet } from './plugins/helmet.js';
  import { registerRateLimit } from './plugins/rate-limit.js';

  export interface HttpServerConfig {
    /** Signing secret for @fastify/cookie. View-tokens are NOT signed (cookie carries plaintext), but the secret is required. */
    cookieSecret: string;
    /** Hard TTL in ms; used for Max-Age on the view-token cookie. */
    hardTtlMs: number;
    /** If behind a reverse proxy (Caddy), trust X-Forwarded-*. Default true. */
    trustProxy?: boolean;
  }

  export interface HttpServerDeps {
    core: CoreApi;
    config: HttpServerConfig;
    logger?: pino.Logger;
  }

  export async function createHttpServer(deps: HttpServerDeps): Promise<FastifyInstance> {
    const app = fastify({
      logger: deps.logger ?? false,
      trustProxy: deps.config.trustProxy ?? true,
      bodyLimit: 1024 * 1024, // 1 MB — POST /api/inbox has no body anyway
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await registerHelmet(app);
    await registerRateLimit(app);
    await app.register(authPlugin, { core: deps.core, cookieSecret: deps.config.cookieSecret });
    await app.register(sensible);

    app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

    // Routes registered by subsequent plans live here — see server-routes.ts in
    // plan 05-03. We keep the factory dumb and let the routes plugin decide
    // which paths exist.

    return app;
  }
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): add createHttpServer factory with plugin stack</commit>
</task>

<task type="auto">
  <name>Task 8: Tests — server boot, helmet, healthz, auth unit</name>
  <files>tests/http/server.test.ts, tests/http/auth.test.ts, tests/http/support.ts</files>
  <action>

  Create `tests/http/support.ts` — shared test harness:

  ```typescript
  import { type CoreApi, createCore } from '../../src/core/index.js';
  import { createAttachmentStore } from '../../src/attachments/index.js';
  import { type HttpServerConfig, createHttpServer } from '../../src/http/server.js';
  import { openTestDbWithRepos } from '../support/db-helper.js';
  import type { FastifyInstance } from 'fastify';

  export interface TestRig {
    app: FastifyInstance;
    core: CoreApi;
    close: () => Promise<void>;
  }

  export async function buildTestRig(cfg?: Partial<HttpServerConfig>, attachmentDir = ''): Promise<TestRig> {
    const { db, repos } = openTestDbWithRepos();
    const attachmentStore = createAttachmentStore(attachmentDir || '/tmp-unused');
    const core = createCore({
      db,
      repos,
      attachmentStore,
      config: {
        domain: 'example.test',
        idleTtlMs: 10 * 60_000,
        hardTtlMs: 60 * 60_000,
      },
    });
    const app = await createHttpServer({
      core,
      config: {
        cookieSecret: 'test-cookie-secret',
        hardTtlMs: 60 * 60_000,
        trustProxy: false,
        ...cfg,
      },
    });
    await app.ready();
    return {
      app,
      core,
      close: async () => {
        await app.close();
        db.close();
      },
    };
  }
  ```

  Create `tests/http/server.test.ts`:

  ```typescript
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { buildTestRig, type TestRig } from './support.js';

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
      expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    it('404 on unknown route', async () => {
      const r = await rig.app.inject({ method: 'GET', url: '/nope' });
      expect(r.statusCode).toBe(404);
    });
  });
  ```

  Create `tests/http/auth.test.ts`:

  ```typescript
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { cookieNameFor } from '../../src/http/plugins/auth.js';
  import { buildTestRig, type TestRig } from './support.js';

  describe('authorizeInbox decorator', () => {
    let rig: TestRig;
    beforeEach(async () => {
      rig = await buildTestRig();
      // Register a test-only route that exposes the decorator's result.
      rig.app.get<{ Params: { id: string } }>(
        '/_test/auth/:id',
        { config: { rateLimit: false } },
        async (req, reply) => {
          const r = req.authorizeInbox(req.params.id);
          if (r.ok) return { ok: true };
          return reply.status(r.status).send({ ok: false, status: r.status });
        },
      );
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
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/server.test.ts tests/http/auth.test.ts</automated>
  </verify>
  <done>All 7 tests pass.</done>
  <commit>test(http): cover server bootstrap, helmet headers, and auth decorator</commit>
</task>

## Verification

```bash
npm run typecheck
npm run check
npm test
```

## Success Criteria

- Core extended with 5 new methods: `getInbox`, `verifyInboxAccess`, `getMessage`, `getAttachmentForInbox`, `recordAbuse`.
- `createHttpServer(deps)` boots with helmet + rate-limit + auth + sensible.
- `GET /healthz` returns `{ ok: true }` and carries all helmet headers.
- Auth decorator returns the correct status for missing / wrong / right / unknown.
- D-03 grep invariant still green.
- All 7 existing Phase 5 tests + 100 prior tests pass.
