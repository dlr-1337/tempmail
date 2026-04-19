---
phase: 3
plan: 3
status: ready
type: execute
wave: 2
depends_on: [03-01]
requirements: [CORE-03, CORE-04]
files_modified:
  - src/core/messages.ts
  - tests/core/messages.test.ts
autonomous: true
tags: [core, messages, ingest, list, event-bus, enumeration-safe]
must_haves:
  truths:
    - "ingestMessage writes the message row + attachment rows atomically (single transaction). A mid-insert throw leaves zero new DB rows."
    - "ingestMessage emits the 'message' event on the bus AFTER the DB transaction commits — never before."
    - "A listener throwing does not roll back the DB and does not propagate to the caller of ingestMessage."
    - "ingestMessage looks up the inbox by envelopeTo local-part + domain; unknown recipient returns { ok: false, reason: 'unknown_recipient' } (no DB write, no event)."
    - "ingestMessage bumps inboxes.last_activity_at via updateLastActivity on successful ingest."
    - "ingestMessage rejects obviously malformed attachment descriptors (missing sha256, empty filename) with { ok: false, reason: 'invalid_attachment' }."
    - "listMessages returns messages sorted by received_at ASC (oldest first) — chronological per D-15."
    - "listMessages returns { ok: false, reason: 'not_found' } for an unknown inboxId."
    - "listMessages returns { ok: false, reason: 'forbidden' } when the view-token does not match — NEVER 'not_found' (anti-enumeration per D-15)."
    - "listMessages does NOT fetch attachment bytes; only metadata (id, filename, contentType, size)."
    - "listMessages uses constant-time compare via the shared verifyViewToken helper from src/core/inboxes.ts."
  artifacts:
    - path: "src/core/messages.ts"
      provides: "createMessages(deps) factory returning { ingestMessage, listMessages }"
      exports: ["createMessages", "MessagesApi", "IngestInput", "IngestResult", "ListMessagesInput", "ListMessagesResult", "MessageView", "AttachmentView", "MessagesDeps"]
    - path: "tests/core/messages.test.ts"
      provides: "Vitest coverage (happy-path ingest, atomic rollback, bus emit AFTER commit, unknown recipient, listMessages forbidden vs not_found, chronological ordering, no bytes leak)"
  key_links:
    - from: "src/core/messages.ts"
      to: "src/core/bus.ts"
      via: "deps.bus.emit('message', {inboxId, messageId, receivedAt})"
      pattern: "deps\\.bus\\.emit"
    - from: "src/core/messages.ts"
      to: "src/core/inboxes.ts"
      via: "verifyViewToken(row, token) reuse"
      pattern: "verifyViewToken"
    - from: "src/core/messages.ts"
      to: "src/db/repos/index.ts"
      via: "deps.repos.inboxes.findInboxByLocalPart / messages.insertMessageWithAttachments / messages.listMessagesByInbox / attachments.listAttachmentsByMessage / inboxes.updateLastActivity"
      pattern: "deps\\.repos\\."
---

<objective>
Deliver `src/core/messages.ts` — the protocol-agnostic ingest + list functions — and its Vitest coverage. Provides `ingestMessage` (Phase 4 SMTP target) and `listMessages` (Phase 5 HTTP target).

Purpose: The domain heart of the service. CORE-03 (atomic ingest + in-process event) and CORE-04 (chronological listing gated by view-token) land here.

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
<!-- Existing repos, bus, and helpers this plan consumes. Do NOT modify. -->

From src/core/bus.ts (plan 03-01):
```typescript
export interface MessageEvent {
  inboxId: string;
  messageId: string;
  receivedAt: number;
}
export interface BusEvents { message: MessageEvent }
export interface Bus {
  emit<E extends keyof BusEvents>(event: E, payload: BusEvents[E]): void;
  on<E extends keyof BusEvents>(event: E, listener: (p: BusEvents[E]) => void): () => void;
  once<E extends keyof BusEvents>(event: E, listener: (p: BusEvents[E]) => void): () => void;
}
```

From src/core/inboxes.ts (plan 03-02):
```typescript
export function verifyViewToken(row: InboxRow, viewToken: string): boolean;
```

