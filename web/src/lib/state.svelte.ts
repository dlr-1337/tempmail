import * as api from './api.js';
import { ApiError } from './errors.js';
import { clearLastInbox, readLastInbox, writeLastInbox } from './storage.js';
import { subscribeInboxStream, type StreamHandle } from './sse.js';
import type { FullMessageView, InboxMetadata, MessageView } from './types.js';

// ---------- Reactive state (Svelte 5 runes) ----------

export const session = $state<{
  inbox: InboxMetadata | null;
  messages: MessageView[];
  loading: boolean;
  now: number;
}>({
  inbox: null,
  messages: [],
  loading: false,
  now: Date.now()
});

export interface ToastState {
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  id: number;
}

export const toast = $state<{ current: ToastState | null }>({ current: null });

let toastId = 0;
let streamHandle: StreamHandle | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let expiringSoonToasted = false;

// ---------- Public helpers ----------

export function remainingMs(): number {
  if (!session.inbox) return 0;
  return Date.parse(session.inbox.expiresAt) - session.now;
}

export function pushToast(type: ToastState['type'], message: string): void {
  toast.current = { type, message, id: ++toastId };
}

export function dismissToast(): void {
  toast.current = null;
}

/**
 * Mount-time entry point. Starts the 1s clock, revives or mints an inbox,
 * then opens the SSE stream.
 */
export async function initSession(): Promise<void> {
  startClock();
  await reviveOrMint();
}

export async function reviveOrMint(): Promise<void> {
  session.loading = true;
  try {
    const last = readLastInbox();
    if (last) {
      try {
        const meta = await api.getInbox(last.id);
        setInbox(meta);
        await refreshMessages();
        startStream(meta.id);
        return;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403 || err.status === 401)) {
          clearLastInbox();
          // fall through to mint
        } else {
          handleApiError(err);
          // still try to mint
        }
      }
    }
    await mintNewInbox();
  } finally {
    session.loading = false;
  }
}

export async function mintNewInbox(): Promise<void> {
  stopStream();
  try {
    const res = await api.createInbox();
    // Fetch the full metadata (includes messageCount = 0).
    const meta = await api.getInbox(res.id).catch(() => ({
      id: res.id,
      address: res.address,
      createdAt: res.createdAt,
      expiresAt: res.expiresAt,
      messageCount: 0
    }));
    setInbox(meta);
    session.messages = [];
    startStream(meta.id);
  } catch (err) {
    handleApiError(err);
  }
}

export async function refreshMessages(): Promise<void> {
  if (!session.inbox) return;
  try {
    const msgs = await api.listMessages(session.inbox.id);
    // Sorted ASC by Phase 5; enforce defensively.
    session.messages = [...msgs].sort(
      (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)
    );
  } catch (err) {
    handleApiError(err);
  }
}

export async function bumpExpiry(): Promise<void> {
  if (!session.inbox) return;
  try {
    const meta = await api.getInbox(session.inbox.id);
    setInbox(meta);
  } catch {
    // ignore — bumpExpiry is best-effort
  }
}

export function appendLiveMessage(view: FullMessageView): void {
  const { textBody: _t, htmlBody: _h, attachments: _a, ...summary } = view;
  const msg: MessageView = {
    ...summary,
    attachmentCount: view.attachments.length
  };
  const existsAt = session.messages.findIndex((m) => m.id === msg.id);
  if (existsAt >= 0) {
    session.messages[existsAt] = msg;
  } else {
    session.messages = [...session.messages, msg].sort(
      (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)
    );
  }
  // Activity → bump
  void bumpExpiry();
}

// ---------- Private ----------

function setInbox(meta: InboxMetadata): void {
  session.inbox = meta;
  writeLastInbox({ id: meta.id, address: meta.address, expiresAt: meta.expiresAt });
  expiringSoonToasted = false;
}

function startClock(): void {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    session.now = Date.now();
    if (!session.inbox) return;
    const remaining = Date.parse(session.inbox.expiresAt) - session.now;
    if (remaining <= 60_000 && remaining > 0 && !expiringSoonToasted) {
      expiringSoonToasted = true;
      pushToast('warning', 'Inbox expires soon');
    }
    if (remaining <= 0) {
      pushToast('info', 'Inbox expired — minting a new one');
      void mintNewInbox();
    }
  }, 1000);
}

export function stopClock(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function startStream(inboxId: string): void {
  stopStream();
  streamHandle = subscribeInboxStream(inboxId, {
    onMessage: (view) => appendLiveMessage(view),
    onError: () => {
      // EventSource auto-reconnects. Surface a soft hint only.
      pushToast('warning', 'Connection hiccup — reconnecting');
    },
    onOpen: () => {
      dismissToast();
    }
  });
}

export function stopStream(): void {
  if (streamHandle) {
    streamHandle.close();
    streamHandle = null;
  }
}

function handleApiError(err: unknown): void {
  if (!(err instanceof ApiError)) {
    pushToast('error', 'Something went wrong');
    return;
  }
  switch (err.status) {
    case 401:
      pushToast('warning', 'Session expired — minting new inbox');
      clearLastInbox();
      void mintNewInbox();
      break;
    case 403:
      pushToast('warning', 'Stale bookmark — minting new inbox');
      clearLastInbox();
      void mintNewInbox();
      break;
    case 404:
      pushToast('warning', 'Inbox expired — minting new inbox');
      clearLastInbox();
      void mintNewInbox();
      break;
    case 429: {
      const sec = err.retryAfter ?? 60;
      pushToast('warning', `Slow down — retry in ${sec}s`);
      break;
    }
    default:
      if (err.status >= 500) {
        pushToast('error', 'Service issue — retrying soon');
      } else {
        pushToast('error', err.message || 'Request failed');
      }
  }
}
