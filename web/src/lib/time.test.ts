import { describe, expect, it } from 'vitest';
import { formatBytes, formatMmSs, formatRelative } from './time.js';

describe('formatMmSs', () => {
  it('formats full minute and second', () => {
    expect(formatMmSs(90_000)).toBe('01:30');
    expect(formatMmSs(0)).toBe('00:00');
    expect(formatMmSs(59_000)).toBe('00:59');
    expect(formatMmSs(3_600_000)).toBe('60:00');
  });

  it('clamps negatives to 00:00', () => {
    expect(formatMmSs(-5_000)).toBe('00:00');
  });
});

describe('formatRelative', () => {
  const base = new Date('2026-04-18T12:00:00Z').getTime();

  it('returns "just now" for <5s deltas', () => {
    const iso = new Date(base - 2_000).toISOString();
    expect(formatRelative(iso, base)).toBe('just now');
  });

  it('returns seconds', () => {
    const iso = new Date(base - 10_000).toISOString();
    expect(formatRelative(iso, base)).toBe('10s ago');
  });

  it('returns minutes', () => {
    const iso = new Date(base - 5 * 60_000).toISOString();
    expect(formatRelative(iso, base)).toBe('5m ago');
  });

  it('returns hours', () => {
    const iso = new Date(base - 2 * 3_600_000).toISOString();
    expect(formatRelative(iso, base)).toBe('2h ago');
  });

  it('empty on invalid iso', () => {
    expect(formatRelative('not-a-date')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats scales', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
  });
});