From src/db/repos/message-repo.ts:
```typescript
export interface NewMessage {
  inbox_id: string;
  sender: string | null; subject: string | null;
  text_body: string | null; html_body_sanitized: string | null;
  size_bytes: number;
  envelope_from: string | null; envelope_to: string | null;
  headers_json: string | null;
  received_at?: number; id?: string;
}
export interface NewAttachment {
  filename: string | null; content_type: string | null;
  size_bytes: number; sha256: string; storage_path: string;
  id?: string;
}
export interface MessageRepo {
  insertMessageWithAttachments(m: NewMessage, as: readonly NewAttachment[]): { messageId: string; attachmentIds: readonly string[] };
  listMessagesByInbox(inboxId: string, opts: { limit: number; offset: number }): readonly MessageRow[];
  // ... others
}
```

Note: `listMessagesByInbox` orders `received_at DESC`. Plan 03-03's `listMessages` reverses this to ASC (chronological, D-15) in-memory — the inbox has at most a few hundred messages (D-16), so the reversal is O(n) on a small n.

From src/db/repos/inbox-repo.ts:
```typescript
findInboxByLocalPart(localPart: string, domain: string): InboxRow | undefined;
updateLastActivity(id: string, newExpiresAt: number): InboxRow | undefined;
findInboxById(id: string): InboxRow | undefined;
```

From src/db/types.ts:
```typescript
export interface MessageRow {
  id: string; inbox_id: string;
  sender: string | null; subject: string | null;
  text_body: string | null; html_body_sanitized: string | null;
  received_at: number; size_bytes: number;
  envelope_from: string | null; envelope_to: string | null;
  headers_json: string | null;
}
export interface AttachmentRow {
  id: string; message_id: string;
  filename: string | null; content_type: string | null;
  size_bytes: number; sha256: string; storage_path: string;
}
```
</interfaces>

Conventions (locked by Phase 2):
- ESM + NodeNext (`.js` in relative imports even from `.ts` source).
- Biome: no `!`, no `any`, alphabetized imports, numeric underscore separators, single quotes.
- Vitest `globals: false` — explicit imports from `'vitest'`.
- No `better-sqlite3`, no `node:fs`, no `db.prepare/exec` in `src/core/**`.
</context>

## Goal

Provide `ingestMessage` (write + emit) and `listMessages` (chronological, view-token gated, attachment-metadata-only) as pure functions over repos + bus. Guarantee: bus emit happens strictly AFTER DB commit; wrong view-token returns `forbidden`, not `not_found`.

## Must-have checklist

- [x] **CORE-03**: `ingestMessage` writes transactionally AND emits an in-process event after commit.
- [x] **CORE-04**: `listMessages` returns chronological messages for a given inbox + view-token.
- [x] **D-11**: Emit happens after commit, never inside the transaction.
- [x] **D-12**: `ingestMessage` signature + 'unknown_recipient' branch + last_activity_at bump.
- [x] **D-13**: `htmlBody` stored verbatim into `html_body_sanitized` — no DOMPurify here (Phase 4 sanitizes).
- [x] **D-14**: Reject malformed attachments (missing sha256 or empty filename) defensively.
- [x] **D-15**: Wrong token → `forbidden`; unknown id → `not_found`; constant-time compare via `verifyViewToken`.
- [x] **D-16**: No paging; return all messages for the inbox.

## Tasks

