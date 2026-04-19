/**
 * Plan 06-04 — HTTP mint gate + healthz augmentation.
 *
 * Uses Fastify's in-process `inject()` with a stubbed `diskState` getter to
 * drive the gate. We deliberately DON'T spin up a real disk probe; the
 * probe is unit-tested in `disk.test.ts`, here we care only that the route
 * consults the getter and maps status→HTTP correctly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { createCore } from '../../src/core/index.js';
import { createHttpServer } from '../../src/http/server.js';
import type { DiskState } from '../../src/sweeper/index.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

async function build(): Promise<{
  app: FastifyInstance;
  setDisk: (s: DiskState) => void;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'tempmail-diskhttp-'));
  const { db, repos } = openTestDbWithRepos();
  const attachmentStore = createAttachmentStore(dir);
  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: { domain: 'example.test', idleTtlMs: 10 * 60_000, hardTtlMs: 60 * 60_000 },
  });
  let current: DiskState = {
    percentUsed: 10,
    bytesFree: 100,
    bytesTotal: 1000,
    updatedAt: Date.now(),
    status: 'normal',
  };
  const app = await createHttpServer({
    core,
    attachmentStore,
    config: {
      cookieSecret: 'test-cookie-secret',
      hardTtlMs: 60 * 60_000,
      trustProxy: false,
    },
    diskState: () => current,
  });
  await app.ready();
  return {
    app,
    setDisk: (s) => {
      current = s;
    },
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const baseState = (status: DiskState['status'], percent: number): DiskState => ({
  percentUsed: percent,
  bytesFree: 100,
  bytesTotal: 1000,
  updatedAt: Date.now(),
  status,
});

describe('HTTP mint gate (06-04 / RETN-04)', () => {
  let rig: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    rig = await build();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('POST /api/inbox returns 201 when disk is normal', async () => {
    rig.setDisk(baseState('normal', 10));
    const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(r.statusCode).toBe(201);
  });

  it('POST /api/inbox returns 201 when disk is high (but NOT critical)', async () => {
    rig.setDisk(baseState('high', 85));
    const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(r.statusCode).toBe(201);
  });

  it('POST /api/inbox returns 503 unavailable when disk is critical', async () => {
    rig.setDisk(baseState('critical', 95));
    const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(r.statusCode).toBe(503);
    const body = r.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unavailable');
  });

  it('GET /healthz returns 200 with disk info when state is provided', async () => {
    rig.setDisk(baseState('high', 85));
    const r = await rig.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; disk: { percentUsed: number; status: string } };
    expect(body.status).toBe('degraded');
    expect(body.disk.status).toBe('high');
    expect(body.disk.percentUsed).toBe(85);
  });

  it('GET /healthz returns 200 ok when disk is normal', async () => {
    rig.setDisk(baseState('normal', 20));
    const r = await rig.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; disk: { status: string } };
    expect(body.status).toBe('ok');
  });
});
