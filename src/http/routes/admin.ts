/**
 * Phase 6 admin endpoint — `POST /admin/blocklist` (ABUSE-02).
 *
 * Bind-based trust (D-17, D-20): only loopback IPs may call this route. No
 * auth token — the security model is "accessible only via `ssh user@host &&
 * curl http://127.0.0.1:<port>/admin/blocklist`". Exposing the port publicly
 * would be catastrophic; operators are responsible for binding Fastify to
 * `127.0.0.1` in prod (Caddy never proxies `/admin/*`).
 *
 * Action: hard-expire the named inbox via `core.expireInbox`. D-19 defers a
 * dedicated `blocklisted_until` column to v2; expiring achieves the
 * operator's goal today.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { CoreApi } from '../../core/index.js';
import { sendError } from '../errors.js';

export interface AdminLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface AdminRoutesDeps {
  core: CoreApi;
  logger?: AdminLogger;
  /** Salt for hashing inbox ids in log output (never log raw ids / addresses). */
  logSalt: string;
}

/** True for IPv4 loopback, IPv6 loopback, and IPv4-mapped IPv6 loopback. */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1') return true;
  if (ip === '::1') return true;
  if (ip === '::ffff:127.0.0.1') return true;
  // Any 127.0.0.0/8 — defensive (some libs report 127.0.0.2 for test harnesses).
  if (ip.startsWith('127.')) return true;
  return false;
}

function hashInboxId(inboxId: string, salt: string): string {
  return createHash('sha256').update(inboxId).update(salt).digest('hex').slice(0, 16);
}

const adminBlocklistBody = z
  .object({
    address: z.string().min(3).optional(),
    inboxId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.address) || Boolean(v.inboxId), {
    message: 'one of `address` or `inboxId` is required',
  });

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/admin/blocklist',
    {
      // Admin is trusted — never rate-limited.
      config: { rateLimit: false },
      schema: {
        body: adminBlocklistBody,
      },
      preHandler: async (req, reply) => {
        if (!isLoopbackIp(req.ip)) {
          // 403 is correct: request is syntactically well-formed but the
          // caller is not allowed to use this route from this network
          // position. D-20: never leak anything beyond `forbidden`.
          deps.logger?.warn(
            { event: 'admin.blocklist.denied', by_ip: req.ip ?? 'unknown' },
            'admin.blocklist.denied',
          );
          return sendError(reply, 'forbidden', 'admin endpoint restricted to loopback');
        }
      },
    },
    async (req, reply) => {
      const body = req.body;

      // Resolve address → inboxId if needed.
      let inboxId: string | null = null;
      if (body.inboxId) {
        inboxId = body.inboxId;
      } else if (body.address) {
        const at = body.address.indexOf('@');
        if (at <= 0 || at !== body.address.lastIndexOf('@')) {
          return sendError(reply, 'invalid_request', 'malformed address');
        }
        const localPart = body.address.slice(0, at);
        const domain = body.address.slice(at + 1).toLowerCase();
        const found = deps.core.findInboxByAddress(localPart, domain);
        if (!found) {
          return sendError(reply, 'not_found', 'inbox not found');
        }
        inboxId = found.id;
      }

      if (!inboxId) {
        return sendError(reply, 'invalid_request', 'one of address/inboxId required');
      }

      const result = await deps.core.expireInbox({ inboxId });
      if (!result.ok) {
        return sendError(reply, 'not_found', 'inbox not found');
      }

      // D-21: log whitelisted fields only. Raw id/address NEVER appears.
      deps.logger?.info(
        {
          event: 'blocklist_applied',
          reason: 'manual',
          by_ip: req.ip ?? 'unknown',
          inbox_id_hash_first8: hashInboxId(inboxId, deps.logSalt),
          deleted_messages: result.deletedMessages,
          unlinked_attachments: result.unlinkedAttachments,
        },
        'blocklist_applied',
      );

      return reply.status(204).send();
    },
  );
}
