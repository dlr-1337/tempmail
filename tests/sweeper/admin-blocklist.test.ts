/**
 * Plan 06-05 — admin blocklist endpoint tests.
 *
 *   - 204 when called via loopback with a valid inboxId
 *   - 204 when called with `address` → core lookup resolves → expired
 *   - 404 when inbox doesn't exist
 *   - 400 when neither `address` nor `inboxId` provided
 *   - 403 when simulated non-loopback IP
 *   - log line contains only whitelisted fields
 *   - not registered when config.admin.enabled is false/absent
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pinoLib, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { type CoreApi, createCore } from '../../src/core/index.js';
import { createHttpServer } from '../../src/http/server.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

// Pino writes newline-delimited JSON to the provided destination. Each `write`
// call is one full log line.
function makeCapturingLogger(): { logger: Logger; captured: unknown[] } {
  const captured: unknown[] = [];
  const destination = {
    write(chunk: string): void {
      try {
        captured.push(JSON.parse(chunk));
      } catch {
        captured.push(chunk);
      }
    },
  };
  const logger: Logger = pinoLib({ level: 'info' }, destination);
  return { logger, captured };
}

interface AdminRig {
  app: FastifyInstance;
  core: CoreApi;
  captured: unknown[];
  close: () => Promise<void>;
}

async function buildRig(
  opts: { adminEnabled?: boolean; trustProxy?: boolean } = {},
): Promise<AdminRig> {
  const dir = mkdtempSync(join(tmpdir(), 'tempmail-admin-'));
  const { db, repos } = openTestDbWithRepos();
  const attachmentStore = createAttachmentStore(dir);
  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: { domain: 'example.test', idleTtlMs: 10 * 60_000, hardTtlMs: 60 * 60_000 },
  });

  const { logger, captured } = makeCapturingLogger();

  const app = await createHttpServer({
    core,
    attachmentStore,
    logger,
    config: {
      cookieSecret: 'test-cookie-secret',
      hardTtlMs: 60 * 60_000,
      trustProxy: opts.trustProxy ?? false,
      admin: opts.adminEnabled === false ? undefined : { enabled: true, logSalt: 'test-salt' },
    },
  });
  await app.ready();
  return {
    app,
    core,
    captured,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('POST /admin/blocklist (06-05 / ABUSE-02)', () => {
  let rig: AdminRig;

  beforeEach(async () => {
    rig = await buildRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('returns 204 for a valid inboxId from loopback', async () => {
    const minted = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { inboxId: minted.inboxId },
    });
    expect(r.statusCode).toBe(204);
    expect(rig.core.getInbox(minted.inboxId).ok).toBe(false);
  });

  it('returns 204 for a valid address — core resolves then expires', async () => {
    const minted = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { address: minted.address },
    });
    expect(r.statusCode).toBe(204);
    expect(rig.core.getInbox(minted.inboxId).ok).toBe(false);
  });

  it('returns 404 when inboxId does not exist', async () => {
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { inboxId: 'nonexistent-id' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 404 when address does not map to any inbox', async () => {
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { address: 'ghost@example.test' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 400 when neither address nor inboxId is provided', async () => {
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 for malformed address payload', async () => {
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { address: 'no-at-sign-here' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects non-loopback callers with 403', async () => {
    // When trustProxy is on, Fastify reads X-Forwarded-For for req.ip.
    await rig.close();
    rig = await buildRig({ trustProxy: true });
    const minted = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      headers: { 'x-forwarded-for': '198.51.100.7' },
      payload: { inboxId: minted.inboxId },
    });
    expect(r.statusCode).toBe(403);
    // The inbox must still be alive.
    expect(rig.core.getInbox(minted.inboxId).ok).toBe(true);
  });

  it('log line for a successful blocklist contains only whitelisted fields', async () => {
    const minted = rig.core.createInbox();
    const addressLocal = minted.address.split('@')[0] ?? '';
    await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { inboxId: minted.inboxId },
    });
    const line = rig.captured.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>).event === 'blocklist_applied',
    );
    expect(line).toBeTruthy();
    const joined = JSON.stringify(line);
    expect(joined).not.toContain(minted.address);
    expect(joined).not.toContain(minted.inboxId);
    expect(joined).not.toContain(addressLocal);
    // But it DOES contain the hashed inbox id.
    expect(line?.inbox_id_hash_first8).toMatch(/^[0-9a-f]{16}$/);
    expect(line?.reason).toBe('manual');
  });

  it('route is NOT registered when config.admin.enabled is absent', async () => {
    await rig.close();
    rig = await buildRig({ adminEnabled: false });
    const minted = rig.core.createInbox();
    const r = await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { inboxId: minted.inboxId },
    });
    expect(r.statusCode).toBe(404);
  });
});
