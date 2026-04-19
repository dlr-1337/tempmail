---
phase: 3
plan: 2
status: ready
type: execute
wave: 2
depends_on: [03-01]
requirements: [CORE-01, CORE-02, CORE-05]
files_modified:
  - src/core/inboxes.ts
  - tests/core/inboxes.test.ts
autonomous: true
tags: [core, inboxes, view-token, hashing, timing-safe, expire]
must_haves:
  truths:
    - "createInbox() returns an address whose local-part has ≥64 bits of entropy"
    - "createInbox() returns a view-token distinct from the local-part and address"
    - "The DB stores only the SHA-256 hash of the view-token; the plaintext token is returned exactly once"
    - "The address is formed as `{localPart}@{domain}` where domain comes from config.domain, never hardcoded"
    - "expireInbox() returns `{ ok: true, deletedMessages, unlinkedAttachments }` on success and `{ ok: false, reason: 'not_found' }` when the inbox id is unknown"
    - "expireInbox() collects attachment sha256s BEFORE the DB delete, so the orphan check after commit can unlink files whose rows are gone"
    - "expireInbox() calls attachmentStore.unlinkBySha256 only for sha256s no longer referenced by any surviving attachment row (orphan-safe)"
    - "All DB work in expireInbox() occurs inside a single withTransaction so a mid-delete throw leaves DB state unchanged"
  artifacts:
    - path: "src/core/inboxes.ts"
      provides: "createInboxes(deps) factory returning { createInbox, expireInbox, verifyViewToken }"
      exports: ["createInboxes", "InboxesApi", "CreateInboxResult", "ExpireInboxResult", "VerifyResult", "InboxesDeps"]
    - path: "tests/core/inboxes.test.ts"
      provides: "Vitest coverage (happy path, hash separation, timing-safe compare, expire with + without attachments, unknown id)"
  key_links:
    - from: "src/core/inboxes.ts"
      to: "src/db/repos/index.ts"
      via: "Repos (deps.repos.inboxes, deps.repos.messages, deps.repos.attachments)"
      pattern: "deps\\.repos\\.(inboxes|messages|attachments)"
    - from: "src/core/inboxes.ts"
      to: "src/attachments/index.ts"
      via: "deps.attachmentStore.unlinkBySha256"
      pattern: "deps\\.attachmentStore\\.unlinkBySha256"
    - from: "src/core/inboxes.ts"
      to: "node:crypto"
      via: "createHash('sha256') + timingSafeEqual for view-token"
      pattern: "createHash|timingSafeEqual"
    - from: "src/core/inboxes.ts"
      to: "src/db/transaction.ts"
      via: "withTransaction wrapping the delete cascade"
      pattern: "withTransaction"
---

<objective>
Deliver `src/core/inboxes.ts` — the protocol-agnostic inbox operations — and its Vitest coverage. Provides `createInbox`, `expireInbox`, and a `verifyViewToken` helper used by plan 03-03's `listMessages`.

Purpose: This is the module that produces the address a user reads and the cookie a browser carries. CORE-01 (address entropy), CORE-02 (view-token separation), CORE-05 (cascade expiry + on-disk unlink) land here.

Output: One production module, one test file, conventional commits per task.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/03-core-domain-logic/03-CONTEXT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md

<interfaces>
<!-- Exact shapes from Phase 2 outputs. Do not modify these files. -->

From src/db/repos/index.ts:
```typescript
export interface Repos {
  inboxes: InboxRepo;
  messages: MessageRepo;
  attachments: AttachmentRepo;
  abuse: AbuseRepo;
}
export function createRepos(db: Db): Repos;
```

From src/db/repos/inbox-repo.ts:
```typescript
export interface NewInbox {
  local_part: string;
  domain: string;
  view_token_hash: string;   // hex, 64 chars
  expires_at: number;        // sliding TTL end
  hard_expires_at: number;   // absolute ceiling
}
export interface InboxRepo {
  createInbox(input: NewInbox): InboxRow;
  findInboxById(id: string): InboxRow | undefined;
  findInboxByLocalPart(localPart: string, domain: string): InboxRow | undefined;
  updateLastActivity(id: string, newExpiresAt: number): InboxRow | undefined;
  deleteInbox(id: string): boolean;
  listExpired(cutoff: number, limit: number): readonly InboxRow[];
}
```

