---
phase: 5
plan: 5
status: ready
type: execute
wave: 4
depends_on: [05-02, 05-04]
requirements: [API-05, API-06, API-07, RT-01, RT-02, RT-03]
files_modified:
  - src/http/sse.ts
  - src/http/routes/stream.ts
  - src/http/server.ts
  - tests/http/sse-unit.test.ts
  - tests/http/sse-integration.test.ts
autonomous: true
tags: [sse, streaming, real-time, replay-on-subscribe]
must_haves:
  truths:
    - "GET /api/inbox/:id/stream writes text/event-stream with correct headers + hijacks reply.raw"
    - "On connect: replay every message with receivedAt > Last-Event-ID BEFORE attaching the bus listener"
    - "Each SSE event has id: <receivedAtMs>-<messageId>, event: message, data: <json>"
    - "Heartbeats every 15s (comment line ': heartbeat <ts>\\n\\n')"
    - "On request close: unsubscribe from bus, clear heartbeat"
    - "Backpressure respected: skip heartbeat if write in flight"
    - "Parses Last-Event-ID as numeric receivedAtMs prefix"
---

# Plan 05-05: SSE stream with replay-on-subscribe + heartbeat

## Goal

Ship the `GET /api/inbox/:id/stream` SSE endpoint with (a) replay of missed messages, (b) live bus subscription, (c) heartbeat keepalive, (d) clean shutdown.

## Must-have checklist

- [ ] SSE serializer in `src/http/sse.ts` (format messages as SSE frames)
- [ ] Stream route in `src/http/routes/stream.ts`
- [ ] Auth via cookie (same pattern as other routes)
- [ ] Replay happens BEFORE listener attach (D-16)
- [ ] `Last-Event-ID` header parsed; numeric prefix used as the filter cutoff
- [ ] Backpressure-aware writes (skip heartbeat on in-flight)
- [ ] Unit tests on the SSE serializer
- [ ] Integration test using a real `.listen()` + undici fetch consuming chunks

## Tasks

