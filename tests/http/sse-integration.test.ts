import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookieNameFor } from '../../src/http/plugins/auth.js';
import { type TestRig, buildTestRig } from './support.js';

interface ParsedEvent {
  id: string;
  event: string;
  data: string;
}

/**
 * Reads at most `count` SSE events from a ReadableStream within `timeoutMs`.
 * Heartbeat comment frames are skipped.
 */
const readEvents = async (
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 3000,
): Promise<ParsedEvent[]> => {
  const decoder = new TextDecoder();
  let buf = '';
  const events: ParsedEvent[] = [];
  const reader = stream.getReader();
  const deadline = Date.now() + timeoutMs;

  try {
    while (events.length < count && Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      );
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (frame.startsWith(':')) {
          // heartbeat — skip
        } else if (frame.length > 0) {
          const lines = frame.split('\n');
          const parsed: ParsedEvent = { id: '', event: 'message', data: '' };
          for (const line of lines) {
            if (line.startsWith('id: ')) parsed.id = line.slice(4);
            else if (line.startsWith('event: ')) parsed.event = line.slice(7);
            else if (line.startsWith('data: ')) parsed.data += line.slice(6);
          }
          events.push(parsed);
        }
        idx = buf.indexOf('\n\n');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return events;
};

describe('GET /api/inbox/:id/stream (SSE real listen)', () => {
  let rig: TestRig;
  let baseUrl: string;
  beforeEach(async () => {
    rig = await buildTestRig();
    await rig.app.listen({ host: '127.0.0.1', port: 0 });
    const address = rig.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await rig.close();
  });

  it('401 without cookie', async () => {
    const inbox = rig.core.createInbox();
    const r = await fetch(`${baseUrl}/api/inbox/${inbox.inboxId}/stream`);
    expect(r.status).toBe(401);
    await r.body?.cancel();
  });

  it('replays pre-existing messages before live events arrive', async () => {
    const inbox = rig.core.createInbox();
    const ingest1 = rig.core.ingestMessage({
      envelopeTo: inbox.address,
      envelopeFrom: null,
      sender: null,
      subject: 'pre-existing',
      textBody: 'one',
      htmlBody: null,
      headers: null,
      attachments: [],
      sizeBytes: 1,
    });
    expect(ingest1.ok).toBe(true);

    const r = await fetch(`${baseUrl}/api/inbox/${inbox.inboxId}/stream`, {
      headers: { cookie: `${cookieNameFor(inbox.inboxId)}=${inbox.viewToken}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    if (!r.body) throw new Error('no body');

    // Push a live message AFTER the response arrives.
    setTimeout(() => {
      rig.core.ingestMessage({
        envelopeTo: inbox.address,
        envelopeFrom: null,
        sender: null,
        subject: 'live-after',
        textBody: 'two',
        htmlBody: null,
        headers: null,
        attachments: [],
        sizeBytes: 1,
      });
    }, 30);

    const events = await readEvents(r.body as unknown as ReadableStream<Uint8Array>, 2, 5000);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const subjects = events.map((e) => (JSON.parse(e.data) as { subject: string }).subject);
    expect(subjects.slice(0, 2)).toEqual(['pre-existing', 'live-after']);
  });

  it('Last-Event-ID skips already-delivered messages on reconnect', async () => {
    const inbox = rig.core.createInbox();
    rig.core.ingestMessage({
      envelopeTo: inbox.address,
      envelopeFrom: null,
      sender: null,
      subject: 'old-1',
      textBody: null,
      htmlBody: null,
      headers: null,
      attachments: [],
      sizeBytes: 1,
    });
    const list = rig.core.listMessages({ inboxId: inbox.inboxId, viewToken: inbox.viewToken });
    if (!list.ok) throw new Error('list failed');
    const firstReceivedAt = list.messages[0]?.receivedAt;
    if (typeof firstReceivedAt !== 'number') throw new Error('no first');

    rig.core.ingestMessage({
      envelopeTo: inbox.address,
      envelopeFrom: null,
      sender: null,
      subject: 'new-2',
      textBody: null,
      htmlBody: null,
      headers: null,
      attachments: [],
      sizeBytes: 1,
    });

    const r = await fetch(`${baseUrl}/api/inbox/${inbox.inboxId}/stream`, {
      headers: {
        cookie: `${cookieNameFor(inbox.inboxId)}=${inbox.viewToken}`,
        'last-event-id': String(firstReceivedAt),
      },
    });
    expect(r.status).toBe(200);
    if (!r.body) throw new Error('no body');

    const events = await readEvents(r.body as unknown as ReadableStream<Uint8Array>, 1, 3000);
    expect(events.length).toBe(1);
    const d = JSON.parse(events[0]?.data ?? '{}') as { subject: string };
    expect(d.subject).toBe('new-2');
  });
});