From src/db/types.ts:
```typescript
export interface InboxRow {
  id: string; local_part: string; domain: string;
  view_token_hash: string;
  created_at: number; last_activity_at: number;
  expires_at: number; hard_expires_at: number;
}
```

From src/db/repos/message-repo.ts:
```typescript
export interface MessageRepo {
  listMessagesByInbox(inboxId: string, opts: { limit: number; offset: number }): readonly MessageRow[];
  countMessagesByInbox(inboxId: string): number;
  // ... others not needed here
}
```

From src/db/repos/attachment-repo.ts:
```typescript
export interface AttachmentRepo {
  listAttachmentsByMessage(messageId: string): readonly AttachmentRow[];
  listAllSha256s(): ReadonlySet<string>;
  // ... others
}
```

From src/attachments/index.ts:
```typescript
export interface AttachmentStore {
  writeAttachment(source: Readable): Promise<WriteResult>;
  readAttachment(sha256: string): Promise<Readable | null>;
  unlinkBySha256(sha256: string): Promise<boolean>;
  statBySha256(sha256: string): Promise<StatResult>;
  readonly rootDir: string;
}
```

From src/db/transaction.ts:
```typescript
export function withTransaction<T>(db: Db, fn: () => T): T;
```

From src/util/now.ts + id.ts:
```typescript
export function nowMs(): number;
export function newId(): string;      // 22-char nanoid, 132 bits
```
</interfaces>

Conventions already locked by Phase 2 (apply verbatim):
- ESM + NodeNext — relative imports use `.js` even when the source is `.ts`.
- `tsconfig.json` bans `.ts` import extensions; Biome bans `!`, `any`, unsorted imports, and un-separated large numbers (`1_000`, `10_000_000`).
- Vitest `globals: false`. Import `{ describe, expect, it, vi }` explicitly, alphabetized.
- No direct `new Database()`, no `db.prepare`, no `db.exec` anywhere in `src/core/**`. Only the repos + attachment store APIs.
</context>

## Goal

Produce a pure, dependency-injected `createInboxes(deps)` factory exposing `createInbox`, `expireInbox`, and `verifyViewToken` — the surface the SMTP adapter (Phase 4) and HTTP adapter (Phase 5) will call. Every side effect flows through the Phase 2 repos + attachment store.

## Must-have checklist

- [x] **CORE-01**: `createInbox()` local-part has ≥64 bits of entropy (D-04: reuse `newId()` = nanoid 22 = 132 bits).
- [x] **CORE-02**: View-token is distinct from the address; token never equals the local-part.
- [x] **CORE-05**: `expireInbox()` cascades message + attachment rows (via FK CASCADE from `deleteInbox`) and unlinks orphaned blobs via the attachment store.
- [x] **D-04**: Local-part generated via `newId()` (nanoid 22); no separate 16-char base32 is needed.
- [x] **D-05**: Domain comes from `deps.config.domain`.
- [x] **D-06**: View-token is an independent 22-char nanoid (132 bits ≥ 128), stored as SHA-256 hex, compared with `timingSafeEqual`.
- [x] **D-07**: Plaintext token is returned exactly once; DB keeps only the hash.
- [x] **D-17**: `expireInbox` collects sha256 list before the cascade delete, then calls `attachmentStore.unlinkBySha256` only for shas that are no longer referenced.
- [x] **D-18**: Exports `expireInbox`; does not schedule it.

## Tasks

