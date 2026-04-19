---
phase: 03-core-domain-logic
status: complete
plans_completed: [03-01, 03-02, 03-03, 03-04]
plans_total: 4
started: 2026-04-18
completed: 2026-04-18
duration: ~90min

# Requirements closed
requirements-completed: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05]

# Phase output for downstream consumers
provides:
  - "src/core/index.ts — createCore(deps) composition root"
  - "src/core/types.ts — type-only barrel"
  - "src/core/bus.ts — createBus() typed in-process pub/sub"
  - "src/core/inboxes.ts — createInboxes(deps) (createInbox, expireInbox, verifyViewToken)"
  - "src/core/messages.ts — createMessages(deps) (ingestMessage, listMessages)"
consumed_by: [04-smtp-adapter, 05-http-sse, 06-retention-sweeper]

# Phase-level invariants now enforced
invariants:
  - "D-01: one module root src/core/ — 5 files, all domain logic"
  - "D-02: parameterized by deps — no globals, no singletons inside modules"
  - "D-03: no direct better-sqlite3, node:fs, db.prepare/db.exec under src/core/ — enforced by tests/core/no-direct-db.test.ts (source grep) AND tests/db/prepared-statement-invariant.test.ts (runtime spy)"
  - "D-09: one bus per createCore — asserted by tests/core/composition.test.ts case 2"
  - "D-11: ingestMessage emits 'message' strictly AFTER the DB commit — proved by tests/core/messages.test.ts (listener re-read sees row) and tests/core/composition.test.ts (same-tick emit)"
  - "D-15: wrong view-token → forbidden (never not_found) — enumeration-safe listing enforced at the core layer"
  - "D-17: orphan-safe attachment unlink — expireInbox collects shas pre-delete, unlinks only shas with no surviving references"

# Test counts
tests:
  phase-3-new: 51
  cumulative: 100
  files-new: 5
  files-cumulative: 15
---

# Phase 3: Core Domain Logic Summary

**Protocol-agnostic business layer for the tempmail service — `src/core/` exposes four operations (`createInbox`, `ingestMessage`, `listMessages`, `expireInbox`) and a typed in-process pub/sub (`Bus`) through a single composition root `createCore(deps)`. Phase 4 (SMTP), Phase 5 (HTTP/SSE), and Phase 6 (sweeper) import from `src/core/index.js` only — never from the per-module files — and all four requirements (CORE-01..05) are closed with 51 new tests (100 cumulative across 15 files).**

## Completion Summary

| Plan | Name | Commits | Tests added | Duration |
|------|------|---------|-------------|----------|
| 03-01 | Typed event bus | feat `a037ead`, test `9c2c891`, docs `ee85130` | 8 | ~15 min |
| 03-02 | Inboxes (createInbox, expireInbox, verifyViewToken) | feat `d647b71`, test `8480762`, docs `3793749` | 9 | ~20 min |
| 03-03 | Messages (ingestMessage, listMessages) | feat `8679453`, test `bcb0b9b`, docs `d23e59c` | 24 | ~20 min |
| 03-04 | Composition root + D-03 invariant + end-to-end | feat `ebfbe62`, test `936d2eb`, test `ff8f6ff` | 10 | ~15 min |
| **Phase total** | | **9 task commits + 3 docs commits** | **51 new / 100 cumulative** | **~70 min execution** |

## API Surface Exposed to Phase 4/5/6

External adapters import ONLY from `src/core/index.js`. Per-module imports are possible but discouraged — the composition root is the stable surface.

### Factory

```typescript
import { createCore, type CoreDeps, type CoreApi, type CoreConfig } from 'src/core/index.js';

const core = createCore({
  db,               // src/db/client.Db — used by expireInbox's withTransaction
  repos,            // src/db/repos createRepos(db) — used by every operation
  attachmentStore,  // src/attachments createAttachmentStore(rootDir) — used by expireInbox for orphan unlink
  config: {
    domain: 'example.test',   // single-domain for v1
    idleTtlMs: 10 * 60_000,   // RETN-01 default in prod
    hardTtlMs: 60 * 60_000,   // RETN-01 default in prod
  },
  // optional determinism overrides:
  now: () => fakeClock,
  id:  () => deterministicId,
});
```