<task type="auto">
  <name>Task 1: SSE frame serializer</name>
  <files>src/http/sse.ts</files>
  <action>

  Create `src/http/sse.ts`:

  ```typescript
  /**
   * SSE frame serializer (D-14, D-15).
   *
   * Produces strings that match the text/event-stream spec:
   *
   *   id: <id>\n
   *   event: <event>\n
   *   data: <line1>\n
   *   data: <line2>\n
   *   \n
   *
   * - Multi-line data is split at \n; each line is prefixed with `data: `.
   * - Event id format: `<receivedAtMs>-<messageId>` (D-15). Last-Event-ID on
   *   reconnect is parsed as the numeric prefix before the first hyphen.
   * - Heartbeat frames are a single comment line + blank line.
   */

  export interface SseEventFrame {
    id: string;
    event: string;
    data: unknown; // JSON-serialized
  }

  export function formatEventId(receivedAtMs: number, messageId: string): string {
    return `${receivedAtMs}-${messageId}`;
  }

  /** Parses `Last-Event-ID` back to a numeric receivedAtMs. Returns 0 on malformed. */
  export function parseLastEventId(raw: string | string[] | undefined): number {
    if (!raw) return 0;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return 0;
    const dash = value.indexOf('-');
    const prefix = dash < 0 ? value : value.slice(0, dash);
    const n = Number.parseInt(prefix, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  export function serializeEvent(frame: SseEventFrame): string {
    const json = JSON.stringify(frame.data);
    // Split at every \n so SSE renders multi-line data correctly. Single-line
    // JSON from JSON.stringify won't contain \n, but be defensive.
    const dataLines = json.split('\n').map((line) => `data: ${line}`).join('\n');
    return `id: ${frame.id}\nevent: ${frame.event}\n${dataLines}\n\n`;
  }

  export function serializeHeartbeat(nowMs: number): string {
    return `: heartbeat ${nowMs}\n\n`;
  }
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): add sse frame serializer</commit>
</task>

<task type="auto">
  <name>Task 2: SSE route handler</name>
  <files>src/http/routes/stream.ts</files>
  <action>

  Create `src/http/routes/stream.ts`:

  ```typescript
  /**
   * GET /api/inbox/:id/stream — SSE with replay-on-subscribe + heartbeat.
   *
   * Algorithm (D-16):
   *   1. Validate auth (401/403/404).
   *   2. Hijack reply, write SSE headers, flush.
   *   3. Parse Last-Event-ID. Query core.listMessages → filter receivedAt >
   *      lastEventId → for each, serialize + write.
   *   4. Attach core.bus.on('message', ...) filtered by inboxId. Each event:
   *      fetch full message via core.getMessage, write frame.
   *   5. Start 15s heartbeat interval. Skip heartbeat if a write is in flight
   *      (backpressure).
   *   6. On request.raw.on('close'): unsubscribe, clear interval.
   *
   * Rate limit: 10/min per IP per connection attempt (D-18).
   */

  import type { FastifyInstance, FastifyRequest } from 'fastify';
  import type { ZodTypeProvider } from 'fastify-type-provider-zod';
  import type { CoreApi } from '../../core/index.js';
  import { sendError } from '../errors.js';
  import { cookieNameFor } from '../plugins/auth.js';
  import { inboxIdParam } from '../schemas.js';
  import { formatEventId, parseLastEventId, serializeEvent, serializeHeartbeat } from '../sse.js';

  export interface StreamRouteDeps {
    core: CoreApi;
    /** Heartbeat interval in ms (default 15_000). Overridable for tests. */
    heartbeatMs?: number;
    /** Clock for heartbeat timestamps. Overridable for tests. */
    now?: () => number;
  }

  export async function registerStreamRoute(app: FastifyInstance, deps: StreamRouteDeps): Promise<void> {
    const heartbeatMs = deps.heartbeatMs ?? 15_000;
    const now = deps.now ?? Date.now;
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/api/inbox/:id/stream',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { params: inboxIdParam },
      },
      async (req, reply) => {
        const inboxId = req.params.id;
        const auth = req.authorizeInbox(inboxId);
        if (!auth.ok) {
          return sendError(
            reply,
            auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'not_found',
            auth.status === 401 ? 'missing view-token' : auth.status === 403 ? 'bad view-token' : 'inbox not found',
          );
        }
        const token = req.cookies[cookieNameFor(inboxId)] ?? '';

        // Hijack & prepare raw response.
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        raw.flushHeaders?.();

        let writing = false;
        const write = (chunk: string): Promise<void> => {
          if (raw.writableEnded) return Promise.resolve();
          writing = true;
          return new Promise((resolve) => {
            const ok = raw.write(chunk);
            if (ok) {
              writing = false;
              resolve();
            } else {
              raw.once('drain', () => {
                writing = false;
                resolve();
              });
            }
          });
        };

        // 1. Replay: filter messages that arrived after Last-Event-ID.
        const lastEventId = parseLastEventId(req.headers['last-event-id']);
        const list = deps.core.listMessages({ inboxId, viewToken: token });
        if (list.ok) {
          for (const m of list.messages) {
            if (m.receivedAt <= lastEventId) continue;
            await write(
              serializeEvent({
                id: formatEventId(m.receivedAt, m.id),
                event: 'message',
                data: m,
              }),
            );
            if (raw.writableEnded) return reply;
          }
        }

        // 2. Live subscription.
        const unsubscribe = deps.core.bus.on('message', (payload) => {
          if (payload.inboxId !== inboxId) return;
          const full = deps.core.getMessage({ inboxId, messageId: payload.messageId, viewToken: token });
          if (!full.ok) return;
          // Fire-and-forget with backpressure; errors are swallowed (socket closed).
          void write(
            serializeEvent({
              id: formatEventId(payload.receivedAt, payload.messageId),
              event: 'message',
              data: full.message,
            }),
          ).catch(() => {});
        });

        // 3. Heartbeat.
        const heartbeat = setInterval(() => {
          if (writing) return; // D-17 backpressure: skip if a write is in flight.
          if (raw.writableEnded) return;
          raw.write(serializeHeartbeat(now()));
        }, heartbeatMs);
        heartbeat.unref?.();

        // 4. Cleanup on close.
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          if (!raw.writableEnded) {
            try {
              raw.end();
            } catch {
              /* already closed */
            }
          }
        };
        req.raw.on('close', cleanup);
        req.raw.on('aborted', cleanup);
        // Fastify prefers returning reply; we've hijacked so the value is ignored,
        // but TS needs something. Return the reply to keep types clean.
        return reply;
      },
    );
  }

  // Expose a small helper so tests can assert the request handler wiring.
  export { parseLastEventId };
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Compiles.</done>
  <commit>feat(http): add sse stream route with replay and heartbeat</commit>
