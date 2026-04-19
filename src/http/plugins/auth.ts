/**
 * Cookie-per-inbox view-token auth plugin (D-05, D-06, D-07).
 *
 * Cookie name: `tempmail_vt_<inboxId>`. HttpOnly, Secure (auto), SameSite=Lax.
 * Path is scoped to `/api/inbox/<inboxId>` so the browser only sends the
 * token when talking about that inbox (per-tab isolation for free).
 *
 * The plugin decorates requests with `authorizeInbox(inboxId)`, returning:
 *   - `{ ok: true }` on success
 *   - `{ ok: false, status: 401 }` if cookie missing
 *   - `{ ok: false, status: 403 }` if cookie present but token wrong
 *   - `{ ok: false, status: 404 }` if inbox does not exist
 *
 * Route handlers call this and map the result to the error envelope.
 */

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { CoreApi } from '../../core/index.js';

export type AuthorizeResult = { ok: true } | { ok: false; status: 401 | 403 | 404 };

export const cookieNameFor = (inboxId: string): string => `tempmail_vt_${inboxId}`;

declare module 'fastify' {
  interface FastifyRequest {
    authorizeInbox(inboxId: string): AuthorizeResult;
  }
}

export interface AuthPluginOptions {
  core: CoreApi;
  /** Signing secret for @fastify/cookie. View-tokens are NOT signed (cookie
   *  carries plaintext), but the secret is required for the plugin to register. */
  cookieSecret: string;
}

export const authPlugin = fp(
  async (app: FastifyInstance, opts: AuthPluginOptions) => {
    await app.register(cookie, {
      secret: opts.cookieSecret,
      parseOptions: {},
    });

    app.decorateRequest(
      'authorizeInbox',
      function authorizeInbox(
        this: import('fastify').FastifyRequest,
        inboxId: string,
      ): AuthorizeResult {
        const name = cookieNameFor(inboxId);
        const raw = this.cookies[name];
        if (!raw) return { ok: false, status: 401 };
        const result = opts.core.verifyInboxAccess(inboxId, raw);
        if (result.ok) return { ok: true };
        if (result.reason === 'not_found') return { ok: false, status: 404 };
        return { ok: false, status: 403 };
      },
    );
  },
  { name: 'tempmail-auth' },
);

/**
 * Cookie options for setting the view-token cookie on POST /api/inbox.
 * Extracted so the mint route and tests use exactly the same options.
 */
export function viewTokenCookieOptions(
  inboxId: string,
  hardTtlMs: number,
): {
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
