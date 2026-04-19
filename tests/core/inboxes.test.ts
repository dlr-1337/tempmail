import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { createInboxes, verifyViewToken } from '../../src/core/inboxes.js';
import { openTestDbWithRepos } from '../support/db-helper.js';
import { withTmpDir } from '../support/tmpdir.js';

/**
 * Test coverage for plan 03-02's inbox domain logic (CORE-01, CORE-02, CORE-05).
 *
 * Each case instantiates its own in-memory DB + a real attachment store under
 * a per-test temp dir — `expireInbox` unlinks real files on disk, so the
 * store cannot be stubbed without weakening the orphan-safety assertion.
 */

const mkConfig = (
  overrides: Partial<{ domain: string; idleTtlMs: number; hardTtlMs: number }> = {},
) => ({
  domain: 'example.test',
  idleTtlMs: 10 * 60 * 1_000,
  hardTtlMs: 60 * 60 * 1_000,
  ...overrides,
});

describe('createInboxes.createInbox', () => {
  it('returns address + plaintext view-token and stores only the hash', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const result = inboxes.createInbox();
      expect(result.ok).toBe(true);
      expect(result.address.endsWith('@example.test')).toBe(true);
      // nanoid(22) — 132 bits URL-safe.
      expect(result.viewToken.length).toBe(22);

      const row = repos.inboxes.findInboxById(result.inboxId);
      expect(row).toBeDefined();
      if (!row) return;
      // D-07: DB holds only the hash, never the plaintext token.
      expect(row.view_token_hash).not.toBe(result.viewToken);
      // sha-256 hex is always 64 chars.
      expect(row.view_token_hash.length).toBe(64);
      // Address local-part must match the row's local-part (not view-token).
      expect(result.address).toBe(`${row.local_part}@${row.domain}`);
      // CORE-02: view-token is distinct from the local-part.
      expect(result.viewToken).not.toBe(row.local_part);
    });
  });

  it('produces a hash that verifyViewToken accepts and wrong tokens reject', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const result = inboxes.createInbox();
      const row = repos.inboxes.findInboxById(result.inboxId);
      expect(row).toBeDefined();
      if (!row) return;

      // Correct token → true.
      expect(verifyViewToken(row, result.viewToken)).toBe(true);
      // Arbitrary-length wrong token → false.
      expect(verifyViewToken(row, 'wrong-token-value-here!')).toBe(false);
      // Same-length (22-char) wrong token → false — proves compare is
      // content-based, not length-prefix-based.
      expect(verifyViewToken(row, 'A'.repeat(22))).toBe(false);
      // Also exposed on the api object; must behave identically.
      expect(inboxes.verifyViewToken(row, result.viewToken)).toBe(true);
      expect(inboxes.verifyViewToken(row, 'A'.repeat(22))).toBe(false);
    });
  });

  it('uses config.domain, never hardcoded', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({
        db,
        repos,
        attachmentStore,
        config: mkConfig({ domain: 'alt.example' }),
      });

      const result = inboxes.createInbox();
      expect(result.address.endsWith('@alt.example')).toBe(true);
    });
  });

  it('uses injected now + id for determinism', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);

      // id() is called twice per createInbox: once for local-part, once for
      // view-token. Feed a fixed pair and assert every derived value is exact.
      const ids = ['local_part_value_abc1', 'view_token_value_xyz2'];
      const id = vi.fn(() => {
        const v = ids.shift();
        if (!v) throw new Error('id() called more than expected');
        return v;
      });
      const now = vi.fn(() => 1_700_000_000_000);

      const inboxes = createInboxes({
        db,
        repos,
        attachmentStore,
        config: mkConfig({ idleTtlMs: 1_000, hardTtlMs: 10_000 }),
        now,
        id,
      });

      const result = inboxes.createInbox();
      expect(result.address).toBe('local_part_value_abc1@example.test');
      expect(result.viewToken).toBe('view_token_value_xyz2');
      expect(result.expiresAt).toBe(1_700_000_000_000 + 1_000);
      expect(result.hardExpiresAt).toBe(1_700_000_000_000 + 10_000);

      // Stored hash must equal sha256(viewToken) hex — proves createInbox
      // did the hashing itself (never stored plaintext).
      const row = repos.inboxes.findInboxById(result.inboxId);
      expect(row?.view_token_hash).toBe(
        createHash('sha256').update('view_token_value_xyz2').digest('hex'),
      );
      // id() was called exactly twice (one per createInbox call).
      expect(id).toHaveBeenCalledTimes(2);
    });
  });
});

