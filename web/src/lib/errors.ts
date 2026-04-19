import type { ErrorEnvelope } from './types.js';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;

  constructor(code: string, message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as ErrorEnvelope).error === 'object' &&
    typeof (body as ErrorEnvelope).error?.code === 'string' &&
    typeof (body as ErrorEnvelope).error?.message === 'string'
  );
}

/**
 * Parse a non-2xx response into an ApiError.
 * Honors Phase 5 error envelope { error: { code, message } }.
 * Extracts Retry-After header for 429.
 */
export function parseErrorEnvelope(res: Response, body: unknown): ApiError {
  const status = res.status;
  const fallbackCode = fallbackCodeForStatus(status);
  const fallbackMessage = fallbackMessageForStatus(status);

  let code = fallbackCode;
  let message = fallbackMessage;
  if (isErrorEnvelope(body)) {
    code = body.error.code;
    message = body.error.message;
  }

  let retryAfter: number | undefined;
  if (status === 429) {
    const raw = res.headers.get('retry-after');
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) retryAfter = n;
    }
  }

  return new ApiError(code, message, status, retryAfter);
}

function fallbackCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server_error' : 'invalid_request';
  }
}

function fallbackMessageForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Not authorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not found';
    case 429:
      return 'Too many requests';
    default:
      return status >= 500 ? 'Service error' : 'Request failed';
  }
}
