/**
 * localStorage helpers. Stores ONLY the last-seen inbox id/address/expiry.
 * View-token is never persisted client-side — it lives in an HttpOnly cookie.
 */

const KEY_ID = 'tempmail:lastInboxId';
const KEY_ADDR = 'tempmail:lastInboxAddress';
const KEY_EXP = 'tempmail:lastInboxExpiresAt';

export interface PersistedInbox {
  id: string;
  address: string;
  expiresAt: string;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    // Sanity check — private mode sometimes throws on access.
    s.getItem('__tempmail_probe__');
    return s;
  } catch {
    return null;
  }
}

export function readLastInbox(): PersistedInbox | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const id = s.getItem(KEY_ID);
    const address = s.getItem(KEY_ADDR);
    const expiresAt = s.getItem(KEY_EXP);
    if (!id || !address || !expiresAt) return null;
    return { id, address, expiresAt };
  } catch {
    return null;
  }
}

export function writeLastInbox(inbox: PersistedInbox): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(KEY_ID, inbox.id);
    s.setItem(KEY_ADDR, inbox.address);
    s.setItem(KEY_EXP, inbox.expiresAt);
  } catch {
    // Full / private mode — silent no-op.
  }
}

export function clearLastInbox(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(KEY_ID);
    s.removeItem(KEY_ADDR);
    s.removeItem(KEY_EXP);
  } catch {
    // no-op
  }
}
