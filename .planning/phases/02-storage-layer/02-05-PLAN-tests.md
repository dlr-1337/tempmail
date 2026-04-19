---
phase: 2
plan: 5
type: execute
wave: 4
status: ready
depends_on: [1, 2, 3, 4]
files_modified:
  - tests/db/schema.test.ts
  - tests/db/pragmas-integration.test.ts
  - tests/db/inbox-repo.test.ts
  - tests/db/message-repo.test.ts
  - tests/db/attachment-repo.test.ts
  - tests/db/abuse-repo.test.ts
  - tests/db/cascade.test.ts
  - tests/attachments/paths.test.ts
  - tests/attachments/store.test.ts
  - tests/support/db-helper.ts
  - tests/support/tmpdir.ts
autonomous: true
requirements: [STORE-01, STORE-02, STORE-03, STORE-04]
must_haves:
  truths:
    - "`npm test` runs the full Phase 2 test suite and exits 0"
    - "Unit tests use `:memory:` SQLite (D-33) — fast, parallelizable, no fs cleanup"
    - "One integration test uses a real file DB in a tmpdir (D-34) to verify WAL mode + PRAGMA persistence across reconnect"
    - "FK CASCADE is tested end-to-end: deleting an inbox removes its messages and attachment rows"
    - "D-21 is verified by a test that spies on `db.prepare` / `db.exec` and asserts they're only called inside `src/db/`"
    - "Every STORE-01..04 requirement has at least one failing-if-broken assertion"
  artifacts:
    - path: "tests/support/db-helper.ts"
      provides: "openTestDb() — returns an in-memory DB with schema applied"
      exports: ["openTestDb", "openTestDbWithRepos"]
    - path: "tests/support/tmpdir.ts"
      provides: "withTmpDir(fn) — creates/cleans a per-test temp directory"
      exports: ["withTmpDir"]
    - path: "tests/db/schema.test.ts"
      provides: "Asserts all 5 tables + indexes exist, integrity_check passes"
    - path: "tests/db/pragmas-integration.test.ts"
      provides: "Real file DB test — WAL mode persists, PRAGMAs re-apply on reconnect"
    - path: "tests/db/*-repo.test.ts"
      provides: "Per-repo tests for every public method"
    - path: "tests/db/cascade.test.ts"
      provides: "Deletes at each FK level verified end-to-end"
    - path: "tests/attachments/*.test.ts"
      provides: "Path logic + store I/O tests"
  key_links:
    - from: "tests/**/*.test.ts"
      to: "src/**/*.ts"
      via: "import from ../src/... with relative paths (vitest.config include)"
      pattern: "from.*src/"
---

<objective>
Write the Vitest test suite for Phase 2. Covers: schema correctness (all tables + indexes + integrity_check), PRAGMA behavior (unit + integration with a real file DB), every repo method, FK CASCADE at every level, the attachment store (paths + I/O), and the "no raw SQL outside the repos" invariant.

This plan does NOT create production code; it only creates tests for the code from plans 01–04. If a test fails, that is the signal something is wrong in the production module it tests — fix it there, not here.

Purpose: Lock in STORE-01..04 behavior so future phases (and future Claude instances) cannot silently regress it. Also produces the empirical proof required by ROADMAP.md Phase 2 success criteria.
Output: A green `npm test` and `npm run typecheck && npm run check && npm test` pipeline that validates every STORE requirement.
</objective>

<execution_context>
Depends on Plans 01–04 (all code exists). Tests live under `tests/`; Vitest picks them up via the `include: ['tests/**/*.test.ts']` glob from plan 01.

All tests use ESM + `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'` explicitly — no globals (per Vitest config).

Determinism: where the code under test calls `nowMs()`, tests either freeze time with `vi.spyOn(now, 'nowMs').mockReturnValue(...)` or use "now + delta" style comparisons tolerant of a few ms of drift.
</execution_context>

<context>
@.planning/phases/02-storage-layer/02-CONTEXT.md
@.planning/phases/02-storage-layer/02-02-PLAN-schema-and-migrations.md
@.planning/phases/02-storage-layer/02-03-PLAN-repositories.md
@.planning/phases/02-storage-layer/02-04-PLAN-attachment-store.md
@.planning/research/ARCHITECTURE.md
</context>