<task type="auto" tdd="true">
  <name>Task 1: Implement createInbox + verifyViewToken + shared deps type</name>
  <files>src/core/inboxes.ts</files>
  <behavior>
    - `createInboxes(deps)` returns an object `InboxesApi`. Deps shape:
      ```typescript
      export interface InboxesDeps {
        db: Db;                       // needed for withTransaction in expireInbox
        repos: Repos;
        attachmentStore: AttachmentStore;
        config: { domain: string; idleTtlMs: number; hardTtlMs: number };
        now?: () => number;           // default nowMs
        id?: () => string;            // default newId (used for both local-part and view-token)
      }
      ```
      `idleTtlMs` and `hardTtlMs` are injected so Phase 6's sweeper values can be swapped without touching core. CONTEXT.md's retention decisions come from REQUIREMENTS.md RETN-01 (10 min idle, 1 h hard) — core does not hardcode them.
    - `createInbox(): CreateInboxResult` where:
      ```typescript
      export interface CreateInboxResult {
        ok: true;
        inboxId: string;
        address: string;        // `${localPart}@${config.domain}`
        viewToken: string;      // plaintext, returned exactly once
        expiresAt: number;      // sliding
        hardExpiresAt: number;  // ceiling
      }
      ```
      Steps:
      1. `localPart = (deps.id ?? newId)()` — 22-char nanoid.
      2. `viewToken = (deps.id ?? newId)()` — a second, independent call. Assert `viewToken !== localPart` defensively (throw a programmer-error if they collide, per D-20; collision probability ~ 2^-132).
      3. `viewTokenHash = createHash('sha256').update(viewToken).digest('hex')`.
      4. `now = (deps.now ?? nowMs)()`; `expiresAt = now + config.idleTtlMs`; `hardExpiresAt = now + config.hardTtlMs`.
      5. `row = deps.repos.inboxes.createInbox({ local_part: localPart, domain: config.domain, view_token_hash: viewTokenHash, expires_at: expiresAt, hard_expires_at: hardExpiresAt })`.
      6. Return `{ ok: true, inboxId: row.id, address: `${localPart}@${config.domain}`, viewToken, expiresAt, hardExpiresAt }`.
    - `verifyViewToken(row: InboxRow, viewToken: string): boolean`:
      1. Compute SHA-256 hex of `viewToken`.
      2. Compare against `row.view_token_hash` via `timingSafeEqual` over two equal-length `Buffer.from(hex, 'hex')` buffers. Both are 32 bytes — guaranteed equal length.
      3. Return the boolean result. NEVER throw on mismatch.
    - All three are exported from the factory object. `verifyViewToken` is also exported as a standalone function for plan 03-03 to reuse (keeps the timing-safe logic in one file).
  </behavior>
  <action>
    Create `src/core/inboxes.ts` with exactly this shape. Use `.js` extensions in every relative import. Do not import `better-sqlite3` (only the `Db` *type* re-exported from client — if needed, pull it via `import type { Db } from '../db/client.js'`).

    ```typescript
    import { createHash, timingSafeEqual } from 'node:crypto';
    import type { AttachmentStore } from '../attachments/index.js';
    import type { Db } from '../db/client.js';
    import type { Repos } from '../db/repos/index.js';
    import type { InboxRow } from '../db/types.js';
    import { withTransaction } from '../db/transaction.js';
    import { newId } from '../util/id.js';
    import { nowMs } from '../util/now.js';

    export interface InboxesConfig {
      domain: string;
      idleTtlMs: number;
      hardTtlMs: number;
    }

    export interface InboxesDeps {
      db: Db;
      repos: Repos;
      attachmentStore: AttachmentStore;
      config: InboxesConfig;
      now?: () => number;
      id?: () => string;
    }

    export interface CreateInboxResult {
      ok: true;
      inboxId: string;
      address: string;
      viewToken: string;
      expiresAt: number;
      hardExpiresAt: number;
    }

    export type ExpireInboxResult =
      | { ok: true; deletedMessages: number; unlinkedAttachments: number }
      | { ok: false; reason: 'not_found' };

    export interface InboxesApi {
      createInbox(): CreateInboxResult;
      expireInbox(input: { inboxId: string }): Promise<ExpireInboxResult>;
      verifyViewToken(row: InboxRow, viewToken: string): boolean;
    }

    /**
     * Constant-time hex-digest compare. Exported so plan 03-03's `listMessages`
     * can reuse exactly the same logic (single source of truth for D-15's
     * wrong-token -> forbidden branch).
     */
    export function verifyViewToken(row: InboxRow, viewToken: string): boolean {
      const candidate = createHash('sha256').update(viewToken).digest();     // 32 bytes
      const stored = Buffer.from(row.view_token_hash, 'hex');                 // 32 bytes
      if (candidate.length !== stored.length) return false;                   // defensive
      return timingSafeEqual(candidate, stored);
    }

    export function createInboxes(deps: InboxesDeps): InboxesApi {
      const now = deps.now ?? nowMs;
      const id = deps.id ?? newId;

      const createInbox = (): CreateInboxResult => {
        const localPart = id();
        const viewToken = id();
        if (viewToken === localPart) {
          // D-20: programmer/universe error (probability 2^-132). Throw, do not return ok:false.
          throw new Error('id() produced the same value twice — RNG broken');
        }
        const viewTokenHash = createHash('sha256').update(viewToken).digest('hex');
        const createdAt = now();
        const expiresAt = createdAt + deps.config.idleTtlMs;
        const hardExpiresAt = createdAt + deps.config.hardTtlMs;

        const row = deps.repos.inboxes.createInbox({
          local_part: localPart,
          domain: deps.config.domain,
          view_token_hash: viewTokenHash,
          expires_at: expiresAt,
          hard_expires_at: hardExpiresAt,
        });

        return {
          ok: true,
          inboxId: row.id,
          address: `${localPart}@${deps.config.domain}`,
          viewToken,
          expiresAt,
          hardExpiresAt,
        };
      };

      const expireInbox = async (input: { inboxId: string }): Promise<ExpireInboxResult> => {
        // --- Phase 1: read-only prep (outside transaction so we can walk attachments).
        const inbox = deps.repos.inboxes.findInboxById(input.inboxId);
        if (!inbox) return { ok: false, reason: 'not_found' };

        // Collect every sha256 currently referenced by this inbox's messages.
        // We use listMessagesByInbox + listAttachmentsByMessage because the
        // message-repo does not (and should not) expose a join-query just
        // for the sweeper. Inboxes are bounded (minutes-hours, tens to low
        // hundreds of messages) so this walk is cheap.
        const messageRows = deps.repos.messages.listMessagesByInbox(input.inboxId, {
          limit: 100_000,
          offset: 0,
        });
        const candidateShas = new Set<string>();
        for (const m of messageRows) {
          for (const a of deps.repos.attachments.listAttachmentsByMessage(m.id)) {
            candidateShas.add(a.sha256);
          }
        }
        const deletedMessages = messageRows.length;

        // --- Phase 2: transactional delete (FK CASCADE handles messages + attachments rows + abuse rows keyed on this inbox).
        withTransaction(deps.db, () => {
          deps.repos.inboxes.deleteInbox(input.inboxId);
        });

        // --- Phase 3: after commit, unlink only sha256s that are now orphans.
        // listAllSha256s() is a single DISTINCT query over the entire attachments
        // table — cheap and gives us the post-cascade reference set.
        const survivingShas = deps.repos.attachments.listAllSha256s();
        let unlinkedAttachments = 0;
        for (const sha of candidateShas) {
          if (survivingShas.has(sha)) continue;              // another inbox still references it
          const unlinked = await deps.attachmentStore.unlinkBySha256(sha);
          if (unlinked) unlinkedAttachments += 1;
        }

        return { ok: true, deletedMessages, unlinkedAttachments };
      };

      return {
        createInbox,
        expireInbox,
        verifyViewToken,
      };
    }
    ```

    Important constraints:
    - Never import `node:fs` or `better-sqlite3` in this file.
    - Do not mutate `deps`.
    - Keep `verifyViewToken` as both a module-level export AND a method on the returned api. The plan-04 composition root re-exports the api-level one; plan 03-03 imports the module-level one directly. Same implementation either way.
  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>File exists, `npm run typecheck` and `npm run check` exit 0. No imports of `better-sqlite3` or `node:fs`. `verifyViewToken` exported both standalone and via the api.</done>
  <commit>feat(core): add inbox operations with hashed view-token</commit>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Vitest coverage of createInbox + verifyViewToken + expireInbox</name>
  <files>tests/core/inboxes.test.ts</files>
  <behavior>
    Test style: reuse `tests/support/db-helper.ts::openTestDbWithRepos()` for an in-memory DB + wired repos; reuse `tests/support/tmpdir.ts::withTmpDir` for a real attachment store (needed so `expireInbox`'s `unlinkBySha256` has a real filesystem to act on).

    Minimum cases:

    1. `createInbox returns address, plaintext view-token, and persists hash` — `address` ends with `@example.test`, `viewToken.length === 22`, `viewToken !== localPart`, and `repos.inboxes.findInboxById(inboxId).view_token_hash !== viewToken` (i.e. DB stores hash, not plaintext).
    2. `createInbox derived hash matches verifyViewToken(row, token) === true` — fetch row, call `verifyViewToken(row, result.viewToken)` -> true; call with `'wrong-token'` -> false; with a same-length wrong string -> false.
    3. `createInbox uses config.domain, never a hardcoded default` — pass `domain: 'alt.example'`, assert address ends with `@alt.example`.
    4. `createInbox uses injected now + id for determinism` — inject fakes and assert exact address + expiresAt + hardExpiresAt values.
    5. `expireInbox returns not_found for an unknown inbox id` — no-op, no throw.
    6. `expireInbox deletes messages + unlinks orphan attachments` — create inbox A, write a real attachment to the store, insert a message-with-attachment via repos referencing that sha, verify file exists on disk, call `expireInbox({ inboxId: A })`, assert `{ ok: true, deletedMessages: 1, unlinkedAttachments: 1 }`, assert file no longer exists on disk, assert `findInboxById` returns undefined.
    7. `expireInbox does NOT unlink sha256s still referenced by another inbox` — create inbox A and inbox B, write one attachment, insert a message in A referencing it, insert a message in B referencing the same sha (reuse the existing storage_path), call `expireInbox({ inboxId: A })`, assert `unlinkedAttachments === 0`, assert file still on disk.
    8. `expireInbox on an inbox with zero messages returns deletedMessages: 0, unlinkedAttachments: 0` — boundary case.
    9. `expireInbox transaction rolls back on throw` — spy on `repos.inboxes.deleteInbox` to throw; assert inbox still exists, file still exists (no partial unlink).

    Use `vi.fn()` fakes for `now` and `id` where determinism matters (cases 1, 4). Real values elsewhere.
  </behavior>
  <action>
    Create `tests/core/inboxes.test.ts`. Skeleton (fill in the bodies):

    ```typescript
    import { createHash } from 'node:crypto';
    import { Readable } from 'node:stream';
    import { describe, expect, it, vi } from 'vitest';
    import { createAttachmentStore } from '../../src/attachments/index.js';
    import { createInboxes, verifyViewToken } from '../../src/core/inboxes.js';
    import { openTestDbWithRepos } from '../support/db-helper.js';
    import { withTmpDir } from '../support/tmpdir.js';

    const mkConfig = (overrides: Partial<{ domain: string; idleTtlMs: number; hardTtlMs: number }> = {}) => ({
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
          expect(result.viewToken.length).toBe(22);
          const row = repos.inboxes.findInboxById(result.inboxId);
          expect(row).toBeDefined();
          if (!row) return;
          expect(row.view_token_hash).not.toBe(result.viewToken);
          expect(row.view_token_hash.length).toBe(64); // sha-256 hex
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
          expect(verifyViewToken(row, result.viewToken)).toBe(true);
          expect(verifyViewToken(row, 'wrong-token-value-here!')).toBe(false);
          // Same-length-but-wrong string (22 chars) must also be false.
          expect(verifyViewToken(row, 'A'.repeat(22))).toBe(false);
        });
      });

      it('uses config.domain, never hardcoded', async () => {
        await withTmpDir(async (dir) => {
          const { db, repos } = openTestDbWithRepos();
          const attachmentStore = createAttachmentStore(dir);
          const inboxes = createInboxes({
            db, repos, attachmentStore,
            config: mkConfig({ domain: 'alt.example' }),
          });
          const result = inboxes.createInbox();
          expect(result.address.endsWith('@alt.example')).toBe(true);
        });
      });

      it('uses injected now+id for determinism', async () => {
        await withTmpDir(async (dir) => {
          const { db, repos } = openTestDbWithRepos();
          const attachmentStore = createAttachmentStore(dir);
          const ids = ['local_part_value_abc1', 'view_token_value_xyz2'];
          const id = vi.fn(() => {
            const v = ids.shift();
            if (!v) throw new Error('id() called more than expected');
            return v;
          });
          const now = vi.fn(() => 1_700_000_000_000);
          const inboxes = createInboxes({
            db, repos, attachmentStore,
            config: mkConfig({ idleTtlMs: 1_000, hardTtlMs: 10_000 }),
            now, id,
          });
          const result = inboxes.createInbox();
          expect(result.address).toBe('local_part_value_abc1@example.test');
          expect(result.viewToken).toBe('view_token_value_xyz2');
          expect(result.expiresAt).toBe(1_700_000_000_000 + 1_000);
          expect(result.hardExpiresAt).toBe(1_700_000_000_000 + 10_000);
          // Hash stored in DB must equal sha256(viewToken) hex.
          const row = repos.inboxes.findInboxById(result.inboxId);
          expect(row?.view_token_hash).toBe(
            createHash('sha256').update('view_token_value_xyz2').digest('hex'),
          );
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
              sender: 'a@b.test', subject: 'hi', text_body: 'body',
              html_body_sanitized: null, size_bytes: 11,
              envelope_from: 'a@b.test', envelope_to: result.address,
              headers_json: null,
            },
            [{ filename: 'greet.txt', content_type: 'text/plain', size_bytes: 11, sha256: write.sha256, storage_path: write.storagePath }],
          );

          expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);

          const r = await inboxes.expireInbox({ inboxId: result.inboxId });
          expect(r).toEqual({ ok: true, deletedMessages: 1, unlinkedAttachments: 1 });
          expect(repos.inboxes.findInboxById(result.inboxId)).toBeUndefined();
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
          const attach = { filename: 'x.txt', content_type: 'text/plain', size_bytes: 12, sha256: write.sha256, storage_path: write.storagePath };

          repos.messages.insertMessageWithAttachments(
            { inbox_id: a.inboxId, sender: null, subject: null, text_body: null, html_body_sanitized: null, size_bytes: 12, envelope_from: null, envelope_to: a.address, headers_json: null },
            [attach],
          );
          repos.messages.insertMessageWithAttachments(
            { inbox_id: b.inboxId, sender: null, subject: null, text_body: null, html_body_sanitized: null, size_bytes: 12, envelope_from: null, envelope_to: b.address, headers_json: null },
            [attach],
          );

          const r = await inboxes.expireInbox({ inboxId: a.inboxId });
          expect(r).toEqual({ ok: true, deletedMessages: 1, unlinkedAttachments: 0 });
          expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);
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
            { inbox_id: result.inboxId, sender: null, subject: null, text_body: null, html_body_sanitized: null, size_bytes: 12, envelope_from: null, envelope_to: result.address, headers_json: null },
            [{ filename: 'x', content_type: null, size_bytes: 12, sha256: write.sha256, storage_path: write.storagePath }],
          );

          const spy = vi.spyOn(repos.inboxes, 'deleteInbox').mockImplementation(() => {
            throw new Error('boom');
          });
          await expect(inboxes.expireInbox({ inboxId: result.inboxId })).rejects.toThrow('boom');
          spy.mockRestore();

          expect(repos.inboxes.findInboxById(result.inboxId)).toBeDefined();
          expect((await attachmentStore.statBySha256(write.sha256)).exists).toBe(true);
        });
      });
    });
    ```

    Biome will sort the imports; accept its order. If `openTestDbWithRepos` requires the `Repos` type import, add it.
  </action>
  <verify>
    <automated>npx vitest run tests/core/inboxes.test.ts</automated>
  </verify>
  <done>All ≥ 9 cases pass. `npm run check` clean. `npm run typecheck` exit 0.</done>
  <commit>test(core): cover createInbox, verifyViewToken, and expireInbox</commit>
</task>

<task type="auto">
  <name>Task 3: Plan-level gate</name>
  <files>(none created)</files>
  <action>
    Run the full suite to confirm no regressions against Phase 2 tests or the bus tests from plan 03-01 (if already merged):

    ```bash
    npm run typecheck
    npm run check
    npx vitest run
    ```
  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run</automated>
  </verify>
  <done>All three exit 0. Phase 2's 49 tests still pass.</done>
</task>

## Verification

End-to-end:

```bash
# 1. Files exist
test -f src/core/inboxes.ts
test -f tests/core/inboxes.test.ts

# 2. No forbidden imports in core
! grep -nE "from '.*better-sqlite3" src/core/ -r
! grep -nE "from 'node:fs" src/core/ -r
! grep -nE "db\.(prepare|exec)\(" src/core/ -r

# 3. Gates
npm run typecheck && npm run check && npx vitest run
```

## Success Criteria

- `src/core/inboxes.ts` exports `createInboxes`, `InboxesApi`, `InboxesDeps`, `InboxesConfig`, `CreateInboxResult`, `ExpireInboxResult`, and a module-level `verifyViewToken`.
- `tests/core/inboxes.test.ts` has ≥ 9 passing cases covering CORE-01, CORE-02, CORE-05, D-06 hash separation, D-07 one-time-token, D-17 orphan-safe unlink, transaction rollback.
- Grep confirms no `better-sqlite3`, no `node:fs`, and no raw `db.prepare`/`db.exec` in `src/core/`.
- `npm run typecheck`, `npm run check`, `npx vitest run` all exit 0.

<output>
After completion, write `.planning/phases/03-core-domain-logic/03-02-SUMMARY.md` per the summary template. Frontmatter includes `requirements: [CORE-01, CORE-02, CORE-05]` and `depends_on: [03-01]`.
</output>
