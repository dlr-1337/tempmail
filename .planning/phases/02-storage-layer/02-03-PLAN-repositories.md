---
phase: 2
plan: 3
type: execute
wave: 3
status: ready
depends_on: [1, 2]
files_modified:
  - src/db/repos/inbox-repo.ts
  - src/db/repos/message-repo.ts
  - src/db/repos/attachment-repo.ts
  - src/db/repos/abuse-repo.ts
  - src/db/repos/index.ts
  - src/db/transaction.ts
autonomous: true
requirements: [STORE-04]
must_haves:
  truths:
    - "Every SQL operation in the repo layer goes through a prepared statement cached on the repo object"
    - "No caller can get a raw db.prepare() or db.exec() — repos expose intent-named methods only"
    - "insertMessageWithAttachments() is atomic: either both message row and all attachment rows commit, or neither does"
    - "Repos return typed rows (InboxRow, MessageRow, AttachmentRow, AbuseCounterRow) — never `any` or untyped objects"
    - "createRepos(db) is the single entry point that wires all four repos to a Db handle"
  artifacts:
    - path: "src/db/repos/inbox-repo.ts"
      provides: "InboxRepo — createInbox, findInboxById, findInboxByLocalPart, updateLastActivity, deleteInbox, listExpired"
      exports: ["createInboxRepo", "InboxRepo", "NewInbox"]
    - path: "src/db/repos/message-repo.ts"
      provides: "MessageRepo — insertMessageWithAttachments, findMessageById, listMessagesByInbox, countMessagesByInbox, deleteMessagesByInbox"
      exports: ["createMessageRepo", "MessageRepo", "NewMessage", "NewAttachment"]
    - path: "src/db/repos/attachment-repo.ts"
      provides: "AttachmentRepo — findAttachmentById, listAttachmentsByMessage, listAllSha256s, deleteAttachmentsByMessage"
      exports: ["createAttachmentRepo", "AttachmentRepo"]
    - path: "src/db/repos/abuse-repo.ts"
      provides: "AbuseRepo — incrementCounter, getCounter, pruneOldCounters"
      exports: ["createAbuseRepo", "AbuseRepo"]
    - path: "src/db/repos/index.ts"
      provides: "createRepos(db) — wires all four repos; exported aggregate type `Repos`"
      exports: ["createRepos", "Repos"]
    - path: "src/db/transaction.ts"
      provides: "withTransaction<T>(db, fn) — generic transaction helper"
      exports: ["withTransaction"]
  key_links:
    - from: "src/db/repos/*.ts"
      to: "src/db/client.ts"
      via: "import type { Db }"
      pattern: "import.*type.*Db.*from"
    - from: "src/db/repos/message-repo.ts"
      to: "src/db/transaction.ts"
      via: "withTransaction for insertMessageWithAttachments"
      pattern: "withTransaction"
---

<objective>
Build the four typed repositories (`inboxRepo`, `messageRepo`, `attachmentRepo`, `abuseRepo`) over the `Db` handle from Plan 02. Every repo caches its prepared statements on construction (D-21) and exposes intent-named methods (D-22). Transactions are expressed as arrow functions passed to a `withTransaction()` helper (D-23).

This plan delivers STORE-04 ("All schema accesses use prepared statements via a single client wrapper"). It does NOT touch the filesystem (attachment bytes are plan 04); it only writes/reads the metadata rows.

Purpose: every subsequent phase (Core domain, SMTP ingestion, HTTP API, sweeper) reads/writes via these repos. This plan is the ONLY surface other phases call. No raw SQL leaks above this boundary.
Output: A `createRepos(db)` factory returning `{ inboxes, messages, attachments, abuse }`, each with typed prepared-statement methods.
</objective>

<execution_context>
Depends on Plan 02-01 (scaffolding) and Plan 02-02 (schema + openDb). The `Db` type and row types already exist; this plan consumes them.

All code: TypeScript strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`. Explicit `import type { X }` for types.
</execution_context>

<context>
@.planning/phases/02-storage-layer/02-CONTEXT.md
@.planning/phases/02-storage-layer/02-02-PLAN-schema-and-migrations.md
@.planning/research/ARCHITECTURE.md
</context>

<interfaces>
From Plan 02-02, available now:

```typescript
// src/db/client.ts
export type Db = import('better-sqlite3').Database;
export function openDb(path: string): Db;