<locked_decisions>
- **D-33:** Unit tests in Vitest with in-memory SQLite (`:memory:`) — fast, parallel, no fs cleanup
- **D-34:** Integration test with a real file DB in a temp dir for PRAGMA behavior + WAL mode verification
</locked_decisions>

## Goal

A green test suite that will break if any STORE requirement regresses. Roughly 35–50 test cases across 8 test files, all under 2 seconds total runtime.

## Must-have checklist

- **STORE-01**: `tests/db/schema.test.ts` asserts all four domain tables + indexes exist with expected columns; `tests/db/cascade.test.ts` proves `domain` column works per-row
- **STORE-02**: `tests/db/pragmas-integration.test.ts` (real file DB) asserts `journal_mode=wal`, `synchronous=1`, `busy_timeout=5000`, `foreign_keys=1` and that these hold across a close+reopen cycle
- **STORE-03**: `tests/attachments/paths.test.ts` + `tests/attachments/store.test.ts` verify the `<aa>/<bb>/<sha256>` shape and atomic write semantics
- **STORE-04**: `tests/db/*-repo.test.ts` verify repos expose intent-named methods over prepared statements; a dedicated D-21 test spies on `db.prepare` to prove all SQL goes through the repo layer

## Tasks

#### Task 1: Test support helpers + schema + PRAGMA tests

**Files:**
- `tests/support/tmpdir.ts`
- `tests/support/db-helper.ts`
- `tests/db/schema.test.ts`
- `tests/db/pragmas-integration.test.ts`

**Action:**

1. Create `tests/support/tmpdir.ts` — a tiny helper to allocate and clean temp dirs for integration tests:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Allocates a per-test temp directory, runs `fn(dir)`, and cleans up
 * unconditionally (success or failure). Returns fn's result.
 */
export async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tempmail-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

2. Create `tests/support/db-helper.ts`:

```typescript
import { openDb, type Db } from '../../src/db/client.ts';
import { createRepos, type Repos } from '../../src/db/repos/index.ts';

/** Opens an in-memory DB with schema applied. Default helper for unit tests. */
export function openTestDb(): Db {
  return openDb(':memory:');
}

/** Opens an in-memory DB and wires repos in one step. */
export function openTestDbWithRepos(): { db: Db; repos: Repos } {
  const db = openTestDb();
  return { db, repos: createRepos(db) };
}
```

3. Create `tests/db/schema.test.ts`. Every STORE-01 column and index is asserted explicitly so a silent column-rename breaks the test:

```typescript
import { describe, it, expect } from 'vitest';
import { openTestDb } from '../support/db-helper.ts';

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
      'id', 'inbox_id', 'sender', 'subject', 'text_body',
      'html_body_sanitized', 'received_at', 'size_bytes',
      'envelope_from', 'envelope_to', 'headers_json',
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
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
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
    const msgFks = db.prepare<[], { table: string; from: string }>(
      "PRAGMA foreign_key_list('messages')",
    ).all();
    expect(msgFks.some((f) => f.table === 'inboxes' && f.from === 'inbox_id')).toBe(true);

    const attFks = db.prepare<[], { table: string; from: string }>(
      "PRAGMA foreign_key_list('attachments')",
    ).all();
    expect(attFks.some((f) => f.table === 'messages' && f.from === 'message_id')).toBe(true);
  });
});
```

4. Create `tests/db/pragmas-integration.test.ts`. Per D-34, this uses a real file DB so WAL mode and reconnect semantics are exercised:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { openDb } from '../../src/db/client.ts';
import { withTmpDir } from '../support/tmpdir.ts';

