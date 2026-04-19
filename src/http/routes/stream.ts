/**
 * GET /api/inbox/:id/stream — SSE with replay-on-subscribe + heartbeat.
 *
 * Algorithm (D-16):
 *   1. Validate auth (401/403/404).
 *   2. Hijack reply, write SSE headers, flush.
 *   3. Parse Last-Event-ID. Query core.listMessages → filter receivedAt >
 *      lastEventId → for each, serialize + write.
 *   4. Attach core.bus.on('message', ...) filtered by inboxId. Each event:
 *      fetch full message via core.getMessage, write frame.
 *   5. Start 15s heartbeat interval. Skip heartbeat if a write is in flight
 *      (backpressure — D-17).
 *   6. On request.raw.on('close'): unsubscribe, clear interval.
 *
 * Rate limit: 10/min per IP per connection attempt (D-18).
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CoreApi } from '../../core/index.js';
import { sendError } from '../errors.js';
import { cookieNameFor } from '../plugins/auth.js';
import { inboxIdParam } from '../schemas.js';
import { formatEventId, parseLastEventId, serializeEvent, serializeHeartbeat } from '../sse.js';

export interface StreamRouteDeps {
  core: CoreApi;
  /** Heartbeat interval in ms (default 15_000). Overridable for tests. */
  heartbeatMs?: number;
  /** Clock for heartbeat timestamps. Overridable for tests. */
  now?: () => number;
}

export async function registerStreamRoute(
  app: FastifyInstance,
  deps: StreamRouteDeps,
): Promise<void> {
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const now = deps.now ?? Date.now;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/inbox/:id/stream',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { params: inboxIdParam },
    },
    async (req, reply) => {
      const inboxId = req.params.id;
      const auth = req.authorizeInbox(inboxId);
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
      const token = req.cookies[cookieNameFor(inboxId)] ?? '';

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      raw.flushHeaders?.();

      let writing = false;
      const write = (chunk: string): Promise<void> => {
        if (raw.writableEnded) return Promise.resolve();
        writing = true;
        return new Promise((resolve) => {
          const ok = raw.write(chunk);
          if (ok) {
            writing = false;
            resolve();
          } else {
            raw.once('drain', () => {
              writing = false;
              resolve();
            });
          }
        });
      };

      // 1. Replay.
      const lastEventId = parseLastEventId(req.headers['last-event-id']);
      const list = deps.core.listMessages({ inboxId, viewToken: token });
      if (list.ok) {
        for (const m of list.messages) {
          if (m.receivedAt <= lastEventId) continue;
          await write(
            serializeEvent({
              id: formatEventId(m.receivedAt, m.id),
              event: 'message',
              data: m,
            }),
          );
          if (raw.writableEnded) return reply;
        }
      }

      // 2. Live subscription.
      const unsubscribe = deps.core.bus.on('message', (payload) => {
        if (payload.inboxId !== inboxId) return;
        const full = deps.core.getMessage({
          inboxId,
          messageId: payload.messageId,
          viewToken: token,
        });
        if (!full.ok) return;
        void write(
          serializeEvent({
            id: formatEventId(payload.receivedAt, payload.messageId),
            event: 'message',
            data: full.message,
          }),
        ).catch(() => {
          /* socket closed */
        });
      });

      // 3. Heartbeat.
      const heartbeat = setInterval(() => {
        if (writing) return;
        if (raw.writableEnded) return;
        raw.write(serializeHeartbeat(now()));
      }, heartbeatMs);
      heartbeat.unref?.();

      // 4. Cleanup on close.
      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
        if (!raw.writableEnded) {
          try {
            raw.end();
          } catch {
            /* already closed */
          }
        }
      };
      req.raw.on('close', cleanup);
      req.raw.on('aborted', cleanup);
      return reply;
    },
  );
}
