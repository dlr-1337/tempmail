/**
 * Integration-test harness for the Phase 4 SMTP server.
 *
 * Starts a real `createSmtpServer` on an ephemeral port with:
 *   - In-memory SQLite + real Core (no mocks)
 *   - Real content-addressed attachment store on a per-test tmp dir
 *   - Dev-only self-signed TLS cert (so STARTTLS tests work without real CA)
 *   - A capturing pino-like logger whose emissions are retained in an array
 *     for PII-safe grep assertions
 *
 * Returned `close()` tears down the server, DB, and tmp dir.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '../../../src/attachments/index.js';
import { type CoreConfig, createCore } from '../../../src/core/index.js';
import { openDb } from '../../../src/db/client.js';
import { type Repos, createRepos } from '../../../src/db/repos/index.js';
import {
  type SmtpConfig,
  type SmtpPinoLike,
  type SmtpServerHandle,
  createSmtpServer,
} from '../../../src/smtp/index.js';

export interface CapturedLogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  obj: Record<string, unknown>;
  msg?: string;
}

export interface SmtpTestHarness {
  port: number;
  server: SmtpServerHandle;
  core: ReturnType<typeof createCore>;
  /** Exposed so tests can assert on `abuse_counters` directly (D-23). */
  repos: Repos;
  config: SmtpConfig;
  captured: CapturedLogEntry[];
  /** Force a clock for determinism. Change the return value any time; the
   *  server reads it on each call. */
  setNow: (ms: number) => void;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  domain?: string;
  maxMessageBytes?: number;
  tokensPerMinute?: number;
  burst?: number;
  /** Override the initial timestamp for the injected clock. */
  initialNowMs?: number;
}

export async function buildHarness(options: HarnessOptions = {}): Promise<SmtpTestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'tempmail-smtp-'));

  const db = openDb(':memory:');
  const repos = createRepos(db);
  const attachmentStore = createAttachmentStore(dir);

  const coreConfig: CoreConfig = {
    domain: options.domain ?? 'tempmail.local',
    idleTtlMs: 10 * 60 * 1_000,
    hardTtlMs: 60 * 60 * 1_000,
  };
  const core = createCore({ db, repos, attachmentStore, config: coreConfig });

  const config: SmtpConfig = {
    port: 0,
    hostname: '127.0.0.1',
    domain: coreConfig.domain,
    maxMessageBytes: options.maxMessageBytes ?? 10 * 1_024 * 1_024,
    tls: { devGenerateSelfSigned: true },
    rateLimit: {
      tokensPerMinute: options.tokensPerMinute ?? 10,
      burst: options.burst ?? 20,
    },
    timeouts: { socketMs: 60_000, closeMs: 30_000 },
    piiLogSalt: 'test-salt-sufficiently-long',
  };

  const captured: CapturedLogEntry[] = [];
  const logger: SmtpPinoLike = {
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

  let currentNow = options.initialNowMs ?? Date.now();
  const now = (): number => currentNow;
  const setNow = (ms: number): void => {
    currentNow = ms;
  };

  const server = await createSmtpServer({
    core,
    attachmentStore,
    abuseRepo: repos.abuse,
    config,
    logger,
    now,
  });

  const port = await server.listen();

  return {
    port,
    server,
    core,
    repos,
    config,
    captured,
    setNow,
    async close() {
      await server.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