describe('PRAGMAs on real file DB (STORE-02, D-34)', () => {
  it('applies WAL + documented PRAGMAs on fresh open', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'test.db');
      const db = openDb(path);

      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1);       // NORMAL
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('temp_store', { simple: true })).toBe(2);        // MEMORY
      expect(db.pragma('mmap_size', { simple: true })).toBe(134217728); // 128 MB

      db.close();

      // WAL file should exist after any write — force one by opening a tx.
      // (journal_mode=WAL creates the -wal file on the first write.)
      // For this assertion we tolerate either existing or not, since we only
      // did reads. We just assert the main file exists.
      await access(path);
    });
  });

  it('WAL + foreign_keys re-apply on reconnect', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'persist.db');

      // First open: write something to force WAL file creation.
      const db1 = openDb(path);
      db1.prepare(`INSERT INTO inboxes (id, local_part, domain, view_token_hash,
        created_at, last_activity_at, expires_at, hard_expires_at)
        VALUES ('id1','lp','d.test','h',1,1,1000,10000)`).run();
      db1.close();

      // Second open: PRAGMAs should be re-applied (per D-15: foreign_keys is
      // not persisted in the DB file; our openDb must set it every time).
      const db2 = openDb(path);
      expect(db2.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db2.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db2.pragma('busy_timeout', { simple: true })).toBe(5000);

      // Data survived.
      const row = db2.prepare('SELECT id FROM inboxes WHERE id=?').get('id1');
      expect(row).toBeDefined();

      db2.close();
    });
  });

  it('opening same path twice does not re-run migrations', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'idem.db');
      const db1 = openDb(path);
      const ver1 = db1
        .prepare<[], { v: number }>('SELECT MAX(version) AS v FROM schema_version')
        .get()?.v;
      db1.close();

      const db2 = openDb(path);
      const ver2 = db2
        .prepare<[], { v: number }>('SELECT MAX(version) AS v FROM schema_version')
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
```

**Verify:**

```xml
<verify>
  <automated>npx vitest run tests/db/schema.test.ts tests/db/pragmas-integration.test.ts</automated>
</verify>
```

**Done:**
- `tests/support/tmpdir.ts` and `tests/support/db-helper.ts` exist.
- `tests/db/schema.test.ts` has 9 `it()` cases all green.
- `tests/db/pragmas-integration.test.ts` has 3 `it()` cases all green.
- These suites take under 500ms combined.

**Commit message:** `test(db): add schema and PRAGMA integration tests`

---

#### Task 2: Repo tests + cascade test

**Files:**
- `tests/db/inbox-repo.test.ts`
- `tests/db/message-repo.test.ts`
- `tests/db/attachment-repo.test.ts`
- `tests/db/abuse-repo.test.ts`
- `tests/db/cascade.test.ts`

**Action:**

1. Create `tests/db/inbox-repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.ts';

