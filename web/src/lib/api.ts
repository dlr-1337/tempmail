import { API_BASE } from './env.js';
import { ApiError, parseErrorEnvelope } from './errors.js';
import type {
  FullMessageView,
  InboxMetadata,
  InboxMintResponse,
  MessageView
} from './types.js';

interface RequestOpts {
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: RequestOpts = {}
): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('network_error', 'Network request failed', 0);
  }

  if (res.status === 204) return undefined as T;

  const ct = res.headers.get('content-type') ?? '';
  const isJson = ct.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw parseErrorEnvelope(res, body);
  }

  return body as T;
}

export function createInbox(signal?: AbortSignal): Promise<InboxMintResponse> {
  return request<InboxMintResponse>('POST', '/inbox', { signal });
}

export function getInbox(id: string, signal?: AbortSignal): Promise<InboxMetadata> {
  return request<InboxMetadata>('GET', `/inbox/${encodeURIComponent(id)}`, { signal });
}

export async function listMessages(
  id: string,
  signal?: AbortSignal
): Promise<MessageView[]> {
  const res = await request<{ messages: MessageView[] }>(
    'GET',
    `/inbox/${encodeURIComponent(id)}/messages`,
    { signal }
  );
  return res.messages ?? [];
}

export function getMessage(
  id: string,
  msgId: string,
  signal?: AbortSignal
): Promise<FullMessageView> {
  return request<FullMessageView>(
    'GET',
    `/inbox/${encodeURIComponent(id)}/messages/${encodeURIComponent(msgId)}`,
    { signal }
  );
}

export function streamUrl(id: string): string {
  return `${API_BASE}/inbox/${encodeURIComponent(id)}/stream`;
}

export function attachmentUrl(id: string, attId: string): string {
  return `${API_BASE}/inbox/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attId)}`;
}

export { ApiError };
