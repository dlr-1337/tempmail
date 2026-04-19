/**
 * ABUSE-03 / D-24 — cross-layer invariant: no PII in captured log output.
 *
 * Complements `tests/smtp/pii-logs.test.ts` by extending the guarantee to
 * the HTTP path. Boots a test rig, drives mint → GET metadata → list
 * messages → healthz, captures every pino line, and asserts:
 *
 *   - The full address never appears
 *   - The local-part never appears
 *   - The inbox id never appears
 *   - The view-token never appears
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

interface PiiRig {
  app: FastifyInstance;
  core: CoreApi;
  captured: unknown[];
  close: () => Promise<void>;
}

async function buildRig(): Promise<PiiRig> {
  const dir = mkdtempSync(join(tmpdir(), 'tempmail-pii-'));
  const { db, repos } = openTestDbWithRepos();
  const attachmentStore = createAttachmentStore(dir);
  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: { domain: 'example.test', idleTtlMs: 10 * 60_000, hardTtlMs: 60 * 60_000 },
  });

  const captured: unknown[] = [];
  const logger: Logger = pinoLib(
    { level: 'info' },
    {
      write(chunk: string): void {
        try {
          captured.push(JSON.parse(chunk));
        } catch {
          captured.push(chunk);
        }
      },
    },
  );

  const app = await createHttpServer({
    core,
    attachmentStore,
    logger,
    config: {
      cookieSecret: 'test-cookie-secret',
      hardTtlMs: 60 * 60_000,
      trustProxy: false,
      admin: { enabled: true, logSalt: 'pii-salt' },
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

describe('ABUSE-03 — no PII in HTTP-layer logs', () => {
  let rig: PiiRig;

  beforeEach(async () => {
    rig = await buildRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('none of mint/meta/messages/healthz emit address, local-part, inboxId, or viewToken', async () => {
    const mint = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
    expect(mint.statusCode).toBe(201);
    const body = mint.json() as { address: string };
    const address = body.address;
    const localPart = address.split('@')[0] ?? '';

    // Derive inbox id + view token from the internal core — not the HTTP
    // response — so we can grep for them in log output.
    const all = rig.app as unknown as { server: { address(): unknown } };
    void all; // unused; kept for clarity
    // Use the cookie jar path: cookie name is `tempmail_vt_<inboxId>`.
    const setCookie = mint.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
    const cookieMatch = /tempmail_vt_([^=]+)=([^;]+)/.exec(raw);
    const inboxId = cookieMatch?.[1] ?? '';
    const viewToken = cookieMatch?.[2] ?? '';

    // Drive a few more requests that would be the most likely PII leakers.
    await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inboxId}`,
      cookies: { [`tempmail_vt_${inboxId}`]: viewToken },
    });
    await rig.app.inject({
      method: 'GET',
      url: `/api/inbox/${inboxId}/messages`,
      cookies: { [`tempmail_vt_${inboxId}`]: viewToken },
    });
    await rig.app.inject({ method: 'GET', url: '/healthz' });
    // Also run an admin blocklist to make sure its log line is PII-safe.
    await rig.app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      payload: { inboxId },
    });

    const joined = JSON.stringify(rig.captured);
    expect(joined).not.toContain(address);
    expect(joined).not.toContain(localPart);
    expect(joined).not.toContain(inboxId);
    expect(joined).not.toContain(viewToken);
  });
});
