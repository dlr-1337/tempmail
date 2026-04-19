import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { withTmpDir } from '../support/tmpdir.js';

describe('PRAGMAs on real file DB (STORE-02, D-34)', () => {
  it('applies WAL + documented PRAGMAs on fresh open', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'test.db');
      const db = openDb(path);

      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('temp_store', { simple: true })).toBe(2); // MEMORY
      expect(db.pragma('mmap_size', { simple: true })).toBe(134_217_728); // 128 MB

      db.close();

      // The main file should exist after open+close (schema bootstrap runs a
      // CREATE + INSERT which forces the file to be flushed).
      await access(path);
    });
  });

  it('WAL + foreign_keys re-apply on reconnect', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'persist.db');

      // First open: write something to force WAL file creation.
      const db1 = openDb(path);
      db1
        .prepare(`INSERT INTO inboxes (id, local_part, domain, view_token_hash,
          created_at, last_activity_at, expires_at, hard_expires_at)
          VALUES ('id1','lp','d.test','h',1,1,1000,10000)`)
        .run();
      db1.close();

      // Second open: PRAGMAs should be re-applied (per D-15: foreign_keys is
      // not persisted in the DB file; our openDb must set it every time).
      const db2 = openDb(path);
      expect(db2.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db2.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db2.pragma('busy_timeout', { simple: true })).toBe(5000);

      // Data survived.
      const row = db2
        .prepare<[string], { id: string }>('SELECT id FROM inboxes WHERE id = ?')
        .get('id1');
      expect(row).toBeDefined();
      expect(row?.id).toBe('id1');

      db2.close();
    });
  });

  it('opening same path twice does not re-run migrations', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'idem.db');
      const db1 = openDb(path);
      const ver1 = db1
        .prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM schema_version')
        .get()?.v;
      db1.close();

      const db2 = openDb(path);
      const ver2 = db2
        .prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM schema_version')
        .get()?.v;
      const rowCount = db2
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM schema_version')
        .get()?.c;
      expect(ver1).toBe(1);
      expect(ver2).toBe(1);
      expect(rowCount).toBe(1); // not 2 — no double-insert
      db2.close();
    });
  });
});
