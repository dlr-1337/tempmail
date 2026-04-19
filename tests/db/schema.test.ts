import { describe, expect, it } from 'vitest';
import { openTestDb } from '../support/db-helper.js';

describe('schema v1 (STORE-01)', () => {
  it('creates all five tables', () => {
    const db = openTestDb();
    const rows = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    expect(rows.map((r) => r.name)).toEqual([
      'abuse_counters',
      'attachments',
      'inboxes',
      'messages',
      'schema_version',
    ]);
  });

  it('inboxes has domain as a first-class column', () => {
    const db = openTestDb();
    const cols = db
      .prepare<[], { name: string; notnull: number }>("PRAGMA table_info('inboxes')")
      .all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('domain');
    expect(names).toContain('local_part');
    expect(names).toContain('view_token_hash');
    expect(names).toContain('created_at');
    expect(names).toContain('last_activity_at');
    expect(names).toContain('expires_at');
    expect(names).toContain('hard_expires_at');
    // domain is NOT NULL per D-05
    const domainCol = cols.find((c) => c.name === 'domain');
    expect(domainCol?.notnull).toBe(1);
  });

  it('messages has all D-06 columns', () => {
    const db = openTestDb();
    const names = db
      .prepare<[], { name: string }>("PRAGMA table_info('messages')")
      .all()
      .map((c) => c.name);
    for (const col of [
      'id',
      'inbox_id',
      'sender',
      'subject',
      'text_body',
      'html_body_sanitized',
      'received_at',
      'size_bytes',
      'envelope_from',
      'envelope_to',
      'headers_json',
    ]) {
      expect(names).toContain(col);
    }
  });

  it('attachments has storage_path and sha256 (D-07)', () => {
    const db = openTestDb();
    const names = db
      .prepare<[], { name: string }>("PRAGMA table_info('attachments')")
      .all()
      .map((c) => c.name);
    expect(names).toContain('sha256');
    expect(names).toContain('storage_path');
  });

  it('abuse_counters has composite PK (D-08)', () => {
    const db = openTestDb();
    const cols = db
      .prepare<[], { name: string; pk: number }>("PRAGMA table_info('abuse_counters')")
      .all();
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort();
    expect(pkCols).toEqual(['bucket', 'ip_prefix', 'window_start']);
  });

  it('creates required indexes', () => {
    const db = openTestDb();
    const rows = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(rows).toContain('ux_inboxes_local_domain');
    expect(rows).toContain('ix_inboxes_expires_at');
    expect(rows).toContain('ix_messages_inbox_received');
    expect(rows).toContain('ix_attachments_sha256');
    expect(rows).toContain('ix_attachments_message');
  });

  it('passes PRAGMA integrity_check', () => {
    const db = openTestDb();
    const result = db.pragma('integrity_check', { simple: true });
    expect(result).toBe('ok');
  });

  it('schema_version starts at 1', () => {
    const db = openTestDb();
    const row = db
      .prepare<[], { version: number }>('SELECT MAX(version) AS version FROM schema_version')
      .get();
    expect(row?.version).toBe(1);
  });

  it('FK declarations exist on messages.inbox_id and attachments.message_id', () => {
    const db = openTestDb();
    const msgFks = db
      .prepare<[], { table: string; from: string }>("PRAGMA foreign_key_list('messages')")
      .all();
    expect(msgFks.some((f) => f.table === 'inboxes' && f.from === 'inbox_id')).toBe(true);

    const attFks = db
      .prepare<[], { table: string; from: string }>("PRAGMA foreign_key_list('attachments')")
      .all();
    expect(attFks.some((f) => f.table === 'messages' && f.from === 'message_id')).toBe(true);
  });
});