<task type="auto" tdd="true">
  <name>Task 1: Implement ingestMessage + listMessages</name>
  <files>src/core/messages.ts</files>
  <behavior>
    - `createMessages(deps)` returns `MessagesApi` with `ingestMessage` and `listMessages`. Deps:
      ```typescript
      export interface MessagesDeps {
        repos: Repos;
        bus: Bus;
        config: { domain: string; idleTtlMs: number };
        now?: () => number;
      }
      ```
      `idleTtlMs` is needed to compute the new `expires_at` when `updateLastActivity` bumps the inbox (sliding TTL).

    - `ingestMessage(input: IngestInput): IngestResult`
      ```typescript
      export interface IngestAttachmentInput {
        filename: string | null;       // null is allowed (unnamed inline parts)
        contentType: string | null;
        size: number;
        sha256: string;                // REQUIRED: non-empty, 64-char lowercase hex
        path: string;                  // already-written storage_path from attachmentStore
      }
      export interface IngestInput {
        envelopeTo: string;            // e.g. "abc123@example.test"
        envelopeFrom: string | null;
        sender: string | null;
        subject: string | null;
        textBody: string | null;
        htmlBody: string | null;       // already sanitized by SMTP adapter (D-13)
        headers: Record<string, string | string[]> | null;
        attachments: readonly IngestAttachmentInput[];
        sizeBytes: number;             // total message size (SMTP DATA size)
      }
      export type IngestResult =
        | { ok: true; messageId: string }
        | { ok: false; reason: 'unknown_recipient' | 'invalid_attachment' | 'invalid_envelope' };
      ```
      Steps:
      1. Parse `envelopeTo` into `{ localPart, domain }`. Exactly one `@`; both parts non-empty. Otherwise `{ ok: false, reason: 'invalid_envelope' }`.
      2. `inbox = deps.repos.inboxes.findInboxByLocalPart(localPart, domain)`. If undefined → `{ ok: false, reason: 'unknown_recipient' }` (the SMTP adapter maps this to 550).
      3. For each attachment: if `sha256.length !== 64` OR `!/^[0-9a-f]{64}$/.test(sha256)` OR `path` is empty, return `{ ok: false, reason: 'invalid_attachment' }`. (Empty filename is allowed — inline attachments often have none.)
      4. Compute `receivedAt = (deps.now ?? nowMs)()`.
      5. Call `deps.repos.messages.insertMessageWithAttachments({ inbox_id: inbox.id, sender, subject, text_body: textBody, html_body_sanitized: htmlBody, size_bytes: sizeBytes, envelope_from: envelopeFrom, envelope_to: envelopeTo, headers_json: headers ? JSON.stringify(headers) : null, received_at: receivedAt }, attachments.map(a => ({ filename: a.filename, content_type: a.contentType, size_bytes: a.size, sha256: a.sha256, storage_path: a.path })))`. The repo call is already transactional (Phase 2).
      6. Call `deps.repos.inboxes.updateLastActivity(inbox.id, receivedAt + deps.config.idleTtlMs)`. Ignore the return — it merely bumps times.
      7. AFTER these DB calls return (therefore AFTER commit — the repo's `withTransaction` is synchronous): `deps.bus.emit('message', { inboxId: inbox.id, messageId: result.messageId, receivedAt })`. The bus wrapper catches listener throws; we don't need a try/catch here.
      8. Return `{ ok: true, messageId: result.messageId }`.

    - `listMessages(input: ListMessagesInput): ListMessagesResult`
      ```typescript
      export interface AttachmentView {
        id: string; filename: string | null; contentType: string | null; size: number;
      }
      export interface MessageView {
        id: string; receivedAt: number;
        sender: string | null; subject: string | null;
        hasTextBody: boolean; hasHtmlBody: boolean;
        sizeBytes: number;
        attachments: readonly AttachmentView[];
      }
      export interface ListMessagesInput { inboxId: string; viewToken: string }
      export type ListMessagesResult =
        | { ok: true; messages: readonly MessageView[] }
        | { ok: false; reason: 'not_found' | 'forbidden' };
      ```
      Steps:
      1. `row = deps.repos.inboxes.findInboxById(input.inboxId)`. If undefined → `{ ok: false, reason: 'not_found' }`.
      2. If `!verifyViewToken(row, input.viewToken)` → `{ ok: false, reason: 'forbidden' }`. Note: `not_found` here would leak existence.
      3. `rows = deps.repos.messages.listMessagesByInbox(input.inboxId, { limit: 100_000, offset: 0 })` — repo returns DESC; we reverse in-memory.
      4. Map each `row` to `MessageView`: fetch its attachments via `deps.repos.attachments.listAttachmentsByMessage(row.id)`; map each to an `AttachmentView` with only `{ id, filename, contentType, size }` — NEVER include `sha256` or `storage_path` (they're internal identifiers that could be used to probe the attachment store). `hasTextBody = row.text_body !== null`; `hasHtmlBody = row.html_body_sanitized !== null`. We don't include the bodies themselves — the single-message endpoint (API-04 in Phase 5) returns those.
      5. Sort the resulting array by `receivedAt` ASC (chronological per D-15).
      6. Return `{ ok: true, messages }`.
  </behavior>
  <action>
    Create `src/core/messages.ts`:

    ```typescript
    import type { Bus } from './bus.js';
    import { verifyViewToken } from './inboxes.js';
    import type { Repos } from '../db/repos/index.js';
    import { nowMs } from '../util/now.js';

    const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

    export interface MessagesConfig {
      domain: string;
      idleTtlMs: number;
    }

    export interface MessagesDeps {
      repos: Repos;
      bus: Bus;
      config: MessagesConfig;
      now?: () => number;
    }

    export interface IngestAttachmentInput {
      filename: string | null;
      contentType: string | null;
      size: number;
      sha256: string;
      path: string;
    }

    export interface IngestInput {
      envelopeTo: string;
      envelopeFrom: string | null;
      sender: string | null;
      subject: string | null;
      textBody: string | null;
      htmlBody: string | null;
      headers: Record<string, string | string[]> | null;
      attachments: readonly IngestAttachmentInput[];
      sizeBytes: number;
    }

    export type IngestResult =
      | { ok: true; messageId: string }
      | { ok: false; reason: 'unknown_recipient' | 'invalid_attachment' | 'invalid_envelope' };

    export interface AttachmentView {
      id: string;
      filename: string | null;
      contentType: string | null;
      size: number;
    }

    export interface MessageView {
      id: string;
      receivedAt: number;
      sender: string | null;
      subject: string | null;
      hasTextBody: boolean;
      hasHtmlBody: boolean;
      sizeBytes: number;
      attachments: readonly AttachmentView[];
    }

    export interface ListMessagesInput {
      inboxId: string;
      viewToken: string;
    }

    export type ListMessagesResult =
      | { ok: true; messages: readonly MessageView[] }
      | { ok: false; reason: 'not_found' | 'forbidden' };

    export interface MessagesApi {
      ingestMessage(input: IngestInput): IngestResult;
      listMessages(input: ListMessagesInput): ListMessagesResult;
    }

    const parseEnvelope = (envelopeTo: string): { localPart: string; domain: string } | null => {
      const at = envelopeTo.indexOf('@');
      if (at <= 0 || at !== envelopeTo.lastIndexOf('@')) return null;
      const localPart = envelopeTo.slice(0, at);
      const domain = envelopeTo.slice(at + 1);
      if (!localPart || !domain) return null;
      return { localPart, domain };
    };

    const isValidAttachment = (a: IngestAttachmentInput): boolean => {
      if (!a.path) return false;
      if (typeof a.sha256 !== 'string') return false;
      return SHA256_HEX_RE.test(a.sha256);
    };

    export function createMessages(deps: MessagesDeps): MessagesApi {
      const now = deps.now ?? nowMs;

      const ingestMessage = (input: IngestInput): IngestResult => {
        const parsed = parseEnvelope(input.envelopeTo);
        if (!parsed) return { ok: false, reason: 'invalid_envelope' };

        const inbox = deps.repos.inboxes.findInboxByLocalPart(parsed.localPart, parsed.domain);
        if (!inbox) return { ok: false, reason: 'unknown_recipient' };

        for (const a of input.attachments) {
          if (!isValidAttachment(a)) return { ok: false, reason: 'invalid_attachment' };
        }

        const receivedAt = now();

        // Transactional write (repo wraps in withTransaction).
        const { messageId } = deps.repos.messages.insertMessageWithAttachments(
          {
            inbox_id: inbox.id,
            sender: input.sender,
            subject: input.subject,
            text_body: input.textBody,
            html_body_sanitized: input.htmlBody,
            size_bytes: input.sizeBytes,
            envelope_from: input.envelopeFrom,
            envelope_to: input.envelopeTo,
            headers_json: input.headers ? JSON.stringify(input.headers) : null,
            received_at: receivedAt,
          },
          input.attachments.map((a) => ({
            filename: a.filename,
            content_type: a.contentType,
            size_bytes: a.size,
            sha256: a.sha256,
            storage_path: a.path,
          })),
        );

        // Sliding-TTL bump. Cap is enforced at SQL layer (MIN(?, hard_expires_at)).
        deps.repos.inboxes.updateLastActivity(inbox.id, receivedAt + deps.config.idleTtlMs);

        // D-11: emit AFTER the DB transaction commits. Repo call above is synchronous;
        // by the time we reach this line, the commit has landed and any subscriber
        // that re-reads via repos will see the message.
        deps.bus.emit('message', { inboxId: inbox.id, messageId, receivedAt });

        return { ok: true, messageId };
      };

      const listMessages = (input: ListMessagesInput): ListMessagesResult => {
        const row = deps.repos.inboxes.findInboxById(input.inboxId);
        if (!row) return { ok: false, reason: 'not_found' };
        if (!verifyViewToken(row, input.viewToken)) return { ok: false, reason: 'forbidden' };

        const descending = deps.repos.messages.listMessagesByInbox(input.inboxId, {
          limit: 100_000,
          offset: 0,
        });

        const messages: MessageView[] = descending.map((m) => {
          const attachments = deps.repos.attachments.listAttachmentsByMessage(m.id).map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.content_type,
            size: a.size_bytes,
          }));
          return {
            id: m.id,
            receivedAt: m.received_at,
            sender: m.sender,
            subject: m.subject,
            hasTextBody: m.text_body !== null,
            hasHtmlBody: m.html_body_sanitized !== null,
            sizeBytes: m.size_bytes,
            attachments,
          };
        });

        // D-15: ASC chronological. Stable sort on a primitive numeric key.
        messages.sort((a, b) => a.receivedAt - b.receivedAt);

        return { ok: true, messages };
      };

      return { ingestMessage, listMessages };
    }
    ```

    Constraints:
    - `verifyViewToken` is imported from `./inboxes.js` (plan 03-02). If plan 03-02 has not merged yet, this plan's typecheck will fail — that's the intended dependency signal. Plans 02 and 03 can be written in parallel, but 03-03 cannot land until the `verifyViewToken` export exists.
    - Do NOT include bodies (text_body, html_body_sanitized) in `MessageView`. The single-message endpoint in Phase 5 is the only exit point for bodies.
    - Do NOT leak `sha256` or `storage_path` in `AttachmentView`. Internal-only.
  </action>
  <verify>
    <automated>npm run typecheck && npm run check</automated>
  </verify>
  <done>File exists; typecheck + biome clean; no `better-sqlite3`, no `node:fs`, no `db.prepare/exec` in `src/core/messages.ts`.</done>
  <commit>feat(core): add ingestMessage and listMessages</commit>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Vitest coverage of ingest + list</name>
  <files>tests/core/messages.test.ts</files>
  <behavior>
    Reuse `tests/support/db-helper.ts::openTestDbWithRepos()` and `createBus()` from `src/core/bus.js`. A sample inbox is created via `repos.inboxes.createInbox({...})` directly (no need to drag in the full createInboxes factory here — that's already covered by plan 03-02). We pre-compute the view_token_hash in the test so we can exercise listMessages happy and sad paths without depending on plan 03-02's source.

    Minimum cases:

    ### ingestMessage

    1. `happy-path ingest with zero attachments writes row and emits event AFTER commit` — use a listener that, when invoked, calls `countMessagesByInbox` on the repo and asserts the count is already 1 (proving the emit came after commit).
    2. `happy-path ingest with one attachment writes both rows atomically` — assert `countMessagesByInbox === 1` and `listAttachmentsByMessage(messageId).length === 1`.
    3. `unknown recipient returns ok:false reason unknown_recipient, no DB write, no event` — listener never fires; `countMessagesByInbox === 0`.
    4. `invalid envelope (no @, multiple @, empty local, empty domain) returns ok:false reason invalid_envelope` — table-driven; for each input, no DB write, no event.
    5. `invalid attachment (missing sha256, bad hex, empty path) returns ok:false reason invalid_attachment, no DB write, no event` — table-driven.
    6. `a throwing listener does not roll back the DB and does not propagate` — pre-attach a listener that throws; assert ingestMessage returns ok:true, countMessagesByInbox === 1, listener was called once. Silence console.error via `vi.spyOn`.
    7. `bumps last_activity_at via updateLastActivity` — spy on `repos.inboxes.updateLastActivity`, assert called once with `(inbox.id, receivedAt + idleTtlMs)`.
    8. `headers object is serialized to JSON` — pass `{ 'X-Test': 'abc' }`, fetch the message row via repo, assert `JSON.parse(row.headers_json)` equals the input.
    9. `htmlBody is stored verbatim into html_body_sanitized (D-13)` — pass `<p>raw</p>` (intentionally unsanitized from the test's perspective), assert the row's `html_body_sanitized === '<p>raw</p>'`. Core trusts input per D-13.

    ### listMessages

    10. `returns chronological order (ASC by receivedAt)` — insert three messages with explicit `received_at` = 300, 100, 200; assert returned messages are ordered 100, 200, 300.
    11. `unknown inbox id returns ok:false reason not_found` — call with a synthetic id.
    12. `wrong view-token returns ok:false reason forbidden (NEVER not_found)` — create an inbox, call listMessages with `'wrong'`; assert `reason === 'forbidden'`.
    13. `returns MessageView with attachment metadata only — no sha256, no storage_path, no bodies` — insert message+attachment with `sha256: 'a'.repeat(64)` and `storage_path: 'aa/aa/attach'`; fetch via listMessages; assert the returned attachment has `{ id, filename, contentType, size }` shape and NO properties named `sha256` or `storage_path` or `storagePath`. Assert `hasTextBody === true` but no `textBody` key exists. JSON.stringify-and-regex is acceptable proof.
    14. `valid view-token returns ok:true even with zero messages` — create inbox, don't ingest, list returns `{ ok: true, messages: [] }`.
  </behavior>
  <action>
    Create `tests/core/messages.test.ts`:

    ```typescript
    import { createHash } from 'node:crypto';
    import { describe, expect, it, vi } from 'vitest';
    import { createBus } from '../../src/core/bus.js';
    import { createMessages, type IngestInput } from '../../src/core/messages.js';
    import { openTestDbWithRepos } from '../support/db-helper.js';

    const seedInbox = (repos: ReturnType<typeof openTestDbWithRepos>['repos']) => {
      const viewToken = 'view-token-22-chars-ab';
      const view_token_hash = createHash('sha256').update(viewToken).digest('hex');
      const row = repos.inboxes.createInbox({
        local_part: 'user1',
        domain: 'example.test',
        view_token_hash,
        expires_at: 9_999_999_999_999,
        hard_expires_at: 9_999_999_999_999,
      });
      return { row, viewToken };
    };

    const baseIngest = (envelopeTo: string, overrides: Partial<IngestInput> = {}): IngestInput => ({
      envelopeTo,
      envelopeFrom: 'sender@other.test',
      sender: 'Sender <sender@other.test>',
      subject: 'hi',
      textBody: 'body',
      htmlBody: null,
      headers: null,
      attachments: [],
      sizeBytes: 100,
      ...overrides,
    });

    describe('createMessages.ingestMessage', () => {
      it('writes message and emits AFTER commit (listener sees row via repo)', () => {
        const { db: _db, repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const { row } = seedInbox(repos);

        let seenCountAtEmit = -1;
        bus.on('message', () => {
          seenCountAtEmit = repos.messages.countMessagesByInbox(row.id);
        });

        const result = messages.ingestMessage(baseIngest('user1@example.test'));
        expect(result.ok).toBe(true);
        expect(seenCountAtEmit).toBe(1); // proves emit happened after commit
      });

      it('writes message + attachment atomically', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const { row } = seedInbox(repos);

        const result = messages.ingestMessage(baseIngest('user1@example.test', {
          attachments: [{ filename: 'a.txt', contentType: 'text/plain', size: 5, sha256: 'a'.repeat(64), path: 'aa/aa/a'.repeat(1) + 'a'.repeat(57) }],
        }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(repos.messages.countMessagesByInbox(row.id)).toBe(1);
        expect(repos.attachments.listAttachmentsByMessage(result.messageId).length).toBe(1);
      });

      it('returns unknown_recipient for an address with no inbox', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        seedInbox(repos);

        const listener = vi.fn();
        bus.on('message', listener);

        const r = messages.ingestMessage(baseIngest('nobody@example.test'));
        expect(r).toEqual({ ok: false, reason: 'unknown_recipient' });
        expect(listener).not.toHaveBeenCalled();
      });

      it.each([
        'no-at',
        'a@b@c.test',
        '@example.test',
        'user@',
      ])('returns invalid_envelope for malformed %s', (envelope) => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        seedInbox(repos);
        const r = messages.ingestMessage(baseIngest(envelope));
        expect(r).toEqual({ ok: false, reason: 'invalid_envelope' });
      });

      it.each([
        { sha256: '', path: 'aa/aa/x' },          // empty sha
        { sha256: 'A'.repeat(64), path: 'aa/aa/x' }, // uppercase hex (invalid per D-28 upstream)
        { sha256: 'a'.repeat(63), path: 'aa/aa/x' }, // wrong length
        { sha256: 'a'.repeat(64), path: '' },       // empty path
      ])('returns invalid_attachment for malformed descriptor %#', (bad) => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        seedInbox(repos);
        const r = messages.ingestMessage(baseIngest('user1@example.test', {
          attachments: [{ filename: 'x', contentType: 'application/octet-stream', size: 1, sha256: bad.sha256, path: bad.path }],
        }));
        expect(r).toEqual({ ok: false, reason: 'invalid_attachment' });
      });

      it('isolates a throwing listener; DB still has the row', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const { row } = seedInbox(repos);

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const thrower = vi.fn(() => { throw new Error('boom'); });
        bus.on('message', thrower);

        const r = messages.ingestMessage(baseIngest('user1@example.test'));
        expect(r.ok).toBe(true);
        expect(thrower).toHaveBeenCalledTimes(1);
        expect(repos.messages.countMessagesByInbox(row.id)).toBe(1);
        errSpy.mockRestore();
      });

      it('bumps last_activity_at via updateLastActivity', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 }, now: () => 1_700_000_000_000 });
        const { row } = seedInbox(repos);

        const spy = vi.spyOn(repos.inboxes, 'updateLastActivity');
        messages.ingestMessage(baseIngest('user1@example.test'));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(row.id, 1_700_000_000_000 + 600_000);
      });

      it('serializes headers to JSON and stores html verbatim', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        seedInbox(repos);

        const r = messages.ingestMessage(baseIngest('user1@example.test', {
          headers: { 'X-Test': 'abc' },
          htmlBody: '<p>raw-not-sanitized-by-core</p>',
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const msg = repos.messages.findMessageById(r.messageId);
        expect(msg).toBeDefined();
        if (!msg) return;
        expect(JSON.parse(msg.headers_json ?? 'null')).toEqual({ 'X-Test': 'abc' });
        expect(msg.html_body_sanitized).toBe('<p>raw-not-sanitized-by-core</p>');
      });
    });

    describe('createMessages.listMessages', () => {
      it('returns messages in ASC order by receivedAt', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        let t = 0;
        const schedule = [300, 100, 200];
        const now = () => {
          const v = schedule[t];
          t += 1;
          if (v === undefined) throw new Error('now() called too many times');
          return v;
        };
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 }, now });
        const { row, viewToken } = seedInbox(repos);

        messages.ingestMessage(baseIngest('user1@example.test', { subject: 'first' }));
        messages.ingestMessage(baseIngest('user1@example.test', { subject: 'second' }));
        messages.ingestMessage(baseIngest('user1@example.test', { subject: 'third' }));

        const r = messages.listMessages({ inboxId: row.id, viewToken });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.messages.map((m) => m.receivedAt)).toEqual([100, 200, 300]);
        expect(r.messages.map((m) => m.subject)).toEqual(['second', 'third', 'first']);
      });

      it('returns not_found for unknown inbox id', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const r = messages.listMessages({ inboxId: 'nope', viewToken: 'anything' });
        expect(r).toEqual({ ok: false, reason: 'not_found' });
      });

      it('returns forbidden (NEVER not_found) for wrong view-token on existing inbox', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const { row } = seedInbox(repos);
        const r = messages.listMessages({ inboxId: row.id, viewToken: 'wrong-token-value!' });
        expect(r).toEqual({ ok: false, reason: 'forbidden' });
      });

      it('MessageView contains only public metadata (no sha256, no storage_path, no bodies)', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const { row, viewToken } = seedInbox(repos);

        messages.ingestMessage(baseIngest('user1@example.test', {
          textBody: 'secret-body',
          htmlBody: '<b>secret</b>',
          attachments: [{ filename: 'x.txt', contentType: 'text/plain', size: 1, sha256: 'a'.repeat(64), path: 'aa/aa/' + 'a'.repeat(64) }],
        }));

        const r = messages.listMessages({ inboxId: row.id, viewToken });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const [m] = r.messages;
        expect(m).toBeDefined();
        if (!m) return;

        const serialized = JSON.stringify(r);
        expect(serialized).not.toContain('secret-body');
        expect(serialized).not.toContain('sha256');
        expect(serialized).not.toContain('storage_path');
        expect(serialized).not.toContain('storagePath');
        expect(m.hasTextBody).toBe(true);
        expect(m.hasHtmlBody).toBe(true);
        const [a] = m.attachments;
        expect(a).toBeDefined();
        if (!a) return;
        expect(Object.keys(a).sort()).toEqual(['contentType', 'filename', 'id', 'size']);
      });

      it('returns ok with empty array for a valid inbox with zero messages', () => {
        const { repos } = openTestDbWithRepos();
        const bus = createBus();
        const messages = createMessages({ repos, bus, config: { domain: 'example.test', idleTtlMs: 600_000 } });
        const { row, viewToken } = seedInbox(repos);
        const r = messages.listMessages({ inboxId: row.id, viewToken });
        expect(r).toEqual({ ok: true, messages: [] });
      });
    });
    ```

    Biome will re-order imports; accept the result. If `noUncheckedIndexedAccess` flags `schedule[t]`, the guard in the `now` function handles it — the `!` ban is respected.
  </action>
  <verify>
    <automated>npx vitest run tests/core/messages.test.ts</automated>
  </verify>
  <done>All cases pass. `npm run check` + `npm run typecheck` exit 0.</done>
  <commit>test(core): cover ingestMessage atomicity, emit-after-commit, and listMessages enumeration safety</commit>
</task>

<task type="auto">
  <name>Task 3: Plan-level gate</name>
  <files>(none created)</files>
  <action>
    ```bash
    npm run typecheck
    npm run check
    npx vitest run
    ```
  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run</automated>
  </verify>
  <done>All three exit 0. All prior-plan tests still pass.</done>
</task>

## Verification

End-to-end:

```bash
# 1. Files exist
test -f src/core/messages.ts
test -f tests/core/messages.test.ts

# 2. No forbidden imports / raw DB access in core
! grep -nE "from '.*better-sqlite3" src/core/ -r
! grep -nE "from 'node:fs" src/core/ -r
! grep -nE "db\.(prepare|exec)\(" src/core/ -r

# 3. No body/attachment-sensitive fields leak through listMessages
! grep -nE "'sha256'|'storage_path'|'storagePath'" src/core/messages.ts
# (The module must not mention these keys in its output shape. References to input `.sha256` etc. are allowed.)
# This check can be eyeballed; the JSON.stringify test case in step 13 is the real proof.

# 4. Gates
npm run typecheck && npm run check && npx vitest run
```

## Success Criteria

- `src/core/messages.ts` exports `createMessages`, `MessagesApi`, `IngestInput`, `IngestResult`, `IngestAttachmentInput`, `ListMessagesInput`, `ListMessagesResult`, `MessageView`, `AttachmentView`, `MessagesDeps`, `MessagesConfig`.
- `tests/core/messages.test.ts` has ≥ 12 passing cases covering CORE-03 (atomic + emit-after-commit + throw isolation), CORE-04 (chronological + not_found vs forbidden + body-less view), and D-12/D-13/D-14 inputs.
- No `better-sqlite3`, `node:fs`, or `db.prepare/exec` in `src/core/messages.ts`.
- `npm run typecheck`, `npm run check`, `npx vitest run` all exit 0.

<output>
After completion, write `.planning/phases/03-core-domain-logic/03-03-SUMMARY.md` per the summary template. Frontmatter `requirements: [CORE-03, CORE-04]` and `depends_on: [03-01, 03-02]` (depends on plan 02 at the code level because it imports `verifyViewToken`).
</output>
