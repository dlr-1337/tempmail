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
          auth.status === 401
            ? 'missing view-token'
            : auth.status === 403
              ? 'bad view-token'
              : 'inbox not found',
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
          auth.status === 401
            ? 'missing view-token'
            : auth.status === 403
              ? 'bad view-token'
              : 'inbox not found',
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
