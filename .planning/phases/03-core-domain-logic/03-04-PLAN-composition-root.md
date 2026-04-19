---
phase: 3
plan: 4
status: ready
type: execute
wave: 3
depends_on: [03-01, 03-02, 03-03]
requirements: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05]
files_modified:
  - src/core/index.ts
  - src/core/types.ts
  - tests/core/composition.test.ts
  - tests/core/no-direct-db.test.ts
autonomous: true
tags: [core, composition-root, invariant-test, grep-test]
must_haves:
  truths:
    - "src/core/index.ts exports createCore(deps) which wires the bus, inboxes, and messages modules under a single api"
    - "createCore(deps) constructs exactly one bus per call (via createBus()) and exposes it on the returned object so external adapters can subscribe"
    - "A grep-based invariant test proves no file under src/core/**/*.ts imports better-sqlite3, imports node:fs, calls db.prepare, or calls db.exec"
    - "A composition end-to-end test confirms createCore → createInbox → ingestMessage (via envelopeTo from createInbox's address) → listMessages with the view-token returns the message"
    - "src/core/types.ts re-exports the public shapes so external adapters import from 'src/core' as a single surface"
  artifacts:
    - path: "src/core/index.ts"
      provides: "createCore(deps) + public barrel for the core module"
      exports: ["createCore", "CoreApi", "CoreDeps", "CoreConfig"]
    - path: "src/core/types.ts"
      provides: "public type re-exports (barrel for callers)"
    - path: "tests/core/no-direct-db.test.ts"
      provides: "grep invariant — no better-sqlite3, no node:fs, no db.prepare, no db.exec under src/core/"
    - path: "tests/core/composition.test.ts"
      provides: "end-to-end test that createCore wires modules correctly and satisfies every CORE-* success criterion"
  key_links:
    - from: "src/core/index.ts"
      to: "src/core/bus.ts"
      via: "createBus() call"
      pattern: "createBus\\("
    - from: "src/core/index.ts"
      to: "src/core/inboxes.ts"
      via: "createInboxes(...) call"
      pattern: "createInboxes\\("
    - from: "src/core/index.ts"
      to: "src/core/messages.ts"
      via: "createMessages(...) call"
      pattern: "createMessages\\("
---

<objective>
Deliver the Phase 3 composition root (`src/core/index.ts`), a public type barrel (`src/core/types.ts`), and two tests: a grep-based invariant proving the D-03 "no direct DB access in core" boundary, and an end-to-end composition test proving every CORE-* success criterion through the public api.

Purpose: This plan collapses plans 01/02/03 into one `createCore(deps)` surface that Phase 4 (SMTP), Phase 5 (HTTP), and Phase 6 (sweeper) import from. It also enforces D-03 programmatically so future refactors can't sneak a `db.prepare` into `src/core/`.

Output: Two production files, two test files, conventional commits per task.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/03-core-domain-logic/03-CONTEXT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md

<interfaces>
<!-- The three preceding Phase 3 plans. All must be merged before plan 04 lands. -->

From src/core/bus.ts (plan 01):
```typescript
export function createBus(): Bus;
export interface Bus { emit; on; once; }
export interface BusEvents { message: MessageEvent }
export interface MessageEvent { inboxId; messageId; receivedAt }
```

From src/core/inboxes.ts (plan 02):
```typescript
export function createInboxes(deps: InboxesDeps): InboxesApi;
export function verifyViewToken(row: InboxRow, viewToken: string): boolean;
export interface InboxesConfig { domain: string; idleTtlMs: number; hardTtlMs: number }
export interface InboxesApi { createInbox; expireInbox; verifyViewToken }
export type CreateInboxResult = ...;
export type ExpireInboxResult = ...;
```

From src/core/messages.ts (plan 03):
```typescript
export function createMessages(deps: MessagesDeps): MessagesApi;
export interface MessagesApi { ingestMessage; listMessages }
export interface MessagesConfig { domain: string; idleTtlMs: number }
export type IngestInput = ...;
export type IngestResult = ...;
export type ListMessagesResult = ...;
```

From src/db/repos/index.ts:
```typescript
export function createRepos(db: Db): Repos;
```

From src/attachments/index.ts:
```typescript
export function createAttachmentStore(rootDir: string): AttachmentStore;
```
</interfaces>