// src/db/types.ts
export interface InboxRow { id: string; local_part: string; domain: string;
  view_token_hash: string; created_at: number; last_activity_at: number;
  expires_at: number; hard_expires_at: number; }
export interface MessageRow { id: string; inbox_id: string; sender: string | null;
  subject: string | null; text_body: string | null; html_body_sanitized: string | null;
  received_at: number; size_bytes: number; envelope_from: string | null;
  envelope_to: string | null; headers_json: string | null; }
export interface AttachmentRow { id: string; message_id: string;
  filename: string | null; content_type: string | null; size_bytes: number;
  sha256: string; storage_path: string; }
export interface AbuseCounterRow { ip_prefix: string; bucket: string;
  count: number; window_start: number; }

// src/util/id.ts
export function newId(): string; // 22-char nanoid, 132 bits

// src/util/now.ts
export function nowMs(): number; // epoch ms
```
</interfaces>

<locked_decisions>
### Client wrapper (D-20..D-23)
- **D-20:** `src/db/client.ts` exports `openDb` + typed repos (`inboxRepo`, `messageRepo`, `attachmentRepo`, `abuseRepo`). This plan creates the repos; the `index.ts` aggregator re-exports under the names CONTEXT.md references.
- **D-21:** All SQL goes through prepared statements cached on the repo object. No ad-hoc `db.prepare()` in callers of the repos.
- **D-22:** Repos expose intent-named methods (`createInbox`, `findInboxByLocalPart`, `insertMessageWithAttachments`) — not `query()` / `run()` passthroughs.
- **D-23:** Transactions expressed as arrow functions passed to `db.transaction(fn)`. We wrap this in a small `withTransaction()` helper to keep call-sites uniform.
</locked_decisions>

## Goal

Four typed repository modules plus a transaction helper, such that a caller does:

```typescript
const db = openDb('./data/tempmail.db');
const repos = createRepos(db);
const inbox = repos.inboxes.createInbox({ local_part: 'abc', domain: 'example.com', ... });
const msgId = repos.messages.insertMessageWithAttachments(msg, atts);
```

— and no caller ever touches `db.prepare(...)` directly.

## Must-have checklist

- **STORE-04**: All schema accesses via prepared statements, exposed via a single client wrapper (the `createRepos(db)` aggregate)

## Tasks

#### Task 1: `transaction.ts` helper + `inbox-repo.ts`

**Files:**
- `src/db/transaction.ts`
- `src/db/repos/inbox-repo.ts`

**Action:**

1. Create `src/db/transaction.ts` — a trivial wrapper around `db.transaction()` that gives us a consistent call-site:

```typescript
import type { Db } from './client.ts';

/**
 * Runs `fn` inside a SAVEPOINT-backed transaction.
 *
 * Semantics (better-sqlite3):
 *   - Begins on call, commits on return, rolls back on throw.
 *   - `fn` is synchronous (better-sqlite3 is sync). Do NOT return a Promise from it.
 *   - Nested `withTransaction` calls reuse the outer SAVEPOINT — safe to compose.
 *
 * Why a helper instead of inline `db.transaction(fn)()`:
 *   - Single call-site pattern (D-23) for readability.
 *   - Forces the `<T>` generic, so the return type is preserved without casts.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  // better-sqlite3's .transaction() returns a function that, when called,
  // runs the body in a transaction. We invoke it immediately.
  const wrapped = db.transaction(fn);
  return wrapped();
}
```

2. Create `src/db/repos/inbox-repo.ts`. All prepared statements are cached in closures over the factory call (D-21). Every method is intent-named (D-22):

```typescript
import type { Db } from '../client.ts';
import type { InboxRow } from '../types.ts';
import { newId } from '../../util/id.ts';
import { nowMs } from '../../util/now.ts';

/**
 * Input type for `createInbox`. Times are computed by the caller (Phase 3
 * core logic decides retention policy); we store what we're given. Caller
 * must provide `view_token_hash` pre-hashed — we never see the plaintext.
 */
export interface NewInbox {
  local_part: string;
  domain: string;
  view_token_hash: string;
  expires_at: number;        // sliding TTL (idle) end
  hard_expires_at: number;   // absolute ceiling (RETN-01, 1h from creation)
}

