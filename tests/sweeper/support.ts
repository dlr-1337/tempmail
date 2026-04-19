/**
 * Phase 6 sweeper test harness.
 *
 * Produces a full wiring of core + real attachment store + repos + sweeper
 * with an in-memory DB and a per-test tmpdir for attachments. Accepts an
 * injected clock so time-dependent tests can advance TTLs deterministically.
 *
 * A capturing pino-like logger is included so invariant / whitelist
 * assertions can grep emitted log events.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttachmentStore, createAttachmentStore } from '../../src/attachments/index.js';
import { type CoreApi, createCore } from '../../src/core/index.js';
import type { Repos } from '../../src/db/repos/index.js';
import {
  type SweeperConfig,
  type SweeperHandle,
  type SweeperLogger,
  createSweeper,
} from '../../src/sweeper/index.js';
import type { StatfsFn } from '../../src/sweeper/index.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

export interface CapturedLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  obj: Record<string, unknown>;
  msg?: string;
}

export interface SweeperRig {
  core: CoreApi;
  repos: Repos;
  attachmentStore: AttachmentStore;
  sweeper: SweeperHandle;
  captured: CapturedLog[];
  /** Get/set the virtual clock used by core + sweeper. */
  now: () => number;
  setNow: (ms: number) => void;
  close: () => void;
}

export interface BuildRigOptions {
  initialNowMs?: number;
  idleTtlMs?: number;
  hardTtlMs?: number;
  config?: SweeperConfig;
  statfs?: StatfsFn;
}

export function buildSweeperRig(options: BuildRigOptions = {}): SweeperRig {
  const dir = mkdtempSync(join(tmpdir(), 'tempmail-sweep-'));
  const { db, repos } = openTestDbWithRepos();
  const attachmentStore = createAttachmentStore(dir);

  let current = options.initialNowMs ?? 1_700_000_000_000;
  const now = (): number => current;
  const setNow = (ms: number): void => {
    current = ms;
  };

  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: {
      domain: 'example.test',
      idleTtlMs: options.idleTtlMs ?? 10 * 60_000,
      hardTtlMs: options.hardTtlMs ?? 60 * 60_000,
    },
    now,
  });

  const captured: CapturedLog[] = [];
  const logger: SweeperLogger = {
    info(obj, msg) {
      captured.push({ level: 'info', obj: obj as Record<string, unknown>, msg });
    },
    warn(obj, msg) {
      captured.push({ level: 'warn', obj: obj as Record<string, unknown>, msg });
    },
    error(obj, msg) {
      captured.push({ level: 'error', obj: obj as Record<string, unknown>, msg });
    },
    debug(obj, msg) {
      captured.push({ level: 'debug', obj: obj as Record<string, unknown>, msg });
    },
  };

  const sweeper = createSweeper({
    core,
    repos,
    attachmentStore,
    logger,
    now,
    config: options.config,
    statfs: options.statfs,
  });

  return {
    core,
    repos,
    attachmentStore,
    sweeper,
    captured,
    now,
    setNow,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