Conventions (locked): ESM + NodeNext `.js` imports, Biome strict, Vitest explicit imports, no `better-sqlite3`/`node:fs`/`db.prepare`/`db.exec` under `src/core/`.

Skill references:
- Phase 2 plan 02-05 shipped `tests/db/prepared-statement-invariant.test.ts` using `vi.spyOn` on db.prepare/exec. This plan adds a *source-grep* invariant (different shape — catches at the static level what the spy catches at the runtime level).
</context>

## Goal

Publish a single `createCore(deps)` entry point for Phase 4/5/6 to import, and lock the D-03 boundary with a grep-based invariant test that will fail loudly if any future change imports better-sqlite3 or node:fs into `src/core/**`.

## Must-have checklist

- [x] **CORE-01 / CORE-02**: Surfaced through `core.createInbox()` (wired to plan 02).
- [x] **CORE-03**: Surfaced through `core.ingestMessage()` (wired to plan 03) with plan 01's bus.
- [x] **CORE-04**: Surfaced through `core.listMessages()` (wired to plan 03).
- [x] **CORE-05**: Surfaced through `core.expireInbox()` (wired to plan 02).
- [x] **D-01, D-02, D-03**: Single module root `src/core/`, one factory `createCore(deps)`, no direct DB access — enforced by the grep invariant.
- [x] **D-09**: One shared bus per `createCore` call, exposed as `core.bus` for the process to attach SSE listeners to.

## Tasks

