import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import * as api from './api.js';

const originalFetch = globalThis.fetch;

function mockFetch(res: Response): typeof globalThis.fetch {
  return vi.fn(async () => res) as unknown as typeof globalThis.fetch;
}

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createInbox posts JSON and returns parsed body', async () => {
    const body = { id: 'i1', address: 'a@b', createdAt: 'x', expiresAt: 'y' };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('include');
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await api.createInbox();
    expect(result).toEqual(body);
  });

  it('throws ApiError with envelope code on 429', async () => {
    globalThis.fetch = mockFetch(
      new Response(
        JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '7' }
        }
      )
    );
    await expect(api.createInbox()).rejects.toMatchObject({
      name: 'ApiError',
      code: 'rate_limited',
      status: 429,
      retryAfter: 7
    });
  });

  it('throws ApiError with not_found on 404', async () => {
    globalThis.fetch = mockFetch(
      new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'expired' } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    );
    await expect(api.getInbox('abc')).rejects.toBeInstanceOf(ApiError);
  });

  it('listMessages returns the messages array', async () => {
    globalThis.fetch = mockFetch(
      new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const msgs = await api.listMessages('i1');
    expect(msgs).toEqual([{ id: 'm1' }]);
  });

  it('attachmentUrl encodes ids and uses API_BASE', () => {
    const url = api.attachmentUrl('inbox 1', 'att/2');
    expect(url).toContain('/inbox/inbox%201/attachments/att%2F2');
  });
});
