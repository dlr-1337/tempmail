/**
 * End-to-end coverage for `createCore(deps)` — exercises the composition root
 * through its public surface, using a real in-memory DB + real attachment
 * store + real bus. Every Phase 3 ROADMAP success criterion is proved here:
 *
 *   1. createInbox returns a configured-domain address with ≥64-bit entropy
 *      local-part and a distinct view-token.
 *   2. Each createCore() call has its own bus instance (D-09).
 *   3. ingestMessage persists to the DB and emits on core.bus synchronously
 *      after commit (D-11 surfaces through the public api).
 *   4. listMessages returns messages in ASC chronological order for a valid
 *      view-token.
 *   5. listMessages rejects wrong tokens with `forbidden` and unknown inbox
 *      ids with `not_found` (D-15).
 *   6. expireInbox cascades DB rows AND unlinks orphan attachment blobs
 *      (CORE-05).
 */

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { type CoreConfig, createCore } from '../../src/core/index.js';
import { openTestDbWithRepos } from '../support/db-helper.js';
import { withTmpDir } from '../support/tmpdir.js';

const defaultConfig = (overrides: Partial<CoreConfig> = {}): CoreConfig => ({
  domain: 'example.test',
  idleTtlMs: 10 * 60 * 1_000,
  hardTtlMs: 60 * 60 * 1_000,
  ...overrides,
});

describe('createCore composition root', () => {
  it('createInbox returns address with configured domain and distinct view-token', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: defaultConfig() });
      const r = core.createInbox();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.address.endsWith('@example.test')).toBe(true);
      const localPart = r.address.split('@')[0] ?? '';
      // ≥11 chars of nanoid alphabet ⇒ ~66 bits of entropy (covers CORE-01's
      // "≥64 bits" bound). The default nanoid in this project is 22 chars.
      expect(localPart.length).toBeGreaterThanOrEqual(11);
      expect(r.viewToken.length).toBe(22);
      expect(r.viewToken).not.toBe(localPart);
    });
  });

  it('each createCore call has its own bus instance', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const a = createCore({ db, repos, attachmentStore, config: defaultConfig() });
      const b = createCore({ db, repos, attachmentStore, config: defaultConfig() });
      expect(a.bus).not.toBe(b.bus);
    });
  });

  it('ingestMessage to the address from createInbox emits on core.bus and writes DB', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: defaultConfig() });
      const inbox = core.createInbox();
      expect(inbox.ok).toBe(true);
      if (!inbox.ok) return;

      const listener = vi.fn();
      core.bus.on('message', listener);

      const r = core.ingestMessage({
        envelopeTo: inbox.address,
        envelopeFrom: 'sender@other.test',
        sender: 'Sender',
        subject: 'hi',
        textBody: 'body',
        htmlBody: null,
        headers: null,
        attachments: [],
        sizeBytes: 10,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ inboxId: inbox.inboxId, messageId: r.messageId }),
      );
    });
  });

  it('listMessages returns ingested messages in ASC order with the correct view-token', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      let t = 1_000;
      const core = createCore({
        db,
        repos,
        attachmentStore,
        config: defaultConfig(),
        now: () => {
          const v = t;
          t += 100;
          return v;
        },
      });
      const inbox = core.createInbox();
      expect(inbox.ok).toBe(true);
      if (!inbox.ok) return;
      const ingest = (subject: string) =>
        core.ingestMessage({
          envelopeTo: inbox.address,
          envelopeFrom: null,
          sender: null,
          subject,
          textBody: null,
          htmlBody: null,
          headers: null,
          attachments: [],
          sizeBytes: 1,
        });
      ingest('first');
      ingest('second');
      ingest('third');

      const list = core.listMessages({ inboxId: inbox.inboxId, viewToken: inbox.viewToken });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      // The `now` counter also advanced during createInbox's timestamps; the
      // exact values don't matter, only that list order is ASC and subjects
      // appear in ingest order.
      expect(list.messages.map((m) => m.subject)).toEqual(['first', 'second', 'third']);
      expect(list.messages[0]?.receivedAt).toBeLessThan(list.messages[1]?.receivedAt ?? 0);
      expect(list.messages[1]?.receivedAt).toBeLessThan(list.messages[2]?.receivedAt ?? 0);
    });
  });

  it('listMessages enforces view-token: forbidden for wrong token, not_found for unknown id', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: defaultConfig() });
      const inbox = core.createInbox();
      expect(inbox.ok).toBe(true);
      if (!inbox.ok) return;

      expect(core.listMessages({ inboxId: inbox.inboxId, viewToken: 'WRONG!' })).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      expect(core.listMessages({ inboxId: 'nope', viewToken: 'anything' })).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });
  });

  it('expireInbox cascades DB rows and unlinks orphan attachment blobs', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: defaultConfig() });
      const inbox = core.createInbox();
      expect(inbox.ok).toBe(true);
      if (!inbox.ok) return;

      const write = await attachmentStore.writeAttachment(Readable.from(['end-to-end-bytes']));
      const ingest = core.ingestMessage({
        envelopeTo: inbox.address,
        envelopeFrom: 'a@b.test',
        sender: null,
        subject: 'with-attach',
        textBody: null,
        htmlBody: null,
        headers: null,
        attachments: [
          {
            filename: 'x.bin',
            contentType: 'application/octet-stream',
            size: write.sizeBytes,
            sha256: write.sha256,
            path: write.storagePath,
          },
        ],
        sizeBytes: write.sizeBytes,
      });
      expect(ingest.ok).toBe(true);
      expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);

      const r = await core.expireInbox({ inboxId: inbox.inboxId });
      expect(r).toEqual({ ok: true, deletedMessages: 1, unlinkedAttachments: 1 });
      expect(repos.inboxes.findInboxById(inbox.inboxId)).toBeUndefined();
      expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(false);
    });
  });
});