describe('createInboxes.expireInbox', () => {
  it('returns not_found for unknown inbox', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const r = await inboxes.expireInbox({ inboxId: 'does-not-exist' });
      expect(r).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  it('deletes messages + unlinks orphan attachments', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const result = inboxes.createInbox();
      const write = await attachmentStore.writeAttachment(Readable.from(['hello world']));
      repos.messages.insertMessageWithAttachments(
        {
          inbox_id: result.inboxId,
          sender: 'a@b.test',
          subject: 'hi',
          text_body: 'body',
          html_body_sanitized: null,
          size_bytes: 11,
          envelope_from: 'a@b.test',
          envelope_to: result.address,
          headers_json: null,
        },
        [
          {
            filename: 'greet.txt',
            content_type: 'text/plain',
            size_bytes: 11,
            sha256: write.sha256,
            storage_path: write.storagePath,
          },
        ],
      );

      // Precondition: file is on disk.
      expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);

      const r = await inboxes.expireInbox({ inboxId: result.inboxId });
      expect(r).toEqual({ ok: true, deletedMessages: 1, unlinkedAttachments: 1 });
      // DB row gone (FK CASCADE handled messages + attachments).
      expect(repos.inboxes.findInboxById(result.inboxId)).toBeUndefined();
      // File gone from disk.
      expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(false);
    });
  });

  it('does not unlink sha256s still referenced by another inbox', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const a = inboxes.createInbox();
      const b = inboxes.createInbox();
      const write = await attachmentStore.writeAttachment(Readable.from(['shared bytes']));
      const attach = {
        filename: 'x.txt',
        content_type: 'text/plain',
        size_bytes: 12,
        sha256: write.sha256,
        storage_path: write.storagePath,
      };

      repos.messages.insertMessageWithAttachments(
        {
          inbox_id: a.inboxId,
          sender: null,
          subject: null,
          text_body: null,
          html_body_sanitized: null,
          size_bytes: 12,
          envelope_from: null,
          envelope_to: a.address,
          headers_json: null,
        },
        [attach],
      );
      repos.messages.insertMessageWithAttachments(
        {
          inbox_id: b.inboxId,
          sender: null,
          subject: null,
          text_body: null,
          html_body_sanitized: null,
          size_bytes: 12,
          envelope_from: null,
          envelope_to: b.address,
          headers_json: null,
        },
        [attach],
      );

      const r = await inboxes.expireInbox({ inboxId: a.inboxId });
      // Inbox A had one message, but the sha is still referenced by B's
      // attachment row → no unlink.
      expect(r).toEqual({ ok: true, deletedMessages: 1, unlinkedAttachments: 0 });
      expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);
      // Inbox B survives.
      expect(repos.inboxes.findInboxById(b.inboxId)).toBeDefined();
    });
  });

  it('handles inboxes with zero messages', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const result = inboxes.createInbox();
      const r = await inboxes.expireInbox({ inboxId: result.inboxId });
      expect(r).toEqual({ ok: true, deletedMessages: 0, unlinkedAttachments: 0 });
      expect(repos.inboxes.findInboxById(result.inboxId)).toBeUndefined();
    });
  });

  it('rolls back on throw inside the transaction', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const inboxes = createInboxes({ db, repos, attachmentStore, config: mkConfig() });

      const result = inboxes.createInbox();
      const write = await attachmentStore.writeAttachment(Readable.from(['rolling-back']));
      repos.messages.insertMessageWithAttachments(
        {
          inbox_id: result.inboxId,
          sender: null,
          subject: null,
          text_body: null,
          html_body_sanitized: null,
          size_bytes: 12,
          envelope_from: null,
          envelope_to: result.address,
          headers_json: null,
        },
        [
          {
            filename: 'x',
            content_type: null,
            size_bytes: 12,
            sha256: write.sha256,
            storage_path: write.storagePath,
          },
        ],
      );

      // Spy the delete to throw after the transaction begins — withTransaction
      // must roll back, and since we throw before phase 3, no file is unlinked.
      const spy = vi.spyOn(repos.inboxes, 'deleteInbox').mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(inboxes.expireInbox({ inboxId: result.inboxId })).rejects.toThrow('boom');
      spy.mockRestore();

      // Inbox row still present (rollback).
      expect(repos.inboxes.findInboxById(result.inboxId)).toBeDefined();
      // File still on disk (phase 3 never ran).
      expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);
    });
  });
});