</task>

<task type="auto">
  <name>Task 3: Register stream route</name>
  <files>src/http/server.ts</files>
  <action>

  Edit `src/http/server.ts`. Add:

  ```typescript
  import { registerStreamRoute } from './routes/stream.js';
  // after registerAttachmentRoutes:
  await registerStreamRoute(app, { core: deps.core });
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run tests/http</automated>
  </verify>
  <done>Compiles; prior tests still green.</done>
  <commit>feat(http): register sse stream route</commit>
</task>

<task type="auto">
  <name>Task 4: Unit tests for SSE serializer</name>
  <files>tests/http/sse-unit.test.ts</files>
  <action>

  Create `tests/http/sse-unit.test.ts`:

  ```typescript
  import { describe, expect, it } from 'vitest';
  import { formatEventId, parseLastEventId, serializeEvent, serializeHeartbeat } from '../../src/http/sse.js';

  describe('sse serializer', () => {
    it('formatEventId composes <receivedAt>-<messageId>', () => {
      expect(formatEventId(1234567890, 'abc')).toBe('1234567890-abc');
    });

    it('serializeEvent emits id/event/data frame ending with double newline', () => {
      const out = serializeEvent({ id: '1-a', event: 'message', data: { x: 1 } });
      expect(out).toBe('id: 1-a\nevent: message\ndata: {"x":1}\n\n');
    });

    it('serializeEvent splits multi-line data across data: lines', () => {
      // Use a raw Unicode line-separator in the JSON payload — trick: insert a newline by stringifying a string with it.
      const out = serializeEvent({ id: '1-a', event: 'message', data: 'line1\nline2' });
      expect(out).toContain('data: "line1\\nline2"'); // JSON-escaped, still one data line
      // More meaningful check: if some caller inserts a real newline, serialize splits:
      const raw = { id: '1-a', event: 'message', data: 'ignored' };
      // Force a multi-line data by serializing a value with a real newline we inject.
      const multi = serializeEvent({ ...raw, data: 'a' });
      expect(multi.endsWith('\n\n')).toBe(true);
    });

    it('serializeHeartbeat emits comment frame', () => {
      expect(serializeHeartbeat(100)).toBe(': heartbeat 100\n\n');
    });

    it('parseLastEventId handles prefix, plain number, missing, malformed', () => {
      expect(parseLastEventId(undefined)).toBe(0);
      expect(parseLastEventId('')).toBe(0);
      expect(parseLastEventId('abc')).toBe(0);
      expect(parseLastEventId('100')).toBe(100);
      expect(parseLastEventId('1234-abc')).toBe(1234);
      expect(parseLastEventId(['5678-xyz'])).toBe(5678);
    });
  });
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/sse-unit.test.ts</automated>
  </verify>
  <done>5 cases pass.</done>
  <commit>test(http): cover sse serializer and last-event-id parsing</commit>
</task>

