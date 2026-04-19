# Phase 3: Core Domain Logic - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto (derived from concrete requirements + Phase 2 outputs)

<domain>
## Phase Boundary

Protocol-agnostic business logic for the tempmail service. Sits between the Phase 2 data layer and the upcoming protocol adapters (Phase 4 SMTP, Phase 5 HTTP/SSE). No network code, no I/O beyond repository calls, no framework coupling.

Scope (from ROADMAP.md + REQUIREMENTS.md CORE-01..05):
- `createInbox()` — mint random local-part with ≥64 bits entropy, store in DB, return public address + view-token
- view-token separate from public address (distinct values, view-token never appears in the address string)
- `ingestMessage()` — persist message + attachments transactionally, emit in-process event
- `listMessages()` — chronological messages for a given inbox id + view-token
- `expireInbox()` — cascade delete (messages + attachments files + abuse counters) via FK and attachment-store calls
- In-process `EventEmitter` singleton — the bus the SSE handler will subscribe to in Phase 5

Out of scope for this phase: any HTTP surface (Phase 5), any SMTP code (Phase 4), the sweeper loop (Phase 6). This phase exports pure functions + the event bus; phases 4/5/6 wire them into adapters.

</domain>

<decisions>
## Implementation Decisions

### Layering
- **D-01:** New module root: `src/core/`. One file per concept (`inboxes.ts`, `messages.ts`, `bus.ts`).
- **D-02:** Functions are parameterized by dependencies (repos, attachmentStore, bus, now, id) — no globals, no singletons inside the module. A single composition root in `src/core/index.ts` exports `createCore(deps)` returning bound functions.
- **D-03:** No direct `better-sqlite3` usage in `src/core/*` — only Phase 2 repos. Verifiable by grep (identical pattern to Phase 2's STORE-04 invariant test).

### Address generation (CORE-01, CORE-02)
- **D-04:** Local-part = 16-char lowercase base32 (Crockford) OR nanoid `~_-abc...` (22 chars). ≥64 bits for sure. Planner picks a final alphabet; Phase 2 already shipped `newId()` returning nanoid 22-char (132 bits) in `src/util/id.ts` — reuse unless the planner has a strong reason not to.
- **D-05:** Domain is read from configuration (`config.domain`), not hardcoded. Config object injected via `createCore(deps)`.
- **D-06:** View-token is an independent ≥128-bit random string (nanoid 22). Stored **hashed** in DB (`inboxes.view_token_hash`, SHA-256), compared constant-time.
- **D-07:** The caller of `createInbox()` receives the plain-text view-token exactly once (for the HTTP cookie); server keeps only the hash.

### Event bus (CORE-03)
- **D-08:** `src/core/bus.ts` exports `createBus()` returning a typed `EventEmitter`-like interface:
  - `emit(event: "message", payload: { inboxId: string; messageId: string; receivedAt: number })`
  - `on(event, listener) → unsubscribe`
  - `once(event, listener) → unsubscribe`
- **D-09:** Single shared bus per process — instantiated once at composition root (`src/core/index.ts`). Tests instantiate their own bus.
- **D-10:** No persistence, no retry, no dead-letter — ephemeral pub/sub only. SSE handlers must use replay-on-subscribe (Phase 5 concern) for correctness.
- **D-11:** `ingestMessage()` emits the event **inside** the same transaction scope — actually no: emit **after** the DB transaction commits, to guarantee subscribers observing an event can read the message back. Listener failures must not roll back the ingest.

### ingestMessage signature (CORE-03)
- **D-12:** `ingestMessage({ envelopeTo, envelopeFrom, sender, subject, textBody, htmlBody, headers, attachments: [{ filename, contentType, size, sha256, path }] }) → { accepted: boolean, messageId?: string, reason?: string }`
  - Called by the SMTP adapter in Phase 4 after it has already streamed attachments to disk via the Phase 2 attachment store
  - Looks up inbox by `envelopeTo` → if missing, returns `{ accepted: false, reason: "unknown_recipient" }` (the SMTP adapter translates to 550 in its layer)
  - If accepted: runs the transaction (insert message row + attachment rows via `messageRepo.insertMessageWithAttachments`), bumps `last_activity_at`, emits event
- **D-13:** HTML sanitization happens in the SMTP adapter (Phase 4) BEFORE calling `ingestMessage` — the core function stores `htmlBody` verbatim into `html_body_sanitized`. This keeps DOMPurify out of the domain layer.
- **D-14:** Size limit is enforced in Phase 4's SMTP adapter (`SIZE=10485760` advertised). Core trusts inputs but defensively rejects obviously malformed attachment descriptors (missing sha256, empty filename).

### listMessages (CORE-04)
- **D-15:** `listMessages({ inboxId, viewToken }) → { messages: Message[] } | { error: "not_found" | "forbidden" }`
  - Compares `viewToken` against `view_token_hash` constant-time
  - Wrong token → `"forbidden"` (never `"not_found"`, to prevent enumeration)
  - Missing inbox → `"not_found"` (only leaks cardinality of existing vs non-existing ids, which is already a weakness inherent to having IDs)
  - Returns all non-expired messages for the inbox, sorted by `received_at` ASC
  - Does NOT fetch attachment bytes — only metadata (filename, size, contentType, id)
- **D-16:** Paging is deferred. Inboxes live minutes-hours and hold at most a few hundred messages. Return everything.

### expireInbox (CORE-05)
- **D-17:** `expireInbox({ inboxId }) → { deletedMessages: number, unlinkedAttachments: number }`
  - Collects attachment sha256 list first (via `messageRepo.listAttachmentShasForInbox`)
  - DB transaction deletes the inbox → FK CASCADE deletes messages + attachments rows + abuse_counters linked by inbox
  - **After** commit, iterates the sha256 list and calls `attachmentStore.maybeUnlink(sha256)` — only unlinks if no other attachment row references that sha256 (orphan check)
  - Returns counts
- **D-18:** This function is called by the Phase 6 sweeper. Core exports it; does not schedule it.

### Error model
- **D-19:** Core returns discriminated union results (`{ ok: true, ... } | { ok: false, reason: string }`) instead of throwing for expected business errors.
- **D-20:** Programmer errors (invalid argument types, missing deps) throw — never returned as `ok: false`.

### Testing
- **D-21:** Vitest with in-memory DB + real bus + fake `now`/`id` injection for determinism. Reuse `tests/support/db-helper.ts` + `tmpdir.ts` from Phase 2.
- **D-22:** Must cover: happy-path createInbox, view-token hash separation, ingestMessage with + without attachments, ingestMessage to unknown recipient, listMessages with wrong token → forbidden, listMessages non-existent inbox → not_found, expireInbox unlink-orphans behavior, bus event emitted exactly once per ingest, event emitted AFTER commit (not before).

### Claude's Discretion
- Specific TypeScript type shapes as long as intent per decision
- Whether to fold createInbox/listInbox-metadata into one file or split
- Exact form of the `Deps` type for `createCore(deps)`

</decisions>

<specifics>
## Specific Ideas

- The bus-emit-AFTER-commit decision (D-11) comes from Phase 2's FK CASCADE + Phase 5's replay-on-subscribe plan. A subscriber that hears about messageId=X must be able to query and see it. Emitting inside the txn breaks that guarantee.
- D-06's hashed view-token mirrors password-reset token storage. A database leak still forces an online oracle attack rather than just reading cookies.
- `maybeUnlink` (D-17) is the SQL equivalent of a refcount — check if any `attachments.sha256 = $sha` row exists after the delete cascaded; if zero, safe to unlink the file.

</specifics>

<canonical_refs>
## Canonical References

### Roadmap and requirements
- `.planning/PROJECT.md` — core value, constraints, privacy-first posture
- `.planning/REQUIREMENTS.md` §Core (CORE-01..05)
- `.planning/ROADMAP.md` §Phase 3 — goal + success criteria

### Research
- `.planning/research/ARCHITECTURE.md` §Event bus — locks in-process EventEmitter
- `.planning/research/PITFALLS.md` §Race (replay-on-subscribe context for D-11)
- `.planning/research/PITFALLS.md` §Enumeration (basis for constant-time compare in D-06/D-15)

### Phase 2 outputs (consume, do not modify)
- `src/db/repos/index.ts` — `createRepos(db)` aggregate
- `src/db/repos/inbox-repo.ts` — `createInbox`, `findInboxByLocalPartAndDomain`, `updateActivity`, etc.
- `src/db/repos/message-repo.ts` — `insertMessageWithAttachments` (transactional), `listForInbox`, `listAttachmentShasForInbox`
- `src/db/repos/attachment-repo.ts`, `src/db/repos/abuse-repo.ts`
- `src/attachments/index.ts` — `createAttachmentStore` with `writeAttachment`, `readAttachment`, `maybeUnlink`
- `src/util/now.ts` — `nowMs()`
- `src/util/id.ts` — `newId()` (132-bit nanoid)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createRepos(db)` — single dependency to wire the data layer
- `createAttachmentStore({ root })` — attachment blob I/O with dedup
- `nowMs`, `newId` — inject for determinism in tests; default use in prod
- Biome + tsconfig + vitest already configured from Phase 1
- Test helpers `openTempDb` and `mkTempDir` in `tests/support/*`

### Patterns to Follow
- Factory-returning-bound-functions pattern used by repos (`createInboxRepo(db) → InboxRepo`). Core should follow the same shape.
- Prepared-statement caching at the repo level means core doesn't need to worry about query perf.
- Consider mirroring Phase 2's `prepared-statement-invariant.test.ts` — write a `core-no-direct-db.test.ts` that greps `src/core/**/*.ts` for `db.prepare|db.exec|better-sqlite3` imports and asserts zero hits.

### Known Gotchas
- `constant-time compare` on view-token: use `crypto.timingSafeEqual(a, b)`; both buffers must be same length (sha256 = 32 bytes always, so safe).
- `node:crypto` is required for `createHash('sha256')` and `timingSafeEqual`. Lazy-import if bundle size matters; for now direct import is fine.
- EventEmitter max listeners warning — set to something generous (100) in core bus factory to avoid dev-time warnings when many SSE subscribers exist.

</code_context>

<deferred>
## Deferred Ideas

- Message paging + cursor (when inboxes start holding thousands of messages — not v1)
- Persistent event log for audit (v2+ — contradicts current privacy stance)
- Core-level rate limiting (decided to live in Phase 5 adapter instead, closer to the HTTP surface)

</deferred>
