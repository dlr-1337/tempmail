/**
 * Phase 5 test harness — builds a full HTTP rig (core + attachment store +
 * app) against an in-memory DB and a per-test temp directory for attachments.
 *
 * `buildTestRig()` returns `{ app, core, attachmentStore, close }`. Always
 * call `close()` in afterEach — it shuts the Fastify app, closes the db,
 * and rm-rf's the tmp dir.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type AttachmentStore, createAttachmentStore } from '../../src/attachments/index.js';
import { type CoreApi, createCore } from '../../src/core/index.js';
import { type HttpServerConfig, createHttpServer } from '../../src/http/server.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

export interface TestRig {
  app: FastifyInstance;
  core: CoreApi;
  attachmentStore: AttachmentStore;
  close: () => Promise<void>;
}

export interface BuildTestRigOptions {
  config?: Partial<HttpServerConfig>;
  /** If true (default), awaits `app.ready()`. Set false when the test needs
   *  to attach additional routes before boot. */
  ready?: boolean;
}

export async function buildTestRig(opts: BuildTestRigOptions = {}): Promise<TestRig> {
  const attachmentDir = mkdtempSync(join(tmpdir(), 'tempmail-http-'));
  const { db, repos } = openTestDbWithRepos();
  const attachmentStore = createAttachmentStore(attachmentDir);
  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: { domain: 'example.test', idleTtlMs: 10 * 60_000, hardTtlMs: 60 * 60_000 },
  });
  const app = await createHttpServer({
    core,
    attachmentStore,
    config: {
      cookieSecret: 'test-cookie-secret',
      hardTtlMs: 60 * 60_000,
      trustProxy: false,
      ...opts.config,
    },
  });
  if (opts.ready !== false) await app.ready();
  return {
    app,
    core,
    attachmentStore,
    close: async () => {
      await app.close();
      db.close();
      rmSync(attachmentDir, { recursive: true, force: true });
    },
  };
}
