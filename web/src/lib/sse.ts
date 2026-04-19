import { streamUrl } from './api.js';
import type { FullMessageView } from './types.js';

export interface StreamHandlers {
  onMessage: (view: FullMessageView) => void;
  onError?: (err: Event) => void;
  onOpen?: () => void;
}

export interface StreamHandle {
  close: () => void;
}

/**
 * Open an SSE stream to /api/inbox/:id/stream and deliver message events.
 * EventSource handles reconnect + Last-Event-ID natively.
 */
export function subscribeInboxStream(
  inboxId: string,
  handlers: StreamHandlers
): StreamHandle {
  const Ctor = getEventSourceCtor();
  if (!Ctor) {
    // SSR or missing EventSource support — return a no-op handle.
    return { close() {} };
  }
  const url = streamUrl(inboxId);
  const es = new Ctor(url, { withCredentials: true });

  if (handlers.onOpen) {
    es.addEventListener('open', handlers.onOpen);
  }
  if (handlers.onError) {
    es.addEventListener('error', handlers.onError);
  }

  const handleMessage = (ev: MessageEvent): void => {
    try {
      const parsed = JSON.parse(ev.data) as FullMessageView;
      handlers.onMessage(parsed);
    } catch {
      // malformed frame — ignore
    }
  };

  // Phase 5 emits `event: message`, which maps to the 'message' listener below.
  es.addEventListener('message', handleMessage as EventListener);

  return {
    close() {
      es.close();
    }
  };
}

function getEventSourceCtor(): typeof EventSource | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as { EventSource?: typeof EventSource };
  return typeof g.EventSource === 'function' ? g.EventSource : null;
}