export interface InboxRepo {
  /** Inserts a new inbox row. `id`, `created_at`, `last_activity_at` assigned here. */
  createInbox(input: NewInbox): InboxRow;

  /** Returns the row or undefined. Never throws on missing. */
  findInboxById(id: string): InboxRow | undefined;

  /** Returns the row or undefined. Used by SMTP ingestion (RCPT TO check). */
  findInboxByLocalPart(localPart: string, domain: string): InboxRow | undefined;

  /** Bumps `last_activity_at` and extends `expires_at` to `newExpiresAt`, capped
   *  at `hard_expires_at`. Returns the updated row, or undefined if the inbox
   *  no longer exists. */
  updateLastActivity(id: string, newExpiresAt: number): InboxRow | undefined;

  /** Deletes an inbox. FK CASCADE removes all messages + attachment rows.
   *  Returns true if a row was deleted, false otherwise. Does NOT touch disk. */
  deleteInbox(id: string): boolean;

  /** Returns inbox rows whose `expires_at < cutoff`, up to `limit`.
   *  Used by the retention sweeper (Phase 6). */
  listExpired(cutoff: number, limit: number): readonly InboxRow[];
}

export function createInboxRepo(db: Db): InboxRepo {
  // Prepared statement cache. Created once, reused forever (D-21).
  const insertStmt = db.prepare<
    [string, string, string, string, number, number, number, number]
  >(`
    INSERT INTO inboxes (id, local_part, domain, view_token_hash,
      created_at, last_activity_at, expires_at, hard_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const findByIdStmt = db.prepare<[string], InboxRow>(`
    SELECT id, local_part, domain, view_token_hash,
           created_at, last_activity_at, expires_at, hard_expires_at
    FROM inboxes WHERE id = ?
  `);

  const findByLocalPartStmt = db.prepare<[string, string], InboxRow>(`
    SELECT id, local_part, domain, view_token_hash,
           created_at, last_activity_at, expires_at, hard_expires_at
    FROM inboxes WHERE local_part = ? AND domain = ?
  `);

  // Two-statement update: the UPDATE with a MIN() guard (can't exceed hard cap),
  // then a SELECT to return the row.
  const updateActivityStmt = db.prepare<[number, number, number, string]>(`
    UPDATE inboxes
    SET last_activity_at = ?,
        expires_at = MIN(?, hard_expires_at)
    WHERE id = ? AND hard_expires_at > ?
  `);

  const deleteStmt = db.prepare<[string]>('DELETE FROM inboxes WHERE id = ?');

  const listExpiredStmt = db.prepare<[number, number], InboxRow>(`
    SELECT id, local_part, domain, view_token_hash,
           created_at, last_activity_at, expires_at, hard_expires_at
    FROM inboxes
    WHERE expires_at < ?
    ORDER BY expires_at ASC
    LIMIT ?
  `);

  return {
    createInbox(input) {
      const id = newId();
      const now = nowMs();
      insertStmt.run(
        id,
        input.local_part,
        input.domain,
        input.view_token_hash,
        now,                      // created_at
        now,                      // last_activity_at
        input.expires_at,
        input.hard_expires_at,
      );
      // We just inserted with known values — return a typed row without another roundtrip.
      return {
        id,
        local_part: input.local_part,
        domain: input.domain,
        view_token_hash: input.view_token_hash,
        created_at: now,
        last_activity_at: now,
        expires_at: input.expires_at,
        hard_expires_at: input.hard_expires_at,
      };
    },

    findInboxById(id) {
      return findByIdStmt.get(id);
    },

    findInboxByLocalPart(localPart, domain) {
      return findByLocalPartStmt.get(localPart, domain);
    },

    updateLastActivity(id, newExpiresAt) {
      const now = nowMs();
      const result = updateActivityStmt.run(now, newExpiresAt, id, now);
      if (result.changes === 0) return undefined;
      return findByIdStmt.get(id);
    },

    deleteInbox(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    listExpired(cutoff, limit) {
      return listExpiredStmt.all(cutoff, limit);
    },
  };
}
```

Notes:
- `db.prepare<[ParamsTuple], RowType>(...)` — `better-sqlite3`'s generic signature: first generic is the parameter tuple, second is the row shape. Both are optional but we specify both for type safety.
- `.run(...)` returns `{ changes: number; lastInsertRowid: number | bigint }`. We only use `changes`.
- `.get(...)` returns the row or `undefined`. Good match for `findInboxById` / `findInboxByLocalPart` signatures.
- `.all(...)` returns `RowType[]`. We type it `readonly InboxRow[]` at the public interface to discourage callers from mutating.
- The UPDATE statement uses `MIN(?, hard_expires_at)` to enforce the RETN-01 ceiling at the SQL layer, not the application layer. `hard_expires_at > ?` guards against extending an already-past-hard-cap inbox.

**Verify:**

```xml
<verify>
  <automated>npx tsx -e "import {openDb} from './src/db/client.ts';import {createInboxRepo} from './src/db/repos/inbox-repo.ts';const db=openDb(':memory:');const repo=createInboxRepo(db);const now=Date.now();const ib=repo.createInbox({local_part:'abc',domain:'example.com',view_token_hash:'h',expires_at:now+600000,hard_expires_at:now+3600000});if(!ib.id||ib.id.length!==22)process.exit(1);const f=repo.findInboxById(ib.id);if(!f||f.local_part!=='abc')process.exit(2);const f2=repo.findInboxByLocalPart('abc','example.com');if(!f2||f2.id!==ib.id)process.exit(3);const u=repo.updateLastActivity(ib.id,now+900000);if(!u||u.expires_at>now+3600000)process.exit(4);const del=repo.deleteInbox(ib.id);if(!del)process.exit(5);const gone=repo.findInboxById(ib.id);if(gone)process.exit(6);console.log('inbox-repo ok')"</automated>
</verify>
```

**Done:**
- `src/db/transaction.ts` exports `withTransaction<T>(db, fn): T`.
- `src/db/repos/inbox-repo.ts` exports `createInboxRepo`, `InboxRepo`, `NewInbox`.
- All six `InboxRepo` methods work in a `:memory:` DB as shown by the smoke check.
- `npm run typecheck` passes.

**Commit message:** `feat(db): add transaction helper and inbox repository`

---

#### Task 2: `message-repo.ts` + `attachment-repo.ts`

**Files:**
- `src/db/repos/message-repo.ts`
- `src/db/repos/attachment-repo.ts`

**Action:**

1. Create `src/db/repos/attachment-repo.ts` first (message-repo depends on its insert statement shape):

```typescript
import type { Db } from '../client.ts';
import type { AttachmentRow } from '../types.ts';

export interface AttachmentRepo {
  /** Returns one attachment row or undefined. Used by `GET /api/attachments/:id`. */
  findAttachmentById(id: string): AttachmentRow | undefined;

  /** All attachments for a message, in insertion order. */
  listAttachmentsByMessage(messageId: string): readonly AttachmentRow[];

  /**
   * Returns every sha256 currently referenced by the attachments table.
   * Used by the hourly orphan reaper (Phase 6): anything on disk whose sha256
   * is not in this set is dead weight.
   *
   * Returns a Set for O(1) membership test at the reaper's call site.
   */
  listAllSha256s(): ReadonlySet<string>;

  /** Deletes all attachment rows for a message. Returns rows deleted.
   *  Note: FK CASCADE from messages already does this when a message is deleted;
   *  this method exists for callers that delete a message but want to know
   *  which attachment sha256s were orphaned so they can unlink on disk. */
  deleteAttachmentsByMessage(messageId: string): number;
}

export function createAttachmentRepo(db: Db): AttachmentRepo {
  const findByIdStmt = db.prepare<[string], AttachmentRow>(`
    SELECT id, message_id, filename, content_type, size_bytes, sha256, storage_path
    FROM attachments WHERE id = ?
  `);

  const listByMessageStmt = db.prepare<[string], AttachmentRow>(`
    SELECT id, message_id, filename, content_type, size_bytes, sha256, storage_path
    FROM attachments WHERE message_id = ?
    ORDER BY id ASC
  `);

  const listShaStmt = db.prepare<[], { sha256: string }>(
    'SELECT DISTINCT sha256 FROM attachments',
  );

  const deleteByMessageStmt = db.prepare<[string]>(
    'DELETE FROM attachments WHERE message_id = ?',
  );

  return {
    findAttachmentById(id) {
      return findByIdStmt.get(id);
    },
    listAttachmentsByMessage(messageId) {
      return listByMessageStmt.all(messageId);
    },
    listAllSha256s() {
      const rows = listShaStmt.all();
      const set = new Set<string>();
      for (const r of rows) set.add(r.sha256);
      return set;
    },
    deleteAttachmentsByMessage(messageId) {
      return deleteByMessageStmt.run(messageId).changes;
    },
  };
}
```

2. Create `src/db/repos/message-repo.ts`. The key method is `insertMessageWithAttachments` which is a single-transaction insert satisfying CORE-03 (Phase 3 will call it):

```typescript
import type { Db } from '../client.ts';
import type { MessageRow, AttachmentRow } from '../types.ts';
import { newId } from '../../util/id.ts';
import { withTransaction } from '../transaction.ts';

/**
 * Input for inserting a message. `id` and `received_at` are assigned by the repo
 * unless the caller overrides (rare — mostly for tests that pin time).
 */
export interface NewMessage {
  inbox_id: string;
  sender: string | null;
  subject: string | null;
  text_body: string | null;
  html_body_sanitized: string | null;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string | null;
  headers_json: string | null;
  /** Optional override. Default: nowMs(). */
  received_at?: number;
  /** Optional override. Default: newId(). */
  id?: string;
}

/**
 * Input for an attachment row accompanying a message.
 * The `storage_path` is assigned by the attachment-store layer (plan 04);
 * this repo only persists the metadata.
 */
export interface NewAttachment {
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  /** Optional override. Default: newId(). */
  id?: string;
}

export interface InsertResult {
  messageId: string;
  attachmentIds: readonly string[];
}

export interface MessageRepo {
  /**
   * Atomically inserts one message row and zero-or-more attachment rows.
   * All succeed or all fail — FK constraint + one transaction.
   *
   * Returns the assigned IDs. Caller uses them for log correlation and
   * for the event bus emission (Phase 3).
   */
  insertMessageWithAttachments(
    message: NewMessage,
    attachments: readonly NewAttachment[],
  ): InsertResult;

  findMessageById(id: string): MessageRow | undefined;

  /**
   * Returns messages for an inbox, newest first (ORDER BY received_at DESC),
   * paginated by a simple LIMIT/OFFSET. The API in Phase 5 will wrap this.
   */
  listMessagesByInbox(
    inboxId: string,
    opts: { limit: number; offset: number },
  ): readonly MessageRow[];

  countMessagesByInbox(inboxId: string): number;

  /** Deletes all messages for an inbox (rare — usually the inbox DELETE cascades).
   *  Exists for completeness; returns rows deleted. */
  deleteMessagesByInbox(inboxId: string): number;
}

export function createMessageRepo(db: Db): MessageRepo {
  const insertMsgStmt = db.prepare<
    [string, string, string | null, string | null, string | null, string | null,
      number, number, string | null, string | null, string | null]
  >(`
    INSERT INTO messages (id, inbox_id, sender, subject, text_body,
      html_body_sanitized, received_at, size_bytes, envelope_from,
      envelope_to, headers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAttStmt = db.prepare<
    [string, string, string | null, string | null, number, string, string]
  >(`
    INSERT INTO attachments (id, message_id, filename, content_type,
      size_bytes, sha256, storage_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const findByIdStmt = db.prepare<[string], MessageRow>(`
    SELECT id, inbox_id, sender, subject, text_body, html_body_sanitized,
           received_at, size_bytes, envelope_from, envelope_to, headers_json
    FROM messages WHERE id = ?
  `);

  const listByInboxStmt = db.prepare<[string, number, number], MessageRow>(`
    SELECT id, inbox_id, sender, subject, text_body, html_body_sanitized,
           received_at, size_bytes, envelope_from, envelope_to, headers_json
    FROM messages
    WHERE inbox_id = ?
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `);

  const countByInboxStmt = db.prepare<[string], { c: number }>(
    'SELECT COUNT(*) AS c FROM messages WHERE inbox_id = ?',
  );

  const deleteByInboxStmt = db.prepare<[string]>(
    'DELETE FROM messages WHERE inbox_id = ?',
  );

  return {
    insertMessageWithAttachments(message, attachments) {
      const messageId = message.id ?? newId();
      const receivedAt = message.received_at ?? Date.now();

      // Pre-assign attachment IDs so we can return them outside the transaction.
      const attachmentIds = attachments.map((a) => a.id ?? newId());

      withTransaction(db, () => {
        insertMsgStmt.run(
          messageId,
          message.inbox_id,
          message.sender,
          message.subject,
          message.text_body,
          message.html_body_sanitized,
          receivedAt,
          message.size_bytes,
          message.envelope_from,
          message.envelope_to,
          message.headers_json,
        );
        for (let i = 0; i < attachments.length; i += 1) {
          const att = attachments[i];
          const attId = attachmentIds[i];
          if (!att || !attId) continue; // noUncheckedIndexedAccess appeasement
          insertAttStmt.run(
            attId,
            messageId,
            att.filename,
            att.content_type,
            att.size_bytes,
            att.sha256,
            att.storage_path,
          );
        }
      });

      return { messageId, attachmentIds };
    },

    findMessageById(id) {
      return findByIdStmt.get(id);
    },

    listMessagesByInbox(inboxId, opts) {
      return listByInboxStmt.all(inboxId, opts.limit, opts.offset);
    },

    countMessagesByInbox(inboxId) {
      const r = countByInboxStmt.get(inboxId);
      return r?.c ?? 0;
    },

    deleteMessagesByInbox(inboxId) {
      return deleteByInboxStmt.run(inboxId).changes;
    },
  };
}
```

Key design points:
- `insertMessageWithAttachments` wraps the whole multi-row insert in `withTransaction`. This is the atomic ingestion path required by CORE-03 (Phase 3).
- Attachment IDs are generated BEFORE the transaction opens so they can be returned to the caller even after the transaction closes — pure values, no cross-tx state leak.
- `noUncheckedIndexedAccess: true` forces us to check `att` and `attId` for `undefined` — this is a TS-compiler constraint, not a runtime bug. The `continue` is unreachable given our own pre-allocation but satisfies the type checker.
- `deleteMessagesByInbox` exists for completeness; in practice Phase 6's sweeper will just `DELETE FROM inboxes WHERE id IN (...)` and rely on FK CASCADE.

**Verify:**

```xml
<verify>
  <automated>npx tsx -e "import {openDb} from './src/db/client.ts';import {createInboxRepo} from './src/db/repos/inbox-repo.ts';import {createMessageRepo} from './src/db/repos/message-repo.ts';import {createAttachmentRepo} from './src/db/repos/attachment-repo.ts';const db=openDb(':memory:');const ib=createInboxRepo(db);const ms=createMessageRepo(db);const at=createAttachmentRepo(db);const now=Date.now();const inbox=ib.createInbox({local_part:'x',domain:'d.test',view_token_hash:'h',expires_at:now+600000,hard_expires_at:now+3600000});const {messageId,attachmentIds}=ms.insertMessageWithAttachments({inbox_id:inbox.id,sender:'a@b',subject:'hi',text_body:'t',html_body_sanitized:null,size_bytes:100,envelope_from:'a@b',envelope_to:'x@d.test',headers_json:'{}'},[{filename:'f.txt',content_type:'text/plain',size_bytes:10,sha256:'deadbeef',storage_path:'de/ad/deadbeef'}]);if(attachmentIds.length!==1)process.exit(1);const atts=at.listAttachmentsByMessage(messageId);if(atts.length!==1||atts[0].sha256!=='deadbeef')process.exit(2);const shas=at.listAllSha256s();if(!shas.has('deadbeef'))process.exit(3);const msgs=ms.listMessagesByInbox(inbox.id,{limit:10,offset:0});if(msgs.length!==1)process.exit(4);const cnt=ms.countMessagesByInbox(inbox.id);if(cnt!==1)process.exit(5);// FK CASCADE test: delete the inbox and verify messages + attachments vanish
ib.deleteInbox(inbox.id);const cnt2=ms.countMessagesByInbox(inbox.id);if(cnt2!==0)process.exit(6);const shas2=at.listAllSha256s();if(shas2.has('deadbeef'))process.exit(7);console.log('message+attachment repos ok')"</automated>
</verify>
```

**Done:**
- `src/db/repos/message-repo.ts` exports `createMessageRepo`, `MessageRepo`, `NewMessage`, `NewAttachment`, `InsertResult`.
- `src/db/repos/attachment-repo.ts` exports `createAttachmentRepo`, `AttachmentRepo`.
- `insertMessageWithAttachments` is atomic (verified by CASCADE test: deleting the inbox removes both the message and its attachments).
- `listAllSha256s` returns a Set of unique digests.
- `npm run typecheck` passes.

**Commit message:** `feat(db): add message and attachment repositories with atomic insert`

---

#### Task 3: `abuse-repo.ts` + `repos/index.ts` aggregator

**Files:**
- `src/db/repos/abuse-repo.ts`
- `src/db/repos/index.ts`

**Action:**

1. Create `src/db/repos/abuse-repo.ts`. `abuse_counters` is an UPSERT-heavy table (one row per (ip_prefix, bucket, window_start) triple; `incrementCounter` uses `ON CONFLICT ... DO UPDATE` for atomicity):

```typescript
import type { Db } from '../client.ts';
import type { AbuseCounterRow } from '../types.ts';

export interface AbuseRepo {
  /**
   * Atomically increments the counter for (ip_prefix, bucket, window_start).
   * Inserts the row if it doesn't exist (UPSERT). Returns the counter's new value.
   *
   * Time bucketing: the caller picks `window_start` by flooring nowMs() to the
   * window size (e.g., 60s buckets => `Math.floor(now/60000)*60000`). The repo
   * is bucket-size-agnostic.
   */
  incrementCounter(ipPrefix: string, bucket: string, windowStart: number): number;

  /** Returns the count for a specific (prefix, bucket, window). 0 if absent. */
  getCounter(ipPrefix: string, bucket: string, windowStart: number): number;

  /** Deletes counter rows whose `window_start < cutoff`. Returns rows deleted.
   *  Phase 6's sweeper calls this with a cutoff of ~1h ago. */
  pruneOldCounters(cutoff: number): number;
}

export function createAbuseRepo(db: Db): AbuseRepo {
  // UPSERT. On conflict on the composite PK, add 1 to the existing count.
  // RETURNING gives us the final count without a second SELECT round-trip.
  const upsertStmt = db.prepare<[string, string, number], { count: number }>(`
    INSERT INTO abuse_counters (ip_prefix, bucket, count, window_start)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (ip_prefix, bucket, window_start) DO UPDATE
      SET count = count + 1
    RETURNING count
  `);

  const getStmt = db.prepare<[string, string, number], { count: number }>(`
    SELECT count FROM abuse_counters
    WHERE ip_prefix = ? AND bucket = ? AND window_start = ?
  `);

  const pruneStmt = db.prepare<[number]>(
    'DELETE FROM abuse_counters WHERE window_start < ?',
  );

  return {
    incrementCounter(ipPrefix, bucket, windowStart) {
      const row = upsertStmt.get(ipPrefix, bucket, windowStart);
      return row?.count ?? 0;
    },
    getCounter(ipPrefix, bucket, windowStart) {
      const row = getStmt.get(ipPrefix, bucket, windowStart);
      return row?.count ?? 0;
    },
    pruneOldCounters(cutoff) {
      return pruneStmt.run(cutoff).changes;
    },
  };
}
```

Notes:
- SQLite 3.35+ supports `RETURNING` on UPSERT. Our `better-sqlite3@12` ships with SQLite >= 3.45 (per STACK.md) so this is safe.
- `ON CONFLICT (...) DO UPDATE` uses the composite PK as the conflict target — SQLite automatically uses it since we declared PK on those three columns.

2. Create `src/db/repos/index.ts` — the aggregate factory and type. This is the module every outside caller imports from:

```typescript
import type { Db } from '../client.ts';

import { createInboxRepo, type InboxRepo } from './inbox-repo.ts';
import { createMessageRepo, type MessageRepo } from './message-repo.ts';
import { createAttachmentRepo, type AttachmentRepo } from './attachment-repo.ts';
import { createAbuseRepo, type AbuseRepo } from './abuse-repo.ts';

/**
 * Aggregate of all four repositories, wired to a single `Db` handle.
 *
 * Usage:
 *   const db = openDb('./data/tempmail.db');
 *   const repos = createRepos(db);
 *   const inbox = repos.inboxes.createInbox({...});
 *
 * Every repo caches its prepared statements on first call and reuses them
 * for the lifetime of the `Db` handle (D-19, D-21).
 */
export interface Repos {
  inboxes: InboxRepo;
  messages: MessageRepo;
  attachments: AttachmentRepo;
  abuse: AbuseRepo;
}

export function createRepos(db: Db): Repos {
  return {
    inboxes: createInboxRepo(db),
    messages: createMessageRepo(db),
    attachments: createAttachmentRepo(db),
    abuse: createAbuseRepo(db),
  };
}

// Re-export the per-repo types so callers can write
//   `function handle(repos: Repos) { ... }`
// or
//   `function save(r: InboxRepo, input: NewInbox) { ... }`
// without a deeper import path.
export type { InboxRepo, NewInbox } from './inbox-repo.ts';
export type {
  MessageRepo,
  NewMessage,
  NewAttachment,
  InsertResult,
} from './message-repo.ts';
export type { AttachmentRepo } from './attachment-repo.ts';
export type { AbuseRepo } from './abuse-repo.ts';
```

**Verify:**

```xml
<verify>
  <automated>npx tsx -e "import {openDb} from './src/db/client.ts';import {createRepos} from './src/db/repos/index.ts';const db=openDb(':memory:');const r=createRepos(db);// abuse counter flow
const c1=r.abuse.incrementCounter('1.2.3.0/24','inbox_create',60000);const c2=r.abuse.incrementCounter('1.2.3.0/24','inbox_create',60000);const c3=r.abuse.incrementCounter('1.2.3.0/24','inbox_create',60000);if(c1!==1||c2!==2||c3!==3)process.exit(1);const g=r.abuse.getCounter('1.2.3.0/24','inbox_create',60000);if(g!==3)process.exit(2);const other=r.abuse.getCounter('9.9.9.0/24','inbox_create',60000);if(other!==0)process.exit(3);const pruned=r.abuse.pruneOldCounters(100000);if(pruned!==1)process.exit(4);const gone=r.abuse.getCounter('1.2.3.0/24','inbox_create',60000);if(gone!==0)process.exit(5);// Repos aggregate has all four
if(!r.inboxes||!r.messages||!r.attachments||!r.abuse)process.exit(6);console.log('abuse-repo + createRepos ok')"</automated>
</verify>
```

**Done:**
- `src/db/repos/abuse-repo.ts` exports `createAbuseRepo`, `AbuseRepo`.
- `incrementCounter` is atomic UPSERT (three increments return 1, 2, 3).
- `src/db/repos/index.ts` exports `createRepos(db)` returning all four repos, plus re-exports all repo types.
- `npm run typecheck` passes.
- `npm run check` passes.

**Commit message:** `feat(db): add abuse counter repository and repos aggregate factory`

---

## Verification

From the repo root:

```bash
npm run typecheck
npm run check
# Functional smoke: the three inline smoke tests above all pass.
# Proper Vitest tests land in plan 05.
```

Plus: grep for rogue `db.prepare` or `db.exec` outside `src/db/`:

```bash
# Anything outside src/db/ that touches db.prepare() or db.exec() means D-21 is violated.
grep -rE "\\.(prepare|exec)\\(" src/ --include="*.ts" | grep -v "src/db/"
# Expected: zero matches.
```

## Success criteria

- STORE-04 satisfied: every SQL statement in the repo layer is a prepared statement cached on the repo object.
- No `any` types in any repo. All inputs / outputs typed via `InboxRow`, `MessageRow`, `AttachmentRow`, `AbuseCounterRow`, `NewInbox`, `NewMessage`, `NewAttachment`.
- `insertMessageWithAttachments` is atomic (FK CASCADE test in task 2's verify proves transactional semantics hold).
- `createRepos(db)` is the single surface every outside caller imports.
- Zero raw `db.prepare` or `db.exec` calls outside `src/db/`.

## Output

Create `.planning/phases/02-storage-layer/02-03-SUMMARY.md` listing: each repo's public method signatures (copy from the `InboxRepo` / `MessageRepo` / etc. interfaces), the transaction helper signature, and the full `Repos` aggregate shape. This summary is what Phase 3's planner will cite when wiring core domain logic to the repos.
