/**
 * @fastify/rate-limit registration — D-18, D-19, D-20.
 *
 * - Keyed by request.ip (trustProxy on behind Caddy picks X-Forwarded-For)
 * - `global: false` — per-route opt-in via `config.rateLimit` on each handler
 * - errorResponseBuilder returns the canonical `{error:{code,message}}` envelope
 * - onExceeded → core.recordAbuse({ipPrefix, bucket}) persists the trip into
 *   the `abuse_counters` table for Phase 6's downstream ban logic
 *
 * Bucket is derived from the URL path prefix. ipPrefix collapses v4 to /24 and
 * v6 to /64 — aggregated enough for abuse accounting without storing full IPs.
 */

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { CoreApi } from '../../core/index.js';

export interface RateLimitDeps {
  core: CoreApi;
}

/** Maps METHOD + URL-path to a short abuse bucket tag. */
export function bucketForPath(method: string, path: string): string {
  if (method === 'POST' && path === '/api/inbox') return 'mint';
  if (/\/stream$/.test(path)) return 'stream';
  if (/\/attachments\//.test(path)) return 'attach';
  if (/\/messages(\/|$)/.test(path)) return 'read';
  if (/^\/api\/inbox\/[^/]+$/.test(path)) return 'meta';
  return 'other';
}

/**
 * IP prefix aggregator. Collapses IPv4 to /24 and IPv6 to /64. Accepts raw
 * string (what Fastify gives us on request.ip); never throws.
 */
export function ipToPrefix(ip: string): string {
  if (!ip) return '0.0.0.0/24';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    const head = parts.slice(0, 4).join(':');
    return `${head}/64`;
  }
  const octets = ip.split('.');
  if (octets.length < 3) return `${ip}/24`;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

export async function registerRateLimit(app: FastifyInstance, deps: RateLimitDeps): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
      error: {
        code: 'rate_limited',
        message: `too many requests (retry after ${context.after})`,
      },
    }),
    onExceeded: (req) => {
      const path = (req.url ?? '').split('?')[0] ?? req.url ?? '';
      const bucket = bucketForPath(req.method ?? 'GET', path);
      const ipPrefix = ipToPrefix(req.ip ?? '');
      deps.core.recordAbuse({ ipPrefix, bucket });
    },
  });
}
