import { describe, expect, it } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.js';

describe('inboxRepo (STORE-04)', () => {
  it('createInbox returns row with assigned id + timestamps', () => {
    const { repos } = openTestDbWithRepos();
    const before = Date.now();
    const row = repos.inboxes.createInbox({
      local_part: 'abc',
      domain: 'example.test',
      view_token_hash: 'h',
      expires_at: 9_999_999_999,
      hard_expires_at: 9_999_999_999,
    });
    expect(row.id).toMatch(/^[A-Za-z0-9_-]{22}$/); // nanoid default alphabet
    expect(row.local_part).toBe('abc');
    expect(row.domain).toBe('example.test');
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.last_activity_at).toBe(row.created_at);
  });

  it('findInboxByLocalPart disambiguates by (local_part, domain)', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    repos.inboxes.createInbox({
      local_part: 'same',
      domain: 'a.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    repos.inboxes.createInbox({
      local_part: 'same',
      domain: 'b.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    const a = repos.inboxes.findInboxByLocalPart('same', 'a.test');
    const b = repos.inboxes.findInboxByLocalPart('same', 'b.test');
    expect(a?.domain).toBe('a.test');
    expect(b?.domain).toBe('b.test');
    expect(a?.id).not.toBe(b?.id);
  });

  it('UNIQUE (local_part, domain) is enforced', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    repos.inboxes.createInbox({
      local_part: 'dup',
      domain: 'a.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    expect(() =>
      repos.inboxes.createInbox({
        local_part: 'dup',
        domain: 'a.test',
        view_token_hash: 'h2',
        expires_at: exp,
        hard_expires_at: exp,
      }),
    ).toThrow(/UNIQUE/);
  });

  it('updateLastActivity caps expires_at at hard_expires_at', () => {
    const { repos } = openTestDbWithRepos();
    const hardCap = Date.now() + 3_600_000;
    const row = repos.inboxes.createInbox({
      local_part: 'x',
      domain: 'd.test',
      view_token_hash: 'h',
      expires_at: Date.now() + 60_000,
      hard_expires_at: hardCap,
    });
    // Ask for 10h from now — should clamp to hardCap.
    const updated = repos.inboxes.updateLastActivity(row.id, Date.now() + 36_000_000);
    expect(updated).toBeDefined();
    expect(updated?.expires_at).toBe(hardCap);
  });

  it('updateLastActivity returns undefined for missing inbox', () => {
    const { repos } = openTestDbWithRepos();
    expect(repos.inboxes.updateLastActivity('nonexistent', Date.now())).toBeUndefined();
  });

  it('deleteInbox returns true once and false thereafter', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const row = repos.inboxes.createInbox({
      local_part: 'del',
      domain: 'd.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    expect(repos.inboxes.deleteInbox(row.id)).toBe(true);
    expect(repos.inboxes.deleteInbox(row.id)).toBe(false);
    expect(repos.inboxes.findInboxById(row.id)).toBeUndefined();
  });

  it('listExpired returns only rows with expires_at < cutoff, ordered ascending', () => {
    const { repos } = openTestDbWithRepos();
    for (let i = 1; i <= 5; i += 1) {
      repos.inboxes.createInbox({
        local_part: `lp${i}`,
        domain: 'd.test',
        view_token_hash: 'h',
        expires_at: i * 1000,
        hard_expires_at: 10_000_000,
      });
    }
    const expired = repos.inboxes.listExpired(3500, 10);
    expect(expired.map((r) => r.local_part)).toEqual(['lp1', 'lp2', 'lp3']);
  });
});