<task type="auto" tdd="true">
  <name>Task 1: Implement the composition root (createCore) + public types barrel</name>
  <files>src/core/index.ts, src/core/types.ts</files>
  <behavior>
    `src/core/index.ts` exports `createCore(deps: CoreDeps): CoreApi`. Shapes:

    ```typescript
    export interface CoreConfig {
      domain: string;       // single domain for v1 (CONTEXT.md 'out of scope: multi-domain')
      idleTtlMs: number;    // RETN-01: 10 * 60 * 1_000 default in prod
      hardTtlMs: number;    // RETN-01: 60 * 60 * 1_000 default in prod
    }

    export interface CoreDeps {
      db: Db;
      repos: Repos;
      attachmentStore: AttachmentStore;
      config: CoreConfig;
      now?: () => number;   // injectable for determinism
      id?: () => string;
    }

    export interface CoreApi {
      bus: Bus;                                               // exposed so SSE can subscribe
      createInbox: InboxesApi['createInbox'];
      expireInbox: InboxesApi['expireInbox'];
      ingestMessage: MessagesApi['ingestMessage'];
      listMessages: MessagesApi['listMessages'];
    }
    ```

    Body (exact):

    ```typescript
    import type { AttachmentStore } from '../attachments/index.js';
    import type { Db } from '../db/client.js';
    import type { Repos } from '../db/repos/index.js';
    import { type Bus, createBus } from './bus.js';
    import { type InboxesApi, createInboxes } from './inboxes.js';
    import { type MessagesApi, createMessages } from './messages.js';

    export interface CoreConfig {
      domain: string;
      idleTtlMs: number;
      hardTtlMs: number;
    }

    export interface CoreDeps {
      db: Db;
      repos: Repos;
      attachmentStore: AttachmentStore;
      config: CoreConfig;
      now?: () => number;
      id?: () => string;
    }

    export interface CoreApi {
      readonly bus: Bus;
      createInbox: InboxesApi['createInbox'];
      expireInbox: InboxesApi['expireInbox'];
      ingestMessage: MessagesApi['ingestMessage'];
      listMessages: MessagesApi['listMessages'];
    }

    /**
     * Wires bus + inboxes + messages into one object.
     *
     * Exactly one bus is created per call; the returned `core.bus` is the object
     * Phase 5's SSE handler will subscribe to. Production callers construct `core`
     * exactly once at startup and share it between the SMTP and HTTP adapters.
     * Tests may construct one per test for isolation.
     */
    export function createCore(deps: CoreDeps): CoreApi {
      const bus = createBus();
      const inboxes = createInboxes({
        db: deps.db,
        repos: deps.repos,
        attachmentStore: deps.attachmentStore,
        config: {
          domain: deps.config.domain,
          idleTtlMs: deps.config.idleTtlMs,
          hardTtlMs: deps.config.hardTtlMs,
        },
        now: deps.now,
        id: deps.id,
      });
      const messages = createMessages({
        repos: deps.repos,
        bus,
        config: {
          domain: deps.config.domain,
          idleTtlMs: deps.config.idleTtlMs,
        },
        now: deps.now,
      });

      return {
        bus,
        createInbox: inboxes.createInbox,
        expireInbox: inboxes.expireInbox,
        ingestMessage: messages.ingestMessage,
        listMessages: messages.listMessages,
      };
    }

    // Re-exports so callers only need to import from 'src/core/index.js'.
    export type { Bus, BusEvents, MessageEvent } from './bus.js';
    export type {
      CreateInboxResult,
      ExpireInboxResult,
      InboxesApi,
    } from './inboxes.js';
    export type {
      AttachmentView,
      IngestAttachmentInput,
      IngestInput,
      IngestResult,
      ListMessagesInput,
      ListMessagesResult,
      MessageView,
      MessagesApi,
    } from './messages.js';
    ```

    `src/core/types.ts` is a thin companion barrel — useful when a caller only wants types and doesn't want to pull the factory. It re-exports the same types:

    ```typescript
    /**
     * Type-only barrel for external callers that need Core shapes without
     * importing the factory (e.g. interface-only consumers, mock helpers).
     * The runtime exports live in './index.js'.
     */
    export type { Bus, BusEvents, MessageEvent } from './bus.js';
    export type {
      CreateInboxResult,
      ExpireInboxResult,
      InboxesApi,
    } from './inboxes.js';
    export type {
      AttachmentView,
      IngestAttachmentInput,
      IngestInput,
      IngestResult,
      ListMessagesInput,
      ListMessagesResult,
      MessageView,
      MessagesApi,
    } from './messages.js';
    export type { CoreApi, CoreConfig, CoreDeps } from './index.js';
    ```

    Constraints:
    - `createCore` must NOT instantiate any DB, any attachment store, or read any config from the environment. All I/O dependencies are injected.
    - Exactly one call to `createBus()` per `createCore()` invocation — verified in Task 3's test by observing the identity of `core.bus` versus a second call.
    - No `console.log` in `src/core/index.ts`.
  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>Both files exist; typecheck + biome clean; `createCore`, `CoreApi`, `CoreConfig`, `CoreDeps` exported from `src/core/index.ts`.</done>
  <commit>feat(core): add composition root with createCore(deps)</commit>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Grep invariant test — no direct DB access in src/core/</name>
  <files>tests/core/no-direct-db.test.ts</files>
  <behavior>
    The test walks every `.ts` file under `src/core/` and fails if any file matches:

    - `import * from 'better-sqlite3'` or `require('better-sqlite3')` (bare package)
    - `from 'node:fs'` or `from 'node:fs/promises'` or `require('node:fs...')`
    - `db.prepare(` or `db.exec(`

    File discovery uses `node:fs`'s `readdirSync({ recursive: true })` (available on Node 20+, confirmed on the project's Node 22 LTS target). This is test-time-only; production `src/core/**` still has no `node:fs` import.

    Exactly four cases:

    1. `src/core/ contains at least one .ts file` — sanity; if the directory is empty, the other assertions pass vacuously. Without this guard, the invariant is useless.
    2. `no file under src/core/ imports better-sqlite3`
    3. `no file under src/core/ imports node:fs` (or `node:fs/promises`)
    4. `no file under src/core/ calls db.prepare( or db.exec(`

    Each test lists the offending files in the assertion failure message so a future contributor sees exactly which file broke the invariant.
  </behavior>
  <action>
    Create `tests/core/no-direct-db.test.ts`:

    ```typescript
    import { readFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { describe, expect, it } from 'vitest';

    // Resolve the repo's src/core/ directory relative to this test file.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const CORE_DIR = join(here, '..', '..', 'src', 'core');

    const listCoreTsFiles = (): readonly string[] => {
      const entries = readdirSync(CORE_DIR, { recursive: true, withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!e.name.endsWith('.ts')) continue;
        // `parentPath` on Node 22, fall back to `path` for older typings.
        const dir = (e as { parentPath?: string }).parentPath ?? CORE_DIR;
        files.push(join(dir, e.name));
      }
      return files;
    };

    const findOffenders = (files: readonly string[], predicate: (src: string) => boolean): readonly string[] => {
      const bad: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, 'utf8');
        if (predicate(src)) bad.push(f);
      }
      return bad;
    };

    describe('D-03 invariant: src/core/ does not touch the DB or filesystem directly', () => {
      const files = listCoreTsFiles();

      it('src/core/ has at least one .ts file (sanity)', () => {
        expect(files.length).toBeGreaterThan(0);
      });

      it('no file imports better-sqlite3', () => {
        const bad = findOffenders(files, (src) =>
          /from\s+['"]better-sqlite3['"]/.test(src) || /require\s*\(\s*['"]better-sqlite3['"]/.test(src),
        );
        expect(bad, `offenders: ${bad.join(', ')}`).toEqual([]);
      });

      it('no file imports node:fs (or node:fs/promises)', () => {
        const bad = findOffenders(files, (src) =>
          /from\s+['"]node:fs(?:\/promises)?['"]/.test(src) ||
          /require\s*\(\s*['"]node:fs(?:\/promises)?['"]/.test(src),
        );
        expect(bad, `offenders: ${bad.join(', ')}`).toEqual([]);
      });

      it('no file calls db.prepare( or db.exec(', () => {
        const bad = findOffenders(files, (src) => /\bdb\.(prepare|exec)\s*\(/.test(src));
        expect(bad, `offenders: ${bad.join(', ')}`).toEqual([]);
      });
    });
    ```

    Notes:
    - `readdirSync({ recursive: true, withFileTypes: true })` is stable on Node 22. If the project's installed `@types/node` version pre-dates the `parentPath` field, the fallback to `CORE_DIR` covers single-level files; the cast is the narrowest acceptable shape.
    - This test adds the ONLY `node:fs` import under `tests/core/`. The invariant-test file itself lives under `tests/`, not `src/core/`, so it is not subject to the invariant it enforces.
  </action>
  <verify>
    <automated>npx vitest run tests/core/no-direct-db.test.ts</automated>
  </verify>
  <done>All 4 cases pass. Manually verify by introducing a single offending line (e.g. add `import 'better-sqlite3';` to `src/core/bus.ts` temporarily) and confirming at least one case fails — then revert. Do NOT commit the offender.</done>
  <commit>test(core): enforce D-03 no-direct-db invariant via source grep</commit>