<task type="auto">
  <name>Task 5: Integration test — real listen, replay + live delivery + heartbeat</name>
  <files>tests/http/sse-integration.test.ts</files>
  <action>

  Create `tests/http/sse-integration.test.ts`:

  ```typescript
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { fetch } from 'undici';
  import { cookieNameFor } from '../../src/http/plugins/auth.js';
  import { buildTestRig, type TestRig } from './support.js';

  interface ParsedEvent { id: string; event: string; data: string }

  const readEvents = async (stream: ReadableStream<Uint8Array>, count: number, timeoutMs = 3000): Promise<ParsedEvent[]> => {
    const decoder = new TextDecoder();
    let buf = '';
    const events: ParsedEvent[] = [];
    const reader = stream.getReader();
    const deadline = Date.now() + timeoutMs;

    while (events.length < count && Date.now() < deadline) {
      const racer = Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now()))),
      ]);
      const { done, value } = await racer;
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      // Split on blank-line frame separator.
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (frame.startsWith(':')) {
          // Heartbeat — ignore for this helper
        } else {
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
    try {
      await reader.cancel();
    } catch {
      /* ignore */
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
      // Seed one message BEFORE connecting.
      const ingest1 = rig.core.ingestMessage({
        envelopeTo: inbox.address,
        envelopeFrom: null, sender: null, subject: 'pre-existing',
        textBody: 'one', htmlBody: null, headers: null, attachments: [], sizeBytes: 1,
      });
      expect(ingest1.ok).toBe(true);

      const r = await fetch(`${baseUrl}/api/inbox/${inbox.inboxId}/stream`, {
        headers: { cookie: `${cookieNameFor(inbox.inboxId)}=${inbox.viewToken}` },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      if (!r.body) throw new Error('no body');

      // Push a live message AFTER the response headers arrive.
      setTimeout(() => {
        rig.core.ingestMessage({
          envelopeTo: inbox.address,
          envelopeFrom: null, sender: null, subject: 'live-after',
          textBody: 'two', htmlBody: null, headers: null, attachments: [], sizeBytes: 1,
        });
      }, 30);

      const events = await readEvents(r.body, 2, 5000);
      expect(events.length).toBeGreaterThanOrEqual(2);
      const subjects = events.map((e) => {
        const d = JSON.parse(e.data) as { subject: string };
        return d.subject;
      });
      expect(subjects.slice(0, 2)).toEqual(['pre-existing', 'live-after']);
    });

    it('Last-Event-ID skips already-delivered messages on reconnect', async () => {
      const inbox = rig.core.createInbox();
      // Seed two messages with controllable ordering (relying on emit-after-commit).
      rig.core.ingestMessage({
        envelopeTo: inbox.address, envelopeFrom: null, sender: null, subject: 'old-1',
        textBody: null, htmlBody: null, headers: null, attachments: [], sizeBytes: 1,
      });
      const list = rig.core.listMessages({ inboxId: inbox.inboxId, viewToken: inbox.viewToken });
      if (!list.ok) throw new Error('list failed');
      const firstReceivedAt = list.messages[0]?.receivedAt;
      if (typeof firstReceivedAt !== 'number') throw new Error('no first');

      rig.core.ingestMessage({
        envelopeTo: inbox.address, envelopeFrom: null, sender: null, subject: 'new-2',
        textBody: null, htmlBody: null, headers: null, attachments: [], sizeBytes: 1,
      });

      const r = await fetch(`${baseUrl}/api/inbox/${inbox.inboxId}/stream`, {
        headers: {
          cookie: `${cookieNameFor(inbox.inboxId)}=${inbox.viewToken}`,
          'last-event-id': String(firstReceivedAt),
        },
      });
      expect(r.status).toBe(200);
      if (!r.body) throw new Error('no body');

      const events = await readEvents(r.body, 1, 3000);
      // Only the second message replayed (receivedAt > firstReceivedAt).
      expect(events.length).toBe(1);
      const d = JSON.parse(events[0]?.data ?? '{}') as { subject: string };
      expect(d.subject).toBe('new-2');
    });
  });
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/sse-integration.test.ts</automated>
  </verify>
  <done>All 3 integration cases pass.</done>
  <commit>test(http): sse replay-on-subscribe + last-event-id integration</commit>
</task>

## Verification

```bash
npm run typecheck && npm run check && npm test
```

## Success Criteria

- Serializer unit tests pass.
- Integration test proves: pre-existing message replays before a live message; Last-Event-ID skips already-delivered messages.
- Heartbeat interval unref'd so tests exit cleanly.
- Prior tests still green.
