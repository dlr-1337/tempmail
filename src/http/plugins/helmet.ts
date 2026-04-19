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
