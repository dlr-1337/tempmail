/**
 * Attachment download endpoint (API-08).
 *
 * Path shape chosen: `/api/inbox/:id/attachments/:attId` — keeps the
 * per-inbox cookie scope (`Path=/api/inbox/<id>`) valid, so the same auth
 * plugin works without any cookie-scope workarounds. A convenience alias at
 * `/api/attachments/:id` is DEFERRED to v2.
 *
 * Auth: view-token cookie required. The route walks attachmentId → message →
 * inbox via `core.getAttachmentForInbox` which enforces ownership atomically.
 *
 * Streaming: fetches a Readable from `attachmentStore.readAttachment(sha256)`
 * and pipes it through Fastify. No buffering in memory.
 *
 * Headers (API-08):
 *   - Content-Type: application/octet-stream
 *   - Content-Disposition: attachment; filename="..."
 *     (RFC 5987 filename* for non-ASCII)
 *   - X-Content-Type-Options: nosniff
 *   - Cache-Control: private, no-store
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
 * RFC 5987: emit non-ASCII filenames as `filename*=UTF-8''<percent-encoded>`
 * with a sanitized ASCII `filename=` for legacy clients. Always wraps the
 * plain filename in double-quotes — backslash/quote chars are replaced with
 * `_` so the header stays well-formed.
 */
export function formatContentDisposition(filename: string | null): string {
  if (!filename) return 'attachment';
  const asciiOnly = /^[\x20-\x7e]+$/.test(filename);
  if (asciiOnly) {
    const safe = filename.replace(/["\\]/g, '_');
    return `attachment; filename="${safe}"`;
  }
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
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
          auth.status === 401
            ? 'missing view-token'
            : auth.status === 403
              ? 'bad view-token'
              : 'inbox not found',
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
