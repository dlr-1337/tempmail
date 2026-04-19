/**
 * Phase 5 zod schemas for param/body/response validation (D-22, D-23).
 *
 * The nanoid alphabet is URL-safe: `0-9A-Za-z_-` (64 chars), length 22 — that
 * shape covers inbox ids, message ids, and attachment ids (all minted via
 * `newId()` from `src/util/id.ts`). The regex is our first line of defense
 * against malformed path params: invalid shape → 400 before Core ever sees
 * the request (D-23).
 */

import { z } from 'zod';

/** nanoid v5 default alphabet: `A-Za-z0-9_-`, 22 chars. */
export const ID_REGEX = /^[0-9A-Za-z_-]{22}$/;

export const idSchema = z.string().regex(ID_REGEX, 'invalid_id');

export const inboxIdParam = z.object({ id: idSchema });
export const messageIdParam = z.object({ id: idSchema, msgId: idSchema });
export const attachmentIdParam = z.object({ id: idSchema, attId: idSchema });

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      'unauthorized',
      'forbidden',
      'not_found',
      'rate_limited',
      'invalid_request',
      'server_error',
    ]),
    message: z.string(),
  }),
});
