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
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
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
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { params: inboxIdParam },
    },
    async (req, reply) => {
      const auth = req.authorizeInbox(req.params.id);
      if (!auth.ok) {
        const code =
          auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'not_found';
        const msg =
          auth.status === 401
            ? 'missing view-token'
            : auth.status === 403
              ? 'bad view-token'
              : 'inbox not found';
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
}