</task>

<task type="auto" tdd="true">
  <name>Task 3: End-to-end composition test — createCore wires everything correctly</name>
  <files>tests/core/composition.test.ts</files>
  <behavior>
    Test that Phase 3's ROADMAP success criteria are all satisfied through the public `createCore(deps)` surface:

    1. `createCore(deps).createInbox() returns address + distinct view-token; the address local-part has ≥64 bits of entropy (length >= 11 chars of nanoid alphabet, which is ~66 bits)` — sanity check plan-02's already-tested behavior still surfaces through createCore.
    2. `each createCore call instantiates its own bus` — construct two cores sharing the same repos+store, assert `a.bus !== b.bus`.
    3. `ingestMessage to the address from createInbox writes the message and emits on core.bus within the same tick (synchronous)` — attach listener, ingest, assert listener called exactly once with `{ inboxId, messageId, receivedAt }`.
    4. `listMessages with the view-token returns the just-ingested message in ASC order` — ingest 2 messages with distinct received_at, list, verify order.
    5. `listMessages with the wrong view-token returns forbidden; with an unknown id returns not_found` — plan-03 coverage re-verified through the public surface.
    6. `expireInbox cascades messages + unlinks orphan attachment files` — full walk: create inbox → write attachment via attachmentStore → ingest message referencing it → expireInbox → assert DB row gone, file gone, result counts match.

    Use `tests/support/tmpdir.ts::withTmpDir` + `tests/support/db-helper.ts::openTestDbWithRepos` + `createAttachmentStore(dir)`.
  </behavior>
  <action>
    Create `tests/core/composition.test.ts`:

    ```typescript
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
          expect(r.address.endsWith('@example.test')).toBe(true);
          const localPart = r.address.split('@')[0] ?? '';
          expect(localPart.length).toBeGreaterThanOrEqual(11);  // >= ~66 bits of nanoid entropy
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
            db, repos, attachmentStore, config: defaultConfig(),
            now: () => {
              const v = t;
              t += 100;
              return v;
            },
          });
          const inbox = core.createInbox();
          const ingest = (subject: string) =>
            core.ingestMessage({
              envelopeTo: inbox.address,
              envelopeFrom: null, sender: null, subject,
              textBody: null, htmlBody: null, headers: null,
              attachments: [], sizeBytes: 1,
            });
          ingest('first');
          ingest('second');
          ingest('third');

          const list = core.listMessages({ inboxId: inbox.inboxId, viewToken: inbox.viewToken });
          expect(list.ok).toBe(true);
          if (!list.ok) return;
          // The `now` counter ran during createInbox's timestamps too; the exact values
          // don't matter, only that list order is ASC and subjects are in ingest order.
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

          expect(core.listMessages({ inboxId: inbox.inboxId, viewToken: 'WRONG!' })).toEqual({
            ok: false, reason: 'forbidden',
          });
          expect(core.listMessages({ inboxId: 'nope', viewToken: 'anything' })).toEqual({
            ok: false, reason: 'not_found',
          });
        });
      });

      it('expireInbox cascades DB rows and unlinks orphan attachment blobs', async () => {
        await withTmpDir(async (dir) => {
          const { db, repos } = openTestDbWithRepos();
          const attachmentStore = createAttachmentStore(dir);
          const core = createCore({ db, repos, attachmentStore, config: defaultConfig() });
          const inbox = core.createInbox();

          const write = await attachmentStore.writeAttachment(Readable.from(['end-to-end-bytes']));
          const ingest = core.ingestMessage({
            envelopeTo: inbox.address,
            envelopeFrom: 'a@b.test', sender: null, subject: 'with-attach',
            textBody: null, htmlBody: null, headers: null,
            attachments: [{ filename: 'x.bin', contentType: 'application/octet-stream', size: write.sizeBytes, sha256: write.sha256, path: write.storagePath }],
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
    ```
  </action>
  <verify>
    <automated>npx vitest run tests/core/composition.test.ts</automated>
  </verify>
  <done>All 6 cases pass. `npm run check` clean. `npm run typecheck` exit 0.</done>
  <commit>test(core): end-to-end composition root coverage</commit>
