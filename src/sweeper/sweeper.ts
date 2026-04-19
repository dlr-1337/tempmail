/**
 * Phase 6 sweeper factory (D-01, D-02, D-03, D-04).
 *
 * Composes three periodic jobs into a single handle:
 *   - expire sweep (every 60s)    — `runExpireSweep` from `./expire.ts`
 *   - orphan reaper (every 1h)    — `runOrphanReaper` from `./reaper.ts`
 *   - disk probe (every 30s)      — `probe.refresh()` from `./disk.ts`
 *
 * Design pillars:
 *   - D-02  Factory + DI consistent with Core/SMTP/HTTP. Deps injected; never
 *           reaches into global state.
 *   - D-03  `start()` schedules the three intervals; `stop()` clears them and
 *           awaits any in-flight run.
 *   - D-04  Re-entrancy guard: a boolean flag per job; if still running, skip
 *           the tick and log once so slow expiries never pile up.
 *
 * Public API exposed via `SweeperHandle`:
 *   - `start()` / `stop()`            idempotent start/stop
 *   - `runOnce(job)`                  deterministic trigger for tests
 *   - `diskState()`                   getter consumed by SMTP/HTTP adapters
 */

import type { AttachmentStore } from '../attachments/index.js';
import type { CoreApi } from '../core/index.js';
import type { Repos } from '../db/repos/index.js';
import { nowMs } from '../util/now.js';
import {
  type DiskProbe,
  type DiskState,
  type StatfsFn,
  createDiskProbe,
} from './disk.js';
import { type ExpireResult, runExpireSweep } from './expire.js';
import { type ReaperResult, runOrphanReaper } from './reaper.js';

/** Minimal pino-shaped logger. Narrowed to the shapes the sweeper actually calls. */
export interface SweeperLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
}

export interface SweeperDiskConfig {
  /** Percent used at which SMTP starts returning 452 (default 80). */
  highWatermarkPct?: number;
  /** Percent used at which HTTP inbox-mint returns 503 (default 90). */
  criticalWatermarkPct?: number;
}

export interface SweeperConfig {
  /**
   * Max rows to read per `listExpired` page. Defaults to 500 — large enough
   * that the sweep typically completes in one round, small enough that a
   * single bad DB state won't block the loop forever.
   */
  expireBatchSize?: number;
  /** Safety cap on files touched by a single reaper tick (D-10). */
  reaperMaxPerRun?: number;
  /** Disk watermark thresholds. */
  disk?: SweeperDiskConfig;
  /** Override interval lengths in ms. Defaults per D-03. */
  intervals?: {
    expireMs?: number;
    reaperMs?: number;
    diskMs?: number;
  };
}

export interface SweeperDeps {
  core: CoreApi;
  repos: Repos;
  attachmentStore: AttachmentStore;
  logger: SweeperLogger;
  config?: SweeperConfig;
  /** Injectable clock for determinism in tests. Defaults to `nowMs`. */
  now?: () => number;
  /** Injectable id generator for tick_ids in log lines. Defaults to a monotonic counter. */
  nextTickId?: () => string;
  /**
   * Optional statfs injection for `disk.ts` tests that need to simulate
   * watermark transitions without writing to disk.
   */
  statfs?: StatfsFn;
}

export type SweeperJob = 'expire' | 'reaper' | 'disk' | 'all';

export interface SweeperHandle {
  /** Start all three intervals. Idempotent — calling twice is a no-op. */
  start(): void;
  /** Stop all intervals and await any in-flight job runs. Idempotent. */
  stop(): Promise<void>;
  /**
   * Manually trigger one or all jobs. Used by tests + by Phase 8 admin tools
   * that want a one-off sweep. Respects the re-entrancy guard: if the
   * scheduled interval is currently mid-run, `runOnce` for that job awaits
   * the in-flight promise and returns its result instead of starting a new
   * run.
   */
  runOnce(job?: SweeperJob): Promise<RunOnceResult>;
  /** Current disk state snapshot (never throws). */
  diskState(): DiskState;
  /** Exposed for testing composition. */
  readonly diskProbe: DiskProbe;
}

export type RunOnceResult = {
  expire?: ExpireResult;
  reaper?: ReaperResult;
  disk?: DiskState;
};

// Default intervals per D-03.
const DEFAULT_EXPIRE_MS = 60_000;
const DEFAULT_REAPER_MS = 3_600_000;
const DEFAULT_DISK_MS = 30_000;

