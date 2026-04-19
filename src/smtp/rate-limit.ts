/**
 * Token-bucket rate limiter keyed on sender IP prefix (D-21).
 *
 * In-memory Map of `{ tokens, lastRefillMs }` per prefix. Amortized cleanup
 * drops entries untouched for > 10 minutes when the map grows past 10_000
 * keys. Pure function body + injected `now()` — trivially testable.
 *
 * On `take()` returning `false`, the caller (plan 04-03's onRcptTo) responds
 * 452 and bumps the `abuse_counters` row (D-23).
 */

import type { SmtpRateLimitConfig } from './config.js';

export interface RateLimiterDeps {
  config: SmtpRateLimitConfig;
  /** Injectable clock for determinism in tests. */
  now: () => number;
}

export interface RateLimiter {
  /** Try to consume 1 token from the prefix's bucket. Returns true on success. */
  take(prefix: string): boolean;
  /** Diagnostics: current map size (not for production use). */
  size(): number;
  /** Diagnostics: token count for a prefix (or 0 if absent). */
  peek(prefix: string): number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastTouchedMs: number;
}

const STALE_MS = 10 * 60 * 1_000;
const CLEANUP_THRESHOLD = 10_000;

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const { config, now } = deps;
  const buckets = new Map<string, Bucket>();
  // Refill math: `tokensPerMinute` tokens per 60_000 ms, i.e. t/60_000 tokens/ms.
  const tokensPerMs = config.tokensPerMinute / 60_000;

  const refill = (bucket: Bucket, nowMs: number): void => {
    const elapsed = nowMs - bucket.lastRefillMs;
    if (elapsed <= 0) return;
    const added = elapsed * tokensPerMs;
    bucket.tokens = Math.min(config.burst, bucket.tokens + added);
    bucket.lastRefillMs = nowMs;
  };

  const take = (prefix: string): boolean => {
    const nowMs = now();
    let bucket = buckets.get(prefix);
    if (!bucket) {
      bucket = { tokens: config.burst, lastRefillMs: nowMs, lastTouchedMs: nowMs };
      buckets.set(prefix, bucket);
    } else {
      refill(bucket, nowMs);
      bucket.lastTouchedMs = nowMs;
    }

    // Amortized cleanup: only scan when the map grows large.
    if (buckets.size > CLEANUP_THRESHOLD) {
      for (const [key, b] of buckets) {
        if (nowMs - b.lastTouchedMs > STALE_MS) buckets.delete(key);
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  };

  const size = (): number => buckets.size;

  const peek = (prefix: string): number => buckets.get(prefix)?.tokens ?? 0;

  return { take, size, peek };
}

/**
 * Normalize a sender IP to a `/24` (IPv4) or `/64` (IPv6) prefix string.
 *
 * Examples:
 *   "203.0.113.45" → "203.0.113.0/24"
 *   "::ffff:203.0.113.45" → "203.0.113.0/24"  (IPv4-mapped)
 *   "2001:db8::1" → "2001:db8:0:0::/64"
 *   "weird-thing" → "weird-thing"  (unknown → passthrough so buckets still isolate)
 */
export function ipPrefix(ip: string): string {
  // IPv4-mapped IPv6 → treat as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1] : isIPv4(ip) ? ip : null;
  if (v4) {
    const parts = v4.split('.');
    if (parts.length !== 4) return ip;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }

  if (isIPv6(ip)) {
    const groups = expandIPv6(ip);
    if (groups.length >= 4) {
      return `${groups.slice(0, 4).join(':')}:0:0:0:0/64`;
    }
    return ip;
  }

  return ip;
}

function isIPv4(s: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(s)) return false;
  return s
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .every((n) => n >= 0 && n <= 255);
}

function isIPv6(s: string): boolean {
  // Rough-but-sufficient: at least one colon, hex digits, optional `::`
  return /^[0-9a-f:]+$/i.test(s) && s.includes(':');
}

function expandIPv6(s: string): string[] {
  const lower = s.toLowerCase();
  // Expand the `::` shorthand
  const parts = lower.split('::');
  if (parts.length > 2) return [];
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return [];
  const fill = parts.length === 2 ? Array<string>(missing).fill('0') : [];
  return [...left, ...fill, ...right].map((g) => g || '0');
}