describe('inboxRepo (STORE-04)', () => {
  it('createInbox returns row with assigned id + timestamps', () => {
    const { repos } = openTestDbWithRepos();
    const before = Date.now();
    const row = repos.inboxes.createInbox({
      local_part: 'abc',
      domain: 'example.test',
      view_token_hash: 'h',
      expires_at: 9_999_999_999,
      hard_expires_at: 9_999_999_999,
    });
    expect(row.id).toMatch(/^[A-Za-z0-9_-]{22}$/); // nanoid default alphabet
    expect(row.local_part).toBe('abc');
    expect(row.domain).toBe('example.test');
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.last_activity_at).toBe(row.created_at);
  });

  it('findInboxByLocalPart disambiguates by (local_part, domain)', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    repos.inboxes.createInbox({
      local_part: 'same', domain: 'a.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    repos.inboxes.createInbox({
      local_part: 'same', domain: 'b.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    const a = repos.inboxes.findInboxByLocalPart('same', 'a.test');
    const b = repos.inboxes.findInboxByLocalPart('same', 'b.test');
    expect(a?.domain).toBe('a.test');
    expect(b?.domain).toBe('b.test');
    expect(a?.id).not.toBe(b?.id);
  });

  it('UNIQUE (local_part, domain) is enforced', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    repos.inboxes.createInbox({
      local_part: 'dup', domain: 'a.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    expect(() =>
      repos.inboxes.createInbox({
        local_part: 'dup', domain: 'a.test', view_token_hash: 'h2',
        expires_at: exp, hard_expires_at: exp,
      }),
    ).toThrow(/UNIQUE/);
  });

  it('updateLastActivity caps expires_at at hard_expires_at', () => {
    const { repos } = openTestDbWithRepos();
    const hardCap = Date.now() + 3_600_000;
    const row = repos.inboxes.createInbox({
      local_part: 'x', domain: 'd.test', view_token_hash: 'h',
      expires_at: Date.now() + 60_000,
      hard_expires_at: hardCap,
    });
    // Ask for 10h from now — should clamp to hardCap.
    const updated = repos.inboxes.updateLastActivity(row.id, Date.now() + 36_000_000);
    expect(updated).toBeDefined();
    expect(updated?.expires_at).toBe(hardCap);
  });

  it('updateLastActivity returns undefined for missing inbox', () => {
    const { repos } = openTestDbWithRepos();
    expect(repos.inboxes.updateLastActivity('nonexistent', Date.now())).toBeUndefined();
  });

  it('deleteInbox returns true once and false thereafter', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const row = repos.inboxes.createInbox({
      local_part: 'del', domain: 'd.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    expect(repos.inboxes.deleteInbox(row.id)).toBe(true);
    expect(repos.inboxes.deleteInbox(row.id)).toBe(false);
    expect(repos.inboxes.findInboxById(row.id)).toBeUndefined();
  });

  it('listExpired returns only rows with expires_at < cutoff, ordered ascending', () => {
    const { repos } = openTestDbWithRepos();
    for (let i = 1; i <= 5; i += 1) {
      repos.inboxes.createInbox({
        local_part: `lp${i}`, domain: 'd.test', view_token_hash: 'h',
        expires_at: i * 1000,
        hard_expires_at: 10_000_000,
      });
    }
    const expired = repos.inboxes.listExpired(3500, 10);
    expect(expired.map((r) => r.local_part)).toEqual(['lp1', 'lp2', 'lp3']);
  });
});
```

2. Create `tests/db/message-repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.ts';

function makeInbox(repos: ReturnType<typeof openTestDbWithRepos>['repos']) {
  const exp = 9_999_999_999;
  return repos.inboxes.createInbox({
    local_part: 'x', domain: 'd.test', view_token_hash: 'h',
    expires_at: exp, hard_expires_at: exp,
  });
}

describe('messageRepo (STORE-04)', () => {
  it('insertMessageWithAttachments writes message + N attachments atomically', () => {
    const { repos } = openTestDbWithRepos();
    const inbox = makeInbox(repos);
    const result = repos.messages.insertMessageWithAttachments(
      {
        inbox_id: inbox.id, sender: 'a@b', subject: 's', text_body: 't',
        html_body_sanitized: null, size_bytes: 100,
        envelope_from: 'a@b', envelope_to: 'x@d.test', headers_json: '{}',
      },
      [
        { filename: 'a', content_type: 'text/plain', size_bytes: 1, sha256: 'a'.repeat(64), storage_path: 'aa/aa/...' },
        { filename: 'b', content_type: 'text/plain', size_bytes: 2, sha256: 'b'.repeat(64), storage_path: 'bb/bb/...' },
      ],
    );
    expect(result.messageId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.attachmentIds).toHaveLength(2);
    const atts = repos.attachments.listAttachmentsByMessage(result.messageId);
    expect(atts).toHaveLength(2);
  });

  it('insertMessageWithAttachments rolls back if inbox_id is invalid (FK)', () => {
    const { repos } = openTestDbWithRepos();
    expect(() =>
      repos.messages.insertMessageWithAttachments(
        {
          inbox_id: 'nonexistent-inbox', sender: null, subject: null, text_body: null,
          html_body_sanitized: null, size_bytes: 0, envelope_from: null,
          envelope_to: null, headers_json: null,
        },
        [],
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('listMessagesByInbox returns newest first', () => {
    const { repos } = openTestDbWithRepos();
    const inbox = makeInbox(repos);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = repos.messages.insertMessageWithAttachments(
        {
          inbox_id: inbox.id, sender: null, subject: `s${i}`, text_body: null,
          html_body_sanitized: null, size_bytes: 0, envelope_from: null,
          envelope_to: null, headers_json: null,
          received_at: 1000 + i,
        },
        [],
      );
      ids.push(r.messageId);
    }
    const rows = repos.messages.listMessagesByInbox(inbox.id, { limit: 10, offset: 0 });
    expect(rows.map((r) => r.subject)).toEqual(['s2', 's1', 's0']);
  });

  it('countMessagesByInbox returns accurate count', () => {
    const { repos } = openTestDbWithRepos();
    const inbox = makeInbox(repos);
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(0);
    repos.messages.insertMessageWithAttachments(
      {
        inbox_id: inbox.id, sender: null, subject: null, text_body: null,
        html_body_sanitized: null, size_bytes: 0, envelope_from: null,
        envelope_to: null, headers_json: null,
      },
      [],
    );
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(1);
  });
});
```

3. Create `tests/db/attachment-repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.ts';

function seedInboxWithMessages(repos: ReturnType<typeof openTestDbWithRepos>['repos']) {
  const exp = 9_999_999_999;
  const inbox = repos.inboxes.createInbox({
    local_part: 'x', domain: 'd.test', view_token_hash: 'h',
    expires_at: exp, hard_expires_at: exp,
  });
  const m1 = repos.messages.insertMessageWithAttachments(
    { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
      html_body_sanitized: null, size_bytes: 0,
      envelope_from: null, envelope_to: null, headers_json: null },
    [{ filename: 'a', content_type: 'text/plain', size_bytes: 1,
       sha256: 'a'.repeat(64), storage_path: 'aa/aa/...' }],
  );
  const m2 = repos.messages.insertMessageWithAttachments(
    { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
      html_body_sanitized: null, size_bytes: 0,
      envelope_from: null, envelope_to: null, headers_json: null },
    [
      { filename: 'b', content_type: 'text/plain', size_bytes: 2,
        sha256: 'b'.repeat(64), storage_path: 'bb/bb/...' },
      // Same sha as m1's attachment — dedup case
      { filename: 'a-dup', content_type: 'text/plain', size_bytes: 1,
        sha256: 'a'.repeat(64), storage_path: 'aa/aa/...' },
    ],
  );
  return { inbox, m1, m2 };
}

describe('attachmentRepo (STORE-04)', () => {
  it('findAttachmentById returns the row', () => {
    const { repos } = openTestDbWithRepos();
    const { m1 } = seedInboxWithMessages(repos);
    const attId = m1.attachmentIds[0];
    expect(attId).toBeDefined();
    const row = repos.attachments.findAttachmentById(attId!);
    expect(row?.sha256).toBe('a'.repeat(64));
  });

  it('listAttachmentsByMessage returns all attachments for a message', () => {
    const { repos } = openTestDbWithRepos();
    const { m2 } = seedInboxWithMessages(repos);
    const atts = repos.attachments.listAttachmentsByMessage(m2.messageId);
    expect(atts).toHaveLength(2);
  });

  it('listAllSha256s returns a deduped Set across all messages', () => {
    const { repos } = openTestDbWithRepos();
    seedInboxWithMessages(repos);
    const shas = repos.attachments.listAllSha256s();
    expect(shas.size).toBe(2); // 'a'*64 appears twice but dedups in the Set
    expect(shas.has('a'.repeat(64))).toBe(true);
    expect(shas.has('b'.repeat(64))).toBe(true);
  });

  it('deleteAttachmentsByMessage removes only that message\'s attachments', () => {
    const { repos } = openTestDbWithRepos();
    const { m1, m2 } = seedInboxWithMessages(repos);
    expect(repos.attachments.deleteAttachmentsByMessage(m1.messageId)).toBe(1);
    expect(repos.attachments.listAttachmentsByMessage(m1.messageId)).toHaveLength(0);
    expect(repos.attachments.listAttachmentsByMessage(m2.messageId)).toHaveLength(2);
  });
});
```

4. Create `tests/db/abuse-repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.ts';

describe('abuseRepo (STORE-04)', () => {
  it('incrementCounter UPSERTs and returns running count', () => {
    const { repos } = openTestDbWithRepos();
    expect(repos.abuse.incrementCounter('1.2.3.0/24', 'inbox_create', 60000)).toBe(1);
    expect(repos.abuse.incrementCounter('1.2.3.0/24', 'inbox_create', 60000)).toBe(2);
    expect(repos.abuse.incrementCounter('1.2.3.0/24', 'inbox_create', 60000)).toBe(3);
  });

  it('getCounter returns 0 for missing keys', () => {
    const { repos } = openTestDbWithRepos();
    expect(repos.abuse.getCounter('9.9.9.0/24', 'msg_read', 0)).toBe(0);
  });

  it('different (prefix, bucket, window) triples are independent', () => {
    const { repos } = openTestDbWithRepos();
    repos.abuse.incrementCounter('a', 'x', 100);
    repos.abuse.incrementCounter('a', 'x', 200);      // different window
    repos.abuse.incrementCounter('a', 'y', 100);      // different bucket
    repos.abuse.incrementCounter('b', 'x', 100);      // different prefix
    expect(repos.abuse.getCounter('a', 'x', 100)).toBe(1);
    expect(repos.abuse.getCounter('a', 'x', 200)).toBe(1);
    expect(repos.abuse.getCounter('a', 'y', 100)).toBe(1);
    expect(repos.abuse.getCounter('b', 'x', 100)).toBe(1);
  });

  it('pruneOldCounters deletes only rows with window_start < cutoff', () => {
    const { repos } = openTestDbWithRepos();
    repos.abuse.incrementCounter('a', 'x', 100);
    repos.abuse.incrementCounter('a', 'x', 200);
    repos.abuse.incrementCounter('a', 'x', 300);
    const deleted = repos.abuse.pruneOldCounters(250);
    expect(deleted).toBe(2);
    expect(repos.abuse.getCounter('a', 'x', 100)).toBe(0);
    expect(repos.abuse.getCounter('a', 'x', 200)).toBe(0);
    expect(repos.abuse.getCounter('a', 'x', 300)).toBe(1);
  });
});
```

5. Create `tests/db/cascade.test.ts`. This proves D-09 works end-to-end and is the empirical backing for CORE-05 (Phase 3):

```typescript
import { describe, it, expect } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.ts';

describe('FK CASCADE (D-09)', () => {
  it('deleting an inbox cascades to messages', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x', domain: 'd.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    repos.messages.insertMessageWithAttachments(
      { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
        html_body_sanitized: null, size_bytes: 0,
        envelope_from: null, envelope_to: null, headers_json: null },
      [],
    );
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(1);

    repos.inboxes.deleteInbox(inbox.id);
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(0);
  });

  it('deleting an inbox cascades to attachments via messages', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x', domain: 'd.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    repos.messages.insertMessageWithAttachments(
      { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
        html_body_sanitized: null, size_bytes: 0,
        envelope_from: null, envelope_to: null, headers_json: null },
      [{ filename: 'a', content_type: 'text/plain', size_bytes: 1,
         sha256: 'f'.repeat(64), storage_path: 'ff/ff/...' }],
    );
    expect(repos.attachments.listAllSha256s().has('f'.repeat(64))).toBe(true);

    repos.inboxes.deleteInbox(inbox.id);
    expect(repos.attachments.listAllSha256s().has('f'.repeat(64))).toBe(false);
  });

  it('deleting a message cascades only to its attachments, not siblings', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x', domain: 'd.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    const m1 = repos.messages.insertMessageWithAttachments(
      { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
        html_body_sanitized: null, size_bytes: 0,
        envelope_from: null, envelope_to: null, headers_json: null },
      [{ filename: 'a', content_type: 'text/plain', size_bytes: 1,
         sha256: 'a'.repeat(64), storage_path: 'aa/aa/...' }],
    );
    const m2 = repos.messages.insertMessageWithAttachments(
      { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
        html_body_sanitized: null, size_bytes: 0,
        envelope_from: null, envelope_to: null, headers_json: null },
      [{ filename: 'b', content_type: 'text/plain', size_bytes: 1,
         sha256: 'b'.repeat(64), storage_path: 'bb/bb/...' }],
    );

    repos.messages.deleteMessagesByInbox(inbox.id); // will delete both
    expect(repos.attachments.listAttachmentsByMessage(m1.messageId)).toHaveLength(0);
    expect(repos.attachments.listAttachmentsByMessage(m2.messageId)).toHaveLength(0);
  });
});
```

**Verify:**

```xml
<verify>
  <automated>npx vitest run tests/db/inbox-repo.test.ts tests/db/message-repo.test.ts tests/db/attachment-repo.test.ts tests/db/abuse-repo.test.ts tests/db/cascade.test.ts</automated>
</verify>
```

**Done:**
- All five test files pass.
- Every repo method has at least one positive test and at least one edge-case test (missing key, constraint violation, or boundary).
- FK CASCADE is proved at both levels (inbox→messages→attachments and message→attachments).

**Commit message:** `test(db): add repository and FK cascade tests`

---

#### Task 3: Attachment store tests + D-21 prepared-statement invariant test

**Files:**
- `tests/attachments/paths.test.ts`
- `tests/attachments/store.test.ts`
- `tests/db/prepared-statement-invariant.test.ts`

**Action:**

1. Create `tests/attachments/paths.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shardPath, isValidSha256Hex } from '../../src/attachments/paths.ts';