export function createSweeper(deps: SweeperDeps): SweeperHandle {
  const now = deps.now ?? nowMs;
  const nextTickId = deps.nextTickId ?? makeMonotonicTickId();
  const cfg = deps.config ?? {};
  const intervals = cfg.intervals ?? {};
  const expireMs = intervals.expireMs ?? DEFAULT_EXPIRE_MS;
  const reaperMs = intervals.reaperMs ?? DEFAULT_REAPER_MS;
  const diskMs = intervals.diskMs ?? DEFAULT_DISK_MS;

  const diskProbe = createDiskProbe({
    rootDir: deps.attachmentStore.rootDir,
    logger: deps.logger,
    now,
    config: cfg.disk,
    statfs: deps.statfs,
  });

  // Re-entrancy guards per D-04. Each holds the in-flight promise while a
  // run is active (null otherwise). The interval tick checks this before
  // starting a new run; `runOnce` reuses it so tests don't double-fire.
  let expireInFlight: Promise<ExpireResult> | null = null;
  let reaperInFlight: Promise<ReaperResult> | null = null;
  let diskInFlight: Promise<DiskState> | null = null;

  const guardedExpire = (): Promise<ExpireResult> => {
    if (expireInFlight) {
      deps.logger.info({ event: 'sweeper.tick_skipped', job: 'expire' }, 'sweeper.skip');
      return expireInFlight;
    }
    const p = runExpireSweep({
      core: deps.core,
      repos: deps.repos,
      logger: deps.logger,
      now,
      tickId: nextTickId(),
      batchSize: cfg.expireBatchSize,
    }).finally(() => {
      expireInFlight = null;
    });
    expireInFlight = p;
    return p;
  };

  const guardedReaper = (): Promise<ReaperResult> => {
    if (reaperInFlight) {
      deps.logger.info({ event: 'sweeper.tick_skipped', job: 'reaper' }, 'sweeper.skip');
      return reaperInFlight;
    }
    const p = runOrphanReaper({
      attachmentStore: deps.attachmentStore,
      repos: deps.repos,
      logger: deps.logger,
      now,
      tickId: nextTickId(),
      maxPerRun: cfg.reaperMaxPerRun,
    }).finally(() => {
      reaperInFlight = null;
    });
    reaperInFlight = p;
    return p;
  };

  const guardedDisk = (): Promise<DiskState> => {
    if (diskInFlight) {
      deps.logger.info({ event: 'sweeper.tick_skipped', job: 'disk' }, 'sweeper.skip');
      return diskInFlight;
    }
    const p = diskProbe.refresh().finally(() => {
      diskInFlight = null;
    });
    diskInFlight = p;
    return p;
  };

  // Fire-and-forget wrappers for use from `setInterval`. We swallow errors and
  // log them — a thrown promise in a timer callback would otherwise surface
  // as an unhandledRejection and crash the process.
  const fireExpire = (): void => {
    guardedExpire().catch((err) =>
      deps.logger.error({ err: stringifyErr(err) }, 'sweeper.expire.error'),
    );
  };
  const fireReaper = (): void => {
    guardedReaper().catch((err) =>
      deps.logger.error({ err: stringifyErr(err) }, 'sweeper.reaper.error'),
    );
  };
  const fireDisk = (): void => {
    guardedDisk().catch((err) =>
      deps.logger.error({ err: stringifyErr(err) }, 'sweeper.disk.error'),
    );
  };

  let expireTimer: NodeJS.Timeout | null = null;
  let reaperTimer: NodeJS.Timeout | null = null;
  let diskTimer: NodeJS.Timeout | null = null;

  const handle: SweeperHandle = {
    start(): void {
      if (expireTimer || reaperTimer || diskTimer) return; // idempotent
      expireTimer = setInterval(fireExpire, expireMs);
      reaperTimer = setInterval(fireReaper, reaperMs);
      diskTimer = setInterval(fireDisk, diskMs);
      // `unref` so the timers don't keep the process alive on their own.
      expireTimer.unref?.();
      reaperTimer.unref?.();
      diskTimer.unref?.();
    },
    async stop(): Promise<void> {
      if (expireTimer) {
        clearInterval(expireTimer);
        expireTimer = null;
      }
      if (reaperTimer) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }
      if (diskTimer) {
        clearInterval(diskTimer);
        diskTimer = null;
      }
      // Await any in-flight runs so callers who `stop()` can rely on no more
      // log lines or DB writes after the returned promise resolves.
      const pending: Array<Promise<unknown>> = [];
      if (expireInFlight) pending.push(expireInFlight);
      if (reaperInFlight) pending.push(reaperInFlight);
      if (diskInFlight) pending.push(diskInFlight);
      await Promise.allSettled(pending);
    },
    async runOnce(job: SweeperJob = 'all'): Promise<RunOnceResult> {
      const result: RunOnceResult = {};
      if (job === 'all' || job === 'expire') {
        result.expire = await guardedExpire();
      }
      if (job === 'all' || job === 'reaper') {
        result.reaper = await guardedReaper();
      }
      if (job === 'all' || job === 'disk') {
        result.disk = await guardedDisk();
      }
      return result;
    },
    diskState(): DiskState {
      return diskProbe.get();
    },
    diskProbe,
  };

  return handle;
}

/** Monotonic-ish tick ids used only as a correlation handle in log lines. */
function makeMonotonicTickId(): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return `tick-${Date.now()}-${seq}`;
  };
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
