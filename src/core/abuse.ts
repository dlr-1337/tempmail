/**
 * Phase 5 hook: record 429 / rate-limit trips into abuse_counters via the
 * existing Phase 2 repo. Scoped by (ipPrefix, bucket, window_start), where
 * window_start is a 60s-floored timestamp.
 *
 * No direct DB / fs access — all persistence flows through deps.repos.abuse
 * (D-03). The HTTP layer builds ipPrefix + bucket and calls core.recordAbuse.
 */

import type { Repos } from '../db/repos/index.js';
import { nowMs } from '../util/now.js';

/** 60s window floor — single source of truth for abuse bucketing. */
export const ABUSE_WINDOW_MS = 60_000;

export const currentAbuseWindow = (now: number = nowMs()): number =>
  Math.floor(now / ABUSE_WINDOW_MS) * ABUSE_WINDOW_MS;

export interface RecordAbuseInput {
  /** e.g. `203.0.113.0/24` or `2001:db8:abcd:0/64`. Never a full address. */
  ipPrefix: string;
  /** Short tag: 'mint' | 'read' | 'stream' | 'attach' | 'meta' | 'other'. */
  bucket: string;
}

export interface AbuseApi {
  /** Returns the counter's new value after the increment. */
  recordAbuse(input: RecordAbuseInput): number;
}

export interface AbuseDeps {
  repos: Repos;
  /** Override clock for determinism in tests. Defaults to `nowMs`. */
  now?: () => number;
}

export function createAbuse(deps: AbuseDeps): AbuseApi {
  const now = deps.now ?? nowMs;
  return {
    recordAbuse({ ipPrefix, bucket }) {
      return deps.repos.abuse.incrementCounter(ipPrefix, bucket, currentAbuseWindow(now()));
    },
  };
}
