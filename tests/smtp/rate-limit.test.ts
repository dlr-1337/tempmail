/**
 * Unit coverage for the token-bucket rate limiter and the IP-prefix helper
 * (Phase 4 CONTEXT D-21).
 */

import { describe, expect, it } from 'vitest';
import { createRateLimiter, ipPrefix } from '../../src/smtp/rate-limit.js';

describe('ipPrefix', () => {
  it('normalizes IPv4 to /24', () => {
    expect(ipPrefix('203.0.113.45')).toBe('203.0.113.0/24');
    expect(ipPrefix('192.168.1.1')).toBe('192.168.1.0/24');
  });

  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(ipPrefix('::ffff:203.0.113.45')).toBe('203.0.113.0/24');
  });

  it('normalizes IPv6 to /64', () => {
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0:0:0:0:0:0/64');
  });

  it('passes unknown inputs through unchanged', () => {
    expect(ipPrefix('weird-thing')).toBe('weird-thing');
  });
});

describe('createRateLimiter', () => {
  it('permits up to `burst` takes back-to-back, then blocks', () => {
    const now = 0;
    const limiter = createRateLimiter({
      config: { tokensPerMinute: 10, burst: 3 },
      now: () => now,
    });
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('refills tokens based on elapsed wall-clock time', () => {
    let now = 0;
    const limiter = createRateLimiter({
      config: { tokensPerMinute: 60, burst: 2 },
      now: () => now,
    });
    // Drain the bucket.
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);

    // 60/minute = 1/sec; advance 1000ms → should regain 1 token.
    now = 1_000;
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('isolates buckets per prefix key', () => {
    const now = 0;
    const limiter = createRateLimiter({
      config: { tokensPerMinute: 1, burst: 1 },
      now: () => now,
    });
    expect(limiter.take('alpha')).toBe(true);
    expect(limiter.take('alpha')).toBe(false);
    // Different key has its own bucket.
    expect(limiter.take('beta')).toBe(true);
  });

  it('peek reports remaining tokens without consuming', () => {
    const now = 0;
    const limiter = createRateLimiter({
      config: { tokensPerMinute: 10, burst: 5 },
      now: () => now,
    });
    limiter.take('x');
    limiter.take('x');
    expect(limiter.peek('x')).toBeGreaterThan(2.9);
    expect(limiter.peek('x')).toBeLessThan(3.1);
  });
});