</task>

<task type="auto">
  <name>Task 4: Final plan-level gate — full suite green</name>
  <files>(none created)</files>
  <action>
    ```bash
    npm run typecheck
    npm run check
    npx vitest run
    ```

    The full test count should now be: 49 (Phase 2) + 8 (bus) + 9 (inboxes) + 14 (messages) + 4 (no-direct-db) + 6 (composition) = 90 tests across 14 files. Exact numbers may vary ±2 depending on how executors spell the table-driven cases.
  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run</automated>
  </verify>
  <done>All three exit 0. Phase 3 is complete and ready for Phase 4.</done>
</task>

## Verification

End-to-end:

```bash
# 1. Files exist
test -f src/core/index.ts
test -f src/core/types.ts
test -f tests/core/no-direct-db.test.ts
test -f tests/core/composition.test.ts

# 2. D-03 programmatic enforcement passes
npx vitest run tests/core/no-direct-db.test.ts

# 3. End-to-end composition works
npx vitest run tests/core/composition.test.ts

# 4. Full suite green
npm run typecheck && npm run check && npx vitest run
```

## Success Criteria

- `src/core/index.ts` exports `createCore`, `CoreApi`, `CoreDeps`, `CoreConfig`, plus type re-exports from bus/inboxes/messages.
- `src/core/types.ts` is a type-only barrel.
- `tests/core/no-direct-db.test.ts` enforces D-03 at the source level (grep) with 4 passing cases.
- `tests/core/composition.test.ts` proves all 5 Phase 3 success criteria from ROADMAP.md via the public `createCore` api.
- `npm run typecheck`, `npm run check`, and `npx vitest run` all exit 0.

<output>
After completion, write `.planning/phases/03-core-domain-logic/03-04-SUMMARY.md` per the summary template. Frontmatter: `requirements: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05]` and `depends_on: [03-01, 03-02, 03-03]`. The SUMMARY should include a Phase-3-wide success-criteria table mapping each of ROADMAP Phase 3's five numbered success criteria to the test that proves it.
</output>
