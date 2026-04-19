/**
 * Phase 5 HTTP server factory (D-03, D-04).
 *
 * `createHttpServer({ core, attachmentStore, config, logger })` returns a
 * configured Fastify instance ready to `.listen()`. Production caller binds
 * to 127.0.0.1 — never a public interface — and Caddy (Phase 8)
 * reverse-proxies with TLS.
 *
 * Plugins registered in order:
 *   1. helmet (security headers)
 *   2. rate-limit (per-route opt-in, with abuse hook)
 *   3. auth (cookie + authorizeInbox decorator)
 *   4. sensible (httpErrors helpers)
 *   5. Route modules (inbox / messages / attachments / stream)
 */

import sensible from '@fastify/sensible';
import { type FastifyInstance, fastify } from 'fastify';
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type pino from 'pino';
import type { AttachmentStore } from '../attachments/index.js';
import type { CoreApi } from '../core/index.js';
import type { DiskState } from '../sweeper/index.js';
import { sendError } from './errors.js';
import { authPlugin } from './plugins/auth.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerStreamRoute } from './routes/stream.js';

export interface HttpAdminConfig {
  /** When true, POST /admin/blocklist is registered (loopback-only). */
  enabled: boolean;
  /** Salt for hashing inbox ids in log lines. Defaults to a random-at-boot salt. */
  logSalt?: string;
}

export interface HttpServerConfig {
  /** Signing secret for @fastify/cookie. View-tokens are NOT signed. */
  cookieSecret: string;
  /** Hard TTL in ms; used for Max-Age on the view-token cookie. */
  hardTtlMs: number;
  /** Trust X-Forwarded-* headers (behind Caddy). Default true. */
  trustProxy?: boolean;
  /** Phase 6 ABUSE-02: enable the loopback-only admin endpoint. */
  admin?: HttpAdminConfig;
}

export interface HttpServerDeps {
  core: CoreApi;
  attachmentStore: AttachmentStore;
  config: HttpServerConfig;
  logger?: pino.Logger;
  /**
   * Phase 6 RETN-04 hook. When present, GET /healthz reflects the current
   * disk state and POST /api/inbox returns 503 once `status === 'critical'`.
   */
  diskState?: () => DiskState;
}

export async function createHttpServer(deps: HttpServerDeps): Promise<FastifyInstance> {
  const app = fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.config.trustProxy ?? true,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await registerHelmet(app);
  await registerRateLimit(app, { core: deps.core });
  await app.register(authPlugin, { core: deps.core, cookieSecret: deps.config.cookieSecret });
  await app.register(sensible);

  // Phase 6 RETN-04 / D-16: healthz reflects disk state when provided but
  // NEVER 5xxs — circuit breaker reports, doesn't fail.
  app.get('/healthz', { config: { rateLimit: false } }, async () => {
    if (!deps.diskState) return { ok: true };
    const d = deps.diskState();
    const degraded = d.status !== 'normal';
    return {
      status: degraded ? 'degraded' : 'ok',
      disk: { percentUsed: d.percentUsed, status: d.status },
    };
  });

  await registerInboxRoutes(app, {
    core: deps.core,
    hardTtlMs: deps.config.hardTtlMs,
    diskState: deps.diskState,
  });
  await registerMessageRoutes(app, { core: deps.core });
  await registerAttachmentRoutes(app, { core: deps.core, attachmentStore: deps.attachmentStore });
  await registerStreamRoute(app, { core: deps.core });

  if (deps.config.admin?.enabled) {
    await registerAdminRoutes(app, {
      core: deps.core,
      logger: deps.logger,
      logSalt: deps.config.admin.logSalt ?? 'default-admin-salt',
    });
  }

  // Centralized error handler — unrecognized errors + zod validation failures
  // both land here. Validation errors carry `.validation` on the error object;
  // rate-limit throws an error whose shape was built by errorResponseBuilder.
  app.setErrorHandler((err, _req, reply) => {
    const e = err as {
      validation?: unknown;
      statusCode?: number;
      error?: { code?: string; message?: string };
    };
    if (e.validation) {
      return sendError(reply, 'invalid_request', 'invalid request');
    }
    if (e.statusCode === 429) {
      // @fastify/rate-limit's errorResponseBuilder returned `{error:{code,message}}`
      // as the thrown error object. Re-serialize that envelope verbatim so the
      // client sees the canonical shape (D-24 + D-20).
      const body = e.error?.code
        ? { error: { code: e.error.code, message: e.error.message ?? 'rate_limited' } }
        : { error: { code: 'rate_limited', message: 'too many requests' } };
      return reply.status(429).send(body);
    }
    deps.logger?.error({ err }, 'unhandled');
    return sendError(reply, 'server_error', 'internal error');
  });

  return app;
}
