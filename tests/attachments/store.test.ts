import { createHash } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { withTmpDir } from '../support/tmpdir.js';

function readableOf(bytes: Buffer): Readable {
  return Readable.from([bytes]);
}

describe('attachmentStore (STORE-03)', () => {
  it('writes to <root>/<aa>/<bb>/<sha256>', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      const bytes = Buffer.from('hello world', 'utf8');
      const expected = createHash('sha256').update(bytes).digest('hex');
      const { sha256, storagePath, sizeBytes } = await store.writeAttachment(readableOf(bytes));
      expect(sha256).toBe(expected);
      expect(storagePath).toBe(`${expected.slice(0, 2)}/${expected.slice(2, 4)}/${expected}`);
      expect(sizeBytes).toBe(bytes.length);
      await access(join(root, storagePath));
    });
  });

  it('handles a large (~1MB) stream without buffering everything', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const chunks = Array.from({ length: 16 }, () => chunk); // ~1 MB
      const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
      const result = await store.writeAttachment(Readable.from(chunks));
      expect(result.sizeBytes).toBe(totalBytes);
    });
  });

  it('readAttachment streams bytes back identically', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      const bytes = Buffer.from('roundtrip', 'utf8');
      const { sha256 } = await store.writeAttachment(readableOf(bytes));
      const readBack = await store.readAttachment(sha256);
      expect(readBack).not.toBeNull();
      if (!readBack) return;
      const got: Buffer[] = [];
      for await (const chunk of readBack) got.push(chunk as Buffer);
      expect(Buffer.concat(got).equals(bytes)).toBe(true);
    });
  });

  it('readAttachment returns null for missing sha', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      expect(await store.readAttachment('f'.repeat(64))).toBeNull();
    });
  });

  it('dedup: same bytes produce same path (D-29)', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      const b = Buffer.from('dup', 'utf8');
      const r1 = await store.writeAttachment(readableOf(b));
      const r2 = await store.writeAttachment(readableOf(b));
      expect(r1.sha256).toBe(r2.sha256);
      expect(r1.storagePath).toBe(r2.storagePath);
    });
  });

  it('unlinkBySha256 is idempotent', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      const b = Buffer.from('x', 'utf8');
      const { sha256 } = await store.writeAttachment(readableOf(b));
      expect(await store.unlinkBySha256(sha256)).toBe(true);
      expect(await store.unlinkBySha256(sha256)).toBe(false);
    });
  });

  it('rejects invalid sha on read/stat/unlink', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      await expect(store.readAttachment('nope')).rejects.toThrow();
      await expect(store.statBySha256('nope')).rejects.toThrow();
      await expect(store.unlinkBySha256('nope')).rejects.toThrow();
    });
  });

  it('statBySha256 reports accurate size for existing + missing', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      const b = Buffer.from('size-check', 'utf8');
      const { sha256 } = await store.writeAttachment(readableOf(b));
      const s = await store.statBySha256(sha256);
      expect(s.exists).toBe(true);
      if (s.exists) expect(s.sizeBytes).toBe(b.length);
      const missing = await store.statBySha256('f'.repeat(64));
      expect(missing.exists).toBe(false);
    });
  });

  it('leaves no files under .incoming/ after a successful write', async () => {
    await withTmpDir(async (root) => {
      const store = createAttachmentStore(root);
      await store.writeAttachment(readableOf(Buffer.from('abc', 'utf8')));
      // .incoming should exist but be empty
      const contents = await readdir(join(root, '.incoming')).catch(() => []);
      expect(contents).toEqual([]);
    });
  });
});