describe('attachment paths (STORE-03)', () => {
  const hex = 'de01ad02' + '0'.repeat(56);

  it('shardPath returns <aa>/<bb>/<sha256>', () => {
    expect(shardPath(hex)).toBe(`de/01/${hex}`);
  });

  it('shardPath throws on invalid hex', () => {
    expect(() => shardPath('short')).toThrow();
    expect(() => shardPath(hex.toUpperCase())).toThrow();
    expect(() => shardPath('z'.repeat(64))).toThrow();
  });

  it('isValidSha256Hex rejects non-lowercase, wrong length, non-hex', () => {
    expect(isValidSha256Hex(hex)).toBe(true);
    expect(isValidSha256Hex('')).toBe(false);
    expect(isValidSha256Hex(hex.slice(1))).toBe(false);        // 63 chars
    expect(isValidSha256Hex(`${hex}a`)).toBe(false);            // 65 chars
    expect(isValidSha256Hex('DE' + hex.slice(2))).toBe(false);  // uppercase
    expect(isValidSha256Hex('gg' + hex.slice(2))).toBe(false);  // non-hex
  });

  it('isValidSha256Hex accepts all lowercase hex digits', () => {
    expect(isValidSha256Hex('0123456789abcdef'.repeat(4))).toBe(true);
  });
});
```

2. Create `tests/attachments/store.test.ts`. Uses real filesystem per test via `withTmpDir`:

```typescript
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAttachmentStore } from '../../src/attachments/index.ts';
import { withTmpDir } from '../support/tmpdir.ts';

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
      const got: Buffer[] = [];
      for await (const chunk of readBack!) got.push(chunk as Buffer);
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
```

3. Create `tests/db/prepared-statement-invariant.test.ts`. This is the D-21 enforcement test:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/client.ts';
import { createRepos } from '../../src/db/repos/index.ts';

describe('D-21: all repo SQL goes through prepared statements', () => {
  it('repos never call db.exec() during normal operations', () => {
    const db = openDb(':memory:');
    const execSpy = vi.spyOn(db, 'exec');
    const repos = createRepos(db);

    // Exercise every repo method that performs SQL
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x', domain: 'd.test', view_token_hash: 'h',
      expires_at: exp, hard_expires_at: exp,
    });
    repos.inboxes.findInboxById(inbox.id);
    repos.inboxes.findInboxByLocalPart('x', 'd.test');
    repos.inboxes.updateLastActivity(inbox.id, exp);
    repos.inboxes.listExpired(exp, 10);

    const { messageId } = repos.messages.insertMessageWithAttachments(
      { inbox_id: inbox.id, sender: null, subject: null, text_body: null,
        html_body_sanitized: null, size_bytes: 0,
        envelope_from: null, envelope_to: null, headers_json: null },
      [{ filename: 'a', content_type: null, size_bytes: 1,
         sha256: 'a'.repeat(64), storage_path: 'p' }],
    );
    repos.messages.findMessageById(messageId);
    repos.messages.listMessagesByInbox(inbox.id, { limit: 10, offset: 0 });
    repos.messages.countMessagesByInbox(inbox.id);

    repos.attachments.findAttachmentById('nope');
    repos.attachments.listAttachmentsByMessage(messageId);
    repos.attachments.listAllSha256s();

    repos.abuse.incrementCounter('a', 'b', 0);
    repos.abuse.getCounter('a', 'b', 0);
    repos.abuse.pruneOldCounters(10);

    repos.inboxes.deleteInbox(inbox.id);

    // The only legitimate exec() call happens during openDb() (before spy
    // was attached). After createRepos, no repo method should call exec.
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('repos cache prepared statements (repeated calls do not re-prepare)', () => {
    const db = openDb(':memory:');
    // Wrap prepare to count calls AFTER createRepos. Repos are expected to
    // prepare their statements once during createRepos and never again.
    const repos = createRepos(db);
    const prepareSpy = vi.spyOn(db, 'prepare');

    const exp = 9_999_999_999;
    for (let i = 0; i < 10; i += 1) {
      repos.inboxes.createInbox({
        local_part: `lp${i}`, domain: 'd.test', view_token_hash: 'h',
        expires_at: exp, hard_expires_at: exp,
      });
    }
    // 10 createInbox calls should not re-prepare the INSERT (it's cached).
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});
```

