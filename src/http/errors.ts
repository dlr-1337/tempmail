/**
 * Phase 5 error envelope (D-24).
 *
 * Shape: `{ error: { code: string, message: string } }`. Stable codes listed
 * in HTTP_ERROR_CODES. Helper `sendError` sets the matching HTTP status and
 * serializes the body — every route uses this so the envelope is invariant.
 */

import type { FastifyReply } from 'fastify';

export const HTTP_ERROR_CODES = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  rate_limited: 'rate_limited',
  invalid_request: 'invalid_request',
  server_error: 'server_error',
} as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[keyof typeof HTTP_ERROR_CODES];

export interface ErrorBody {
  error: { code: HttpErrorCode; message: string };
}

const CODE_TO_STATUS: Record<HttpErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  invalid_request: 400,
  server_error: 500,
};

export function sendError(reply: FastifyReply, code: HttpErrorCode, message: string): FastifyReply {
  return reply.status(CODE_TO_STATUS[code]).send({ error: { code, message } } satisfies ErrorBody);
}
