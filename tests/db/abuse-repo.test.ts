import { describe, expect, it } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.js';

describe('abuseRepo (STORE-04)', () => {
  it('incrementCounter UPSERTs and returns running count', () => {
    const { repos } = openTestDbWithRepos();
    expect(repos.abuse.incrementCounter('1.2.3.0/24', 'inbox_create', 60000)).toBe(1);
    expect(repos.abuse.incrementCounter('1.2.3.0/24', 'inbox_create', 60000)).toBe(2);
    expect(repos.abuse.incrementCounter('1.2.3.0/24', 'inbox_create', 60000)).toBe(3);
  });

  it('getCounter returns 0 for missing keys', () => {
    const { repos } = openTestDbWithRepos();
    expect(repos.abuse.getCounter('9.9.9.0/24', 'msg_read', 0)).toBe(0);
  });

  it('different (prefix, bucket, window) triples are independent', () => {
    const { repos } = openTestDbWithRepos();
    repos.abuse.incrementCounter('a', 'x', 100);
    repos.abuse.incrementCounter('a', 'x', 200); // different window
    repos.abuse.incrementCounter('a', 'y', 100); // different bucket
    repos.abuse.incrementCounter('b', 'x', 100); // different prefix
    expect(repos.abuse.getCounter('a', 'x', 100)).toBe(1);
    expect(repos.abuse.getCounter('a', 'x', 200)).toBe(1);
    expect(repos.abuse.getCounter('a', 'y', 100)).toBe(1);
    expect(repos.abuse.getCounter('b', 'x', 100)).toBe(1);
  });

  it('pruneOldCounters deletes only rows with window_start < cutoff', () => {
    const { repos } = openTestDbWithRepos();
    repos.abuse.incrementCounter('a', 'x', 100);
    repos.abuse.incrementCounter('a', 'x', 200);
    repos.abuse.incrementCounter('a', 'x', 300);
    const deleted = repos.abuse.pruneOldCounters(250);
    expect(deleted).toBe(2);
    expect(repos.abuse.getCounter('a', 'x', 100)).toBe(0);
    expect(repos.abuse.getCounter('a', 'x', 200)).toBe(0);
    expect(repos.abuse.getCounter('a', 'x', 300)).toBe(1);
  });
});
