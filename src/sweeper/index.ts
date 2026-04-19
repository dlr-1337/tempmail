/**
 * Public barrel for the Phase 6 retention sweeper.
 *
 * External callers (the process entrypoint, integration tests, Phase 8
 * composition) import from `./sweeper` and never reach into the internal
 * `expire.ts`, `reaper.ts`, `disk.ts` modules directly.
 */

export {
  createSweeper,
  type SweeperConfig,
  type SweeperDeps,
  type SweeperDiskConfig,
  type SweeperHandle,
  type SweeperJob,
  type SweeperLogger,
  type RunOnceResult,
} from './sweeper.js';

export {
  createDiskProbe,
  isAcceptingMail,
  isAcceptingNewInboxes,
  type DiskProbe,
  type DiskState,
  type DiskStatus,
  type StatfsFn,
} from './disk.js';

export { runExpireSweep, type ExpireResult } from './expire.js';
export { runOrphanReaper, type ReaperResult } from './reaper.js';
