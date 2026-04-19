import { describe, expect, it } from 'vitest';
import { ApiError, parseErrorEnvelope } from './errors.js';

function makeRes(status: number, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  return new Response(null, { status, headers: h });
}

describe('parseErrorEnvelope', () => {
  it('parses { error: { code, message } } envelope', () => {
    const err = parseErrorEnvelope(makeRes(404), {
      error: { code: 'not_found', message: 'Inbox expired' }
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Inbox expired');
    expect(err.status).toBe(404);
  });

  it('falls back to status-derived code when body missing', () => {
    expect(parseErrorEnvelope(makeRes(401), null).code).toBe('unauthorized');
    expect(parseErrorEnvelope(makeRes(403), null).code).toBe('forbidden');
    expect(parseErrorEnvelope(makeRes(404), null).code).toBe('not_found');
    expect(parseErrorEnvelope(makeRes(429), null).code).toBe('rate_limited');
    expect(parseErrorEnvelope(makeRes(500), null).code).toBe('server_error');
  });

  it('extracts Retry-After on 429', () => {
    const err = parseErrorEnvelope(makeRes(429, { 'retry-after': '12' }), {
      error: { code: 'rate_limited', message: 'slow down' }
    });
    expect(err.retryAfter).toBe(12);
    expect(err.code).toBe('rate_limited');
  });

  it('ignores Retry-After when absent or invalid', () => {
    const a = parseErrorEnvelope(makeRes(429), { error: { code: 'rate_limited', message: 'x' } });
    expect(a.retryAfter).toBeUndefined();

    const b = parseErrorEnvelope(makeRes(429, { 'retry-after': 'notanumber' }), null);
    expect(b.retryAfter).toBeUndefined();
  });

  it('rejects malformed error envelope (shape mismatch)', () => {
    const err = parseErrorEnvelope(makeRes(500), { nope: true });
    expect(err.code).toBe('server_error'); // fell back
  });
});