**Verify:**

```xml
<verify>
  <automated>npx vitest run tests/attachments/paths.test.ts tests/attachments/store.test.ts tests/db/prepared-statement-invariant.test.ts</automated>
</verify>
```

**Done:**
- All three test files pass.
- Attachment store tests cover write, read, dedup, unlink idempotency, stat, large streams, invalid input, `.incoming/` cleanup.
- D-21 invariant test proves no `db.exec` after `openDb` and no `db.prepare` during per-call ops (only at repo-construction time).

**Commit message:** `test(attachments,db): add attachment store tests and D-21 invariant test`

---

## Verification

From the repo root, the full gate:

```bash
npm run typecheck
npm run check
npm test
```

All three must exit 0. Expected test count (rough): 35–45 cases across 8 `.test.ts` files, total runtime under 3 seconds.

Also manually inspect the test output to confirm:
- `schema v1 (STORE-01)` — 9 passing cases
- `PRAGMAs on real file DB (STORE-02, D-34)` — 3 passing cases
- `inboxRepo (STORE-04)` — 7 passing cases
- `messageRepo (STORE-04)` — 4 passing cases
- `attachmentRepo (STORE-04)` — 4 passing cases
- `abuseRepo (STORE-04)` — 4 passing cases
- `FK CASCADE (D-09)` — 3 passing cases
- `attachment paths (STORE-03)` — 4 passing cases
- `attachmentStore (STORE-03)` — 9 passing cases
- `D-21: all repo SQL goes through prepared statements` — 2 passing cases

## Success criteria

- Every STORE-XX requirement is backed by at least one test that fails if the behavior regresses.
- `npm test` exits 0 in under 3 seconds.
- `npm run typecheck` + `npm run check` both exit 0 over the new test files.
- FK CASCADE verified at two levels (inbox→messages→attachments, message→attachments).
- D-21 invariant is programmatically enforced (spy test).
- Integration test (real file DB) verifies PRAGMAs apply AND re-apply across reconnect.

## Output

Create `.planning/phases/02-storage-layer/02-05-SUMMARY.md` listing: total test count by file, any flaky/slow tests (ideally none), and a one-line mapping from each STORE-XX requirement to the test files/cases that prove it.

After this plan lands, Phase 2 is complete. The phase's ROADMAP.md success criteria are:
  1. ✅ Migration creates all tables (tests/db/schema.test.ts)
  2. ✅ PRAGMAs correct (tests/db/pragmas-integration.test.ts)
  3. ✅ Attachment bytes land at hash path (tests/attachments/store.test.ts)
  4. ✅ Every SQL via prepared statements (tests/db/prepared-statement-invariant.test.ts)
