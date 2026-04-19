import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeInboxStream } from './sse.js';

type ListenerMap = Record<string, Array<(ev: MessageEvent | Event) => void>>;

class FakeEventSource {
  url: string;
  withCredentials: boolean;
  closed = false;
  listeners: ListenerMap = {};
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = !!init?.withCredentials;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, cb: (ev: MessageEvent | Event) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, ev: MessageEvent | Event): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  static last: FakeEventSource | null = null;
}

describe('subscribeInboxStream', () => {
  const orig = (globalThis as unknown as { EventSource?: unknown }).EventSource;

  beforeEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    FakeEventSource.last = null;
  });

  afterEach(() => {
    (globalThis as unknown as { EventSource?: unknown }).EventSource = orig;
  });

  it('opens an EventSource with credentials and the correct url', () => {
    subscribeInboxStream('abc', { onMessage: () => {} });
    expect(FakeEventSource.last).toBeTruthy();
    expect(FakeEventSource.last?.url).toContain('/inbox/abc/stream');
    expect(FakeEventSource.last?.withCredentials).toBe(true);
  });

  it('parses message events and invokes onMessage', () => {
    const onMessage = vi.fn();
    subscribeInboxStream('abc', { onMessage });
    const payload = {
      id: 'm1',
      from: 'a@b',
      subject: 's',
      receivedAt: new Date().toISOString(),
      hasTextBody: true,
      hasHtmlBody: false,
      attachmentCount: 0,
      textBody: 'hi',
      htmlBody: null,
      attachments: []
    };
    FakeEventSource.last?.emit(
      'message',
      new MessageEvent('message', { data: JSON.stringify(payload) })
    );
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });

  it('ignores malformed JSON frames', () => {
    const onMessage = vi.fn();
    subscribeInboxStream('abc', { onMessage });
    FakeEventSource.last?.emit(
      'message',
      new MessageEvent('message', { data: 'not json' })
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('close() closes the EventSource', () => {
    const handle = subscribeInboxStream('abc', { onMessage: () => {} });
    handle.close();
    expect(FakeEventSource.last?.closed).toBe(true);
  });
});