### CoreApi

```typescript
interface CoreApi {
  readonly bus: Bus;                                                           // SSE subscribes here
  createInbox(): CreateInboxResult;                                            // sync — one new inbox + plaintext viewToken (returned once)
  expireInbox(input: { inboxId: string }): Promise<ExpireInboxResult>;         // async — cascades + orphan-unlinks
  ingestMessage(input: IngestInput): IngestResult;                             // sync — writes txn, emits AFTER commit
  listMessages(input: ListMessagesInput): ListMessagesResult;                  // sync — enumeration-safe
}
```

### Result shapes (discriminated unions, D-19)

- `CreateInboxResult = { ok: true, inboxId, address, viewToken, expiresAt, hardExpiresAt }` — `viewToken` is plaintext and returned exactly once. The DB stores only `sha256(viewToken)`.
- `ExpireInboxResult = { ok: true, deletedMessages, unlinkedAttachments } | { ok: false, reason: 'not_found' }`
- `IngestResult = { ok: true, messageId } | { ok: false, reason: 'unknown_recipient' | 'invalid_attachment' | 'invalid_envelope' }`
- `ListMessagesResult = { ok: true, messages: readonly MessageView[] } | { ok: false, reason: 'not_found' | 'forbidden' }`
- `MessageView = { id, receivedAt, sender, subject, hasTextBody, hasHtmlBody, sizeBytes, attachments: readonly AttachmentView[] }`
- `AttachmentView = { id, filename, contentType, size }` — **metadata only**; `sha256` and `storage_path` are internal and never surface in a list response.

### Bus

```typescript
interface Bus {
  emit<E extends keyof BusEvents>(event: E, payload: BusEvents[E]): void;
  on<E extends keyof BusEvents>(event: E, listener: BusListener<E>): () => void;   // returns unsubscribe
  once<E extends keyof BusEvents>(event: E, listener: BusListener<E>): () => void; // returns unsubscribe
}
interface BusEvents { message: MessageEvent }
interface MessageEvent { inboxId: string; messageId: string; receivedAt: number }
```

