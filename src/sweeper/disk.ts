/**
 * Disk watermark circuit breaker (Plan 06-04, RETN-04).
 *
 * Polls `fs.statfs()` against the attachment-store root every 30s (scheduled
 * by `sweeper.ts`) and publishes the current state via `DiskProbe.get()`.
 * SMTP and HTTP adapters pull state on the hot path and return 452 / 503 when
 * the watermark is breached (see `isAcceptingMail` / `isAcceptingNewInboxes`).
 *
 * Gotchas addressed here:
 *   - `fs.statfs` exists on Node 18.15+ but the Windows build returns slightly
 *     different fields; we compute `percentUsed` from `(blocks-bavail)/blocks`
 *     which is stable across platforms.
 *   - If `statfs` throws (very-old Node or missing permission), we return a
 *     SAFE DEFAULT (`status: 'normal'`, `percentUsed: 0`) and warn ONCE. The
 *     circuit breaker defaults to "open" — accept traffic — rather than
 *     false-positive refusing deliveries.
 */

import type { StatsFs } from 'node:fs';
import { statfs } from 'node:fs/promises';

import type { SweeperDiskConfig, SweeperLogger } from './sweeper.js';

export type DiskStatus = 'normal' | 'high' | 'critical';

export interface DiskState {
  /** Floor'd integer percent [0..100]. `0` when probe has never succeeded. */
  percentUsed: number;
  /** Bytes free. `-1` when unknown (probe failure / not yet refreshed). */
  bytesFree: number;
  /** Bytes total. `-1` when unknown. */
  bytesTotal: number;
  /** Epoch ms of the last successful refresh. `0` if never. */
  updatedAt: number;
  /** Computed status — derived from `percentUsed` + config thresholds. */
  status: DiskStatus;
}

export interface DiskProbe {
  /** Last known state. Returns synthetic `{ status: 'normal' }` before first refresh. */
  get(): DiskState;
  /** Probe the filesystem now. Resolves with the NEW state (never rejects). */
  refresh(): Promise<DiskState>;
}

/** Signature of the stubbable `statfs` call. */
export type StatfsFn = (path: string) => Promise<StatsFs>;

export interface DiskProbeDeps {
  rootDir: string;
  logger: SweeperLogger;
  now: () => number;
  config?: SweeperDiskConfig;
  /** Injectable statfs for tests (D-14..D-16 transition assertions). */
  statfs?: StatfsFn;
}

const DEFAULT_HIGH = 80;
const DEFAULT_CRITICAL = 90;

export function createDiskProbe(deps: DiskProbeDeps): DiskProbe {
  const highPct = deps.config?.highWatermarkPct ?? DEFAULT_HIGH;
  const criticalPct = deps.config?.criticalWatermarkPct ?? DEFAULT_CRITICAL;
  const statfsFn = deps.statfs ?? statfs;

  let state: DiskState = {
    percentUsed: 0,
    bytesFree: -1,
    bytesTotal: -1,
    updatedAt: 0,
    status: 'normal',
  };
  let warnedOnce = false;
  let lastStatus: DiskStatus = 'normal';

  const computeStatus = (percent: number): DiskStatus => {
    if (percent >= criticalPct) return 'critical';
    if (percent >= highPct) return 'high';
    return 'normal';
  };

  async function refresh(): Promise<DiskState> {
    try {
      const s = await statfsFn(deps.rootDir);
      // Block-size math — `bsize` is "block size", `blocks` total, `bavail`
      // free to the current user. These fields are present on Linux, macOS,
      // and Windows. We compute bytes from them to keep the shape stable.
      const blocks = Number(s.blocks);
      const bavail = Number(s.bavail);
      const bsize = Number(s.bsize);
      const bytesTotal = blocks * bsize;
      const bytesFree = bavail * bsize;
      const percentUsed =
        blocks > 0 ? Math.max(0, Math.min(100, Math.floor(((blocks - bavail) / blocks) * 100))) : 0;
      const status = computeStatus(percentUsed);

      state = {
        percentUsed,
        bytesFree,
        bytesTotal,
        updatedAt: deps.now(),
        status,
      };

      // Log on transitions — a single line per change keeps noise low while
      // giving operators the signal they need for post-hoc triage.
      if (status !== lastStatus) {
        deps.logger.info(
          {
            event: 'sweeper.disk.transition',
            from: lastStatus,
            to: status,
            percent_used: percentUsed,
            updated_at: state.updatedAt,
          },
          'sweeper.disk.transition',
        );
        lastStatus = status;
      }
      return state;
    } catch (err) {
      // Graceful degradation: keep last-known state (or synthetic default).
      if (!warnedOnce) {
        deps.logger.warn(
          {
            event: 'sweeper.disk.probe_failed',
            error: err instanceof Error ? err.message : String(err),
          },
          'sweeper.disk.probe_failed',
        );
        warnedOnce = true;
      }
      return state;
    }
  }

  return {
    get: () => state,
    refresh,
  };
}

/** True when SMTP should continue accepting DATA. (false at `high` and above.) */
export function isAcceptingMail(state: DiskState): boolean {
  return state.status === 'normal';
}

/** True when HTTP should continue minting new inboxes. (false only at `critical`.) */
export function isAcceptingNewInboxes(state: DiskState): boolean {
  return state.status !== 'critical';
}
