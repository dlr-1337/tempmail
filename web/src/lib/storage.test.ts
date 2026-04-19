import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLastInbox, readLastInbox, writeLastInbox } from './storage.js';

describe('storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('roundtrips persisted inbox', () => {
    writeLastInbox({ id: 'abc', address: 'x@y', expiresAt: '2026-04-18T13:00:00Z' });
    expect(readLastInbox()).toEqual({
      id: 'abc',
      address: 'x@y',
      expiresAt: '2026-04-18T13:00:00Z'
    });
  });

  it('returns null when missing', () => {
    expect(readLastInbox()).toBeNull();
  });

  it('clears all three keys', () => {
    writeLastInbox({ id: 'a', address: 'b', expiresAt: 'c' });
    clearLastInbox();
    expect(readLastInbox()).toBeNull();
  });
});