Semantics: synchronous delivery, subscription-order, listener-failure isolation (a throwing listener is caught and logged via `console.error`, the emit call never throws), no replay (Phase 5's SSE handler adds replay-on-subscribe via `repos` per D-10). Max listeners is 100 (generous for SSE fan-out).

## Architectural Commitments (Locked)

1. **One composition root** (`src/core/index.ts`) — every adapter imports `createCore(deps)`; none reach into `bus.ts`/`inboxes.ts`/`messages.ts` directly.
2. **No direct DB/filesystem access in `src/core/`** (D-03) — enforced programmatically by two tests:
   - `tests/core/no-direct-db.test.ts` (source grep, Phase 3): walks every `.ts` under `src/core/` and fails if any file imports `better-sqlite3`, `node:fs(/promises)?`, or calls `db.prepare(/db.exec(`. Specifier-anchored so it catches `from`, bare side-effect, dynamic `import()`, and `require()` forms.
   - `tests/db/prepared-statement-invariant.test.ts` (runtime spy, Phase 2): catches `db.prepare/db.exec` calls at test time on the shared DB handle.
3. **Hashed view-token with timing-safe compare** (D-06, D-07) — the DB only ever stores `sha256(viewToken)`; the plaintext is returned from `createInbox()` once and then discarded server-side. Wrong tokens → `forbidden`, never `not_found`.
4. **Emit-after-commit** (D-11) — `ingestMessage` finishes the synchronous `withTransaction` before calling `bus.emit('message', ...)`, so any subscriber that re-queries via the repos sees the row.
5. **Orphan-safe expire** (D-17) — `expireInbox` collects candidate attachment SHAs **before** the cascade delete, then (post-commit) calls `attachmentStore.unlinkBySha256(sha)` only for SHAs no other inbox still references via `repos.attachments.listAllSha256s()`.
6. **Bodies excluded from list responses** — `MessageView` carries `hasTextBody`/`hasHtmlBody` booleans, never the body strings. Phase 5's single-message endpoint (API-04) is responsible for returning bodies.
7. **Defensive attachment validation** (D-14) — sha256 must be `/^[0-9a-f]{64}$/`; path must be non-empty. Violations return `invalid_attachment` before DB contact or bus emit.
8. **Envelope parser is stricter than RFC 5321** — no quoted local-parts, no source routes. Violations return `invalid_envelope`. The SMTP adapter (Phase 4) is expected to filter upstream; core rejects defensively.

## Requirements Closed

All five Phase 3 requirements complete; see the traceability column in `.planning/REQUIREMENTS.md`:

| Requirement | Description | Closed by |
|-------------|-------------|-----------|
| CORE-01 | createInbox generates random local-part with ≥64 bits of entropy | Plan 03-02 (nanoid 22-char = 132 bits); surfaced through createCore in 03-04 |
| CORE-02 | Each inbox has a separate view-token distinct from its public address | Plan 03-02 (independent 22-char nanoid, SHA-256 hashed in DB); surfaced through createCore in 03-04 |
| CORE-03 | ingestMessage writes message + attachments transactionally and emits an in-process event | Plan 03-03 (withTransaction + emit-after-commit); surfaced through createCore in 03-04 |
| CORE-04 | listMessages returns chronological messages for a given inbox + view-token | Plan 03-03 (ASC chronological, timing-safe compare via verifyViewToken); surfaced through createCore in 03-04 |
| CORE-05 | expireInbox cascades deletes to messages + attachment files + abuse counters | Plan 03-02 (FK CASCADE + orphan-safe unlink); surfaced through createCore in 03-04 |

## Test Inventory

Phase 3 new tests — 51 cases across 5 files (LOC counts are tests only):

- `tests/core/bus.test.ts` — 8 cases, 94 LOC (sync delivery, subscription order, unsubscribe, once, throw-isolation, no-replay, many-listeners, event isolation)
- `tests/core/inboxes.test.ts` — 9 cases, 304 LOC (address entropy, token hashing, config.domain usage, determinism, verifyViewToken accept/reject, not_found, orphan unlink, multi-inbox sha sharing, zero-message inbox)
- `tests/core/messages.test.ts` — 24 cases, 397 LOC (emit-after-commit, atomic message+attachment insert, unknown_recipient, invalid_envelope ×4 table-driven, invalid_attachment ×6 table-driven, throwing-listener isolation, last_activity_at bump, headers serialization, verbatim html, exact emit payload, ASC ordering, not_found, forbidden, metadata-only shape, empty-inbox happy path, correct-token happy path)
- `tests/core/no-direct-db.test.ts` — 4 cases, 79 LOC (sanity file-exists + three forbidden-import/call greps)
- `tests/core/composition.test.ts` — 6 cases, 199 LOC (entropy + view-token distinct, per-call bus identity, ingest-emits-and-persists, ASC ordering, wrong-token forbidden + unknown-id not_found, full-walk expire with orphan unlink)

Cumulative project-wide: **100 tests across 15 test files**. All green; typecheck exit 0; Biome clean across 41 files.

## Notable Deviations (Cross-Plan)

- **Plan 03-04 broadened the D-03 invariant regex** (Rule 2 — critical functionality): the plan's originally-specified regex `from\\s+['\"]better-sqlite3['\"]` / `require\\s*\\(...\\)` would miss a bare side-effect import like `import 'better-sqlite3';` — which is exactly the offender the plan's own `<done>` step used for manual verification. The regex was replaced with a specifier-anchored match covering all four import forms. Zero false positives under `src/core/` because the specifiers are unambiguous. Documented in 03-04 SUMMARY.
- Otherwise, all four plans executed verbatim from their `<action>` blocks. Biome-driven import alphabetization was accepted as pre-authorized noise (plans 03-01 and 03-03 noted).

## Phase 4/5 Parallel-Execution Readiness

Phase 3 unblocks two concurrent workstreams:

- **Phase 4 (SMTP adapter)** — needs `core.ingestMessage(input)` per accepted `DATA` (returns `IngestResult` with distinguishable reason strings for 550 translation) and `attachmentStore.writeAttachment(stream)` upstream of ingest for pre-hashed blobs.
- **Phase 5 (HTTP + SSE)** — needs `core.createInbox()`, `core.listMessages({ inboxId, viewToken })`, `core.expireInbox` (exposed but owned by Phase 6), and `core.bus.on('message', ...)` for SSE with replay-on-subscribe (D-10) semantics in the handler.

Both phases depend only on Phase 3 outputs (and the Phase 1 env/config wiring that's still TBD per STATE.md's Open Questions table). Neither depends on the other; Phase 6 (sweeper) depends on both and on `core.expireInbox`.

## Known Stubs / Gaps

None in Phase 3. Every code path has a real implementation and is test-covered. Placeholder-free.

Deferred, documented, NOT a stub:
- **Message paging** (D-16) — `listMessages` returns everything up to 100 000 rows. Inboxes live minutes-hours with at most low-hundreds of messages in v1; paging lands when bounded assumption fails.
- **Multi-domain support** — v1 ships one domain from `config.domain`; the data model already carries `domain` as a first-class column so rotation requires no schema migration (Phase 2 locked this).
- **Body sanitization (DOMPurify)** — D-13 places this in the SMTP adapter (Phase 4), NOT in core. `ingestMessage` writes `htmlBody` verbatim into `html_body_sanitized`.

## Threat Surface Summary

No new external surface introduced in Phase 3 beyond what Phase 2 already catalogued. Phase 3's net threat-mitigation contribution:

- **Address enumeration:** wrong view-token returns `forbidden` (never `not_found`) via timing-safe compare over SHA-256 hashes. DB leak forces an online oracle attack rather than direct cookie-read.
- **Attachment path injection:** sha256 regex `/^[0-9a-f]{64}$/` and non-empty-path check refuse invalid descriptors before DB contact and before bus emit. No partial state on malformed inputs.
- **Body/sha leakage:** `AttachmentView` shape is locked to `{id, filename, contentType, size}` with a string-serialization test asserting `sha256`/`storage_path`/`storagePath` never appear in a list response.
- **Listener-induced DoS:** a throwing listener on the bus cannot propagate to the SMTP hot path (wrapper-caught, logged via `console.error`, emit call never throws).
- **File persistence after inbox expiry:** `expireInbox` unlinks orphan blobs post-commit with cross-inbox dedup preserved (SHAs still referenced by surviving inboxes are left in place).
- **D-03 boundary hardened:** source-grep invariant now catches any future commit that tries to sneak `better-sqlite3` or `node:fs` into `src/core/`.

## Self-Check: PASSED

- All 5 src/core files present: bus.ts, inboxes.ts, messages.ts, index.ts, types.ts
- All 5 tests/core files present: bus.test.ts, inboxes.test.ts, messages.test.ts, no-direct-db.test.ts, composition.test.ts
- All 4 plan SUMMARY files present: 03-01, 03-02, 03-03, 03-04
- This phase summary file present
- `npm run typecheck` — exit 0
- `npm run check` — exit 0 (41 files)
- `npx vitest run` — exit 0 (100/100 tests across 15 files)

---
*Phase 03-core-domain-logic: complete*
*Unblocks Phase 4 (SMTP) and Phase 5 (HTTP/SSE) parallel execution*
*Completed: 2026-04-18*
