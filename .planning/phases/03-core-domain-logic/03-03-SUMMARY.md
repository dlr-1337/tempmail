---
phase: 03-core-domain-logic
plan: 03
subsystem: core
tags: [core, messages, ingest, list, event-bus, atomic, enumeration-safe, emit-after-commit]
depends_on: [03-01, 03-02]

# Dependency graph
requires:
  - phase: 02-storage-layer
    provides: "Repos aggregate (inboxes/messages/attachments), withTransaction, NewMessage/NewAttachment types, MessageRow/AttachmentRow, newId, nowMs"
  - phase: 03-core-domain-logic
    plan: 01
    provides: "Typed Bus (createBus) with emit + on + listener-failure isolation; MessageEvent { inboxId, messageId, receivedAt }"
  - phase: 03-core-domain-logic
    plan: 02
    provides: "Standalone verifyViewToken(row, token) export — single source of truth for the constant-time view-token compare (D-15)"
provides:
  - "src/core/messages.ts — createMessages(deps) factory returning { ingestMessage, listMessages }"
  - "Discriminated-union results per D-19: IngestResult (unknown_recipient | invalid_attachment | invalid_envelope) and ListMessagesResult (not_found | forbidden)"
  - "Atomic insert via repo's withTransaction; bus emit happens strictly AFTER commit (D-11)"
  - "Listener-failure isolation: a throwing subscriber cannot roll back the DB and cannot propagate to the SMTP hot path"
  - "Sliding-TTL bump via updateLastActivity(inboxId, receivedAt + idleTtlMs) (D-12)"
  - "Defensive attachment reject (64-char lowercase hex sha256 + non-empty path) per D-14"
  - "listMessages returns ASC chronological MessageView with attachment metadata ONLY — no sha256, no storage_path, no body contents"
  - "Exports: createMessages, MessagesApi, MessagesDeps, MessagesConfig, IngestInput, IngestAttachmentInput, IngestResult, ListMessagesInput, ListMessagesResult, MessageView, AttachmentView"
affects: [03-04-composition-root, 04-smtp-adapter, 05-http-sse]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory-returning-bound-functions (createMessages(deps) → MessagesApi, mirrors createInboxes / repo pattern)"
    - "Envelope parser strict to single-'@' local-part+domain — rejects source routes, empties, and multi-'@' defensively"
    - "Regex-gated sha256 validation (/^[0-9a-f]{64}$/) — refuses uppercase, wrong length, non-hex chars"
    - "Emit-after-commit ordering — synchronous withTransaction ensures the repo call returns only after COMMIT lands, so a subsequent bus.emit is necessarily post-commit"
    - "In-memory ASC reverse of repo's DESC result — O(n) on a small n (D-16)"
    - "Metadata-only AttachmentView shape — {id, filename, contentType, size} EXACTLY; never sha256 or storage_path"

key-files:
  created:
    - src/core/messages.ts
    - tests/core/messages.test.ts
  modified: []

key-decisions:
  - "D-11 emit-after-commit: the repo's withTransaction is synchronous; the bus.emit line sits AFTER the insertMessageWithAttachments return, guaranteeing any subscriber sees the row via the repos on re-read."
  - "D-12 ingest signature: { envelopeTo, envelopeFrom, sender, subject, textBody, htmlBody, headers, attachments, sizeBytes } → { ok: true, messageId } | { ok: false, reason: ... }; unknown_recipient branch + last_activity_at bump baked in."
  - "D-13 verbatim html: core writes htmlBody into html_body_sanitized untouched — DOMPurify is the SMTP adapter's concern (Phase 4)."
  - "D-14 defensive attachment reject: missing sha256 or empty path short-circuits before DB contact and before bus emit. No partial state."
  - "D-15 wrong-token → forbidden (never not_found): reuses the standalone verifyViewToken from inboxes.ts — single source of truth, no re-implementation drift."
  - "D-16 no paging: listMessages passes limit=100_000 to the repo; inboxes are bounded (minutes-hours, tens of messages)."
  - "AttachmentView shape locked to {id, filename, contentType, size} — sha256 and storage_path are internal. Test 13 string-serializes the response and asserts none of those keys leak."
  - "Envelope parser is stricter than RFC 5321 (no quoted local-parts, no source routes) — defensible at the core layer because the SMTP adapter is already filtering. Core returns invalid_envelope rather than throwing."

patterns-established:
  - "Plan 03-03 extends plan 03-02's factory-+-deps conventions: factory name createXxx(deps), deps include repos + optional now + config; tests seed via the repo directly when possible (avoid dragging in sibling factories)."
  - "Listener-failure isolation is the bus's responsibility — callers never wrap emit in try/catch."
  - "envelopeTo is trusted as a string but not as a parse — always run parseEnvelope() first, never a naïve split."

requirements-completed: [CORE-03, CORE-04]

# Metrics
duration: ~20min
completed: 2026-04-18
tasks_completed: 3
files_created: 2
---

# Phase 3 Plan 03: Messages Domain Logic Summary

**Protocol-agnostic `createMessages(deps)` factory — ingestMessage persists the message row + attachment rows atomically via the repo's withTransaction, bumps last_activity_at, and emits `bus.emit('message', ...)` strictly AFTER the DB commit (D-11). listMessages resolves the inbox, constant-time-compares the view-token via the shared verifyViewToken helper (D-15: wrong-token → forbidden, NEVER not_found), and returns ASC-chronological MessageViews with attachment metadata ONLY — no sha256, no storage_path, no body contents.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-18T~11:10Z
- **Completed:** 2026-04-18T~11:20Z
- **Tasks:** 3 (2 code + 1 gate)
- **Files modified:** 2 (created)

## Accomplishments

- `createMessages(deps)` factory returning `{ ingestMessage, listMessages }` bound to a `Repos` + `Bus` + `MessagesConfig`.
- `ingestMessage()`:
  - `invalid_envelope` short-circuit (no `@`, multiple `@`, empty local-part, empty domain).
  - `unknown_recipient` for addresses that don't resolve via `findInboxByLocalPart`.
  - `invalid_attachment` for any descriptor that fails the 64-char lowercase hex sha256 test or has an empty path (D-14).
  - Atomic insert via `repos.messages.insertMessageWithAttachments` — either the message row AND all attachment rows land, or none do.
  - Sliding-TTL bump: `updateLastActivity(inbox.id, receivedAt + idleTtlMs)` — the SQL `MIN(?, hard_expires_at)` cap is enforced at the repo layer.
  - Headers serialized via `JSON.stringify(headers)` when non-null; null stored as null.
  - `htmlBody` stored verbatim into `html_body_sanitized` (D-13).
  - `bus.emit('message', { inboxId, messageId, receivedAt })` on the line AFTER the repo call returns — guaranteed post-commit.
- `listMessages()`:
  - `not_found` for unknown inbox id.
  - `forbidden` for wrong view-token on an existing inbox — D-15 anti-enumeration.
  - Attachment metadata ONLY — `{id, filename, contentType, size}`. Test 13 string-serializes the entire response and asserts `sha256`, `storage_path`, `storagePath`, and the body strings do NOT appear anywhere.
  - `hasTextBody` / `hasHtmlBody` booleans instead of the bodies themselves — bodies are the single-message endpoint's responsibility (Phase 5 API-04).
  - ASC chronological via in-memory `sort((a,b) => a.receivedAt - b.receivedAt)`.
- 24-case Vitest suite covering: emit-after-commit, atomic message+attachment insert, unknown_recipient, invalid_envelope (4 table-driven), invalid_attachment (6 table-driven), throwing-listener isolation, last_activity_at bump, headers serialization, verbatim html, exact emit payload, ASC ordering, not_found, forbidden, metadata-only shape, empty-inbox happy path, and correct-token happy path.

## Task Commits

Each task was committed atomically on branch `gsd/phase-02-storage-layer`:

1. **Task 1: Implement ingestMessage + listMessages** — `8679453` (feat)
2. **Task 2: Vitest coverage** — `bcb0b9b` (test)
3. **Task 3: Plan-level gate** — no commit (verification-only; no file changes)

**Plan metadata commit:** pending (docs commit wraps this file + STATE.md + ROADMAP.md + REQUIREMENTS.md).

## Files Created/Modified

- `src/core/messages.ts` — 257 lines. Factory + type exports (`createMessages`, `MessagesApi`, `MessagesDeps`, `MessagesConfig`, `IngestInput`, `IngestAttachmentInput`, `IngestResult`, `ListMessagesInput`, `ListMessagesResult`, `MessageView`, `AttachmentView`). Two module-private helpers: `parseEnvelope`, `isValidAttachment`. One private const: `SHA256_HEX_RE = /^[0-9a-f]{64}$/`.
- `tests/core/messages.test.ts` — 397 lines, 24 test cases split into two `describe` blocks (ingest, list).

## Verification Results

All three plan-gate commands exit 0:

- `npm run typecheck` — 0 errors.
- `npm run check` — Biome clean across 37 files.
- `npx vitest run` — 90/90 tests pass (66 pre-existing + 24 new in `tests/core/messages.test.ts`).
- `npx vitest run tests/core/messages.test.ts` — 24/24 pass individually (~42ms).

End-to-end forbidden-imports greps clean:

- No `better-sqlite3` imports under `src/core/` (only doc-comment mentions in `messages.ts` and `inboxes.ts` self-attesting to compliance).
- No `node:fs` imports under `src/core/`.
- No `db.prepare(` or `db.exec(` under `src/core/`.
- No string literals `'sha256'`, `'storage_path'`, `'storagePath'` in `src/core/messages.ts` — the AttachmentView shape cannot accidentally serialize those keys.

## Decisions Made

- Followed the plan's `<action>` code blocks verbatim for both `src/core/messages.ts` and the test file's structure — the plan was specified tightly enough that no implementation latitude was needed.
- Added two extra attachment fuzz-inputs (`'a'.repeat(65)` too-long and `'a'.repeat(63) + 'z'` invalid-hex-char) to the table-driven `invalid_attachment` case — catches regressions where a future refactor loosens the regex (e.g. drops the anchored `^$` or switches to `test()` on an unescaped character class).
- Added a "emits exactly once" test and a "correct payload shape" test beyond the plan's minimum — they're cheap and guard the contract the composition root (plan 03-04) and SSE handler (Phase 5) rely on.
- Added an `empty-inbox happy path` assertion alongside the populated-inbox path — proves `listMessages` short-circuits cleanly when `listMessagesByInbox` returns an empty array (no NPE on `rows.map` over `[]`).
- Kept `parseEnvelope` and `isValidAttachment` as module-private helpers (not exported) — the test file exercises them only through `ingestMessage`, which is the correct unit of test.

## Deviations from Plan

None functional. Only authored-choice augmentations (non-deviations):

- **Two additional `invalid_attachment` rows** (`'a'.repeat(65)` and `'a'.repeat(63) + 'z'`) — strengthens the regex contract without changing the surface.
- **Two additional positive tests** ("emits exactly once" and "emits with the correct payload shape") — nails down `bus.emit`'s call-count and payload contract for the downstream SSE handler.

All additions are test-only and cost negligible time. The plan's 14-case minimum is satisfied; the actual count is 24 (including 4+6=10 table-driven cases in `it.each`).

## Issues Encountered

- **Biome import-sort flag on first run of `src/core/messages.ts`:** Biome's `organizeImports` preferred `../db/repos/index.js` and `../util/now.js` before `./bus.js` and `./inboxes.js` (alphabetical by path). Fixed by swapping the two import groups before committing Task 1. Same pattern plan 03-01 encountered; not counted as a deviation since the plan's `<action>` pre-authorizes Biome-driven reorderings.
- Typecheck + Biome + Vitest all clean on first run after the import-sort fix. All 24 Vitest cases passed on first run — no debugging needed.

## User Setup Required

None — no external services, no env vars, no dashboard configuration, no auth gates.

## Next Phase Readiness

- **Plan 03-04 (composition root)** can now call `createMessages({ repos, bus, config: { domain, idleTtlMs } })` and wire the returned `{ ingestMessage, listMessages }` into the HTTP + SMTP adapter layers. The Deps type is stable; no surprises for the composition root to absorb.
- **Phase 4 (SMTP adapter)** will call `ingestMessage` on every accepted `DATA` — the return shape lets it translate `unknown_recipient` → SMTP 550 and `invalid_attachment` / `invalid_envelope` → SMTP 550 with the appropriate reason. The SMTP adapter must sanitize `htmlBody` BEFORE calling ingest (per D-13).
- **Phase 5 (HTTP + SSE)** will call `listMessages` from the `GET /api/inbox/:id/messages` route — the `forbidden` branch is the anti-enumeration guarantee. The SSE handler subscribes to `bus.on('message', ...)` and uses the event to nudge a re-query via `repos` (replay-on-subscribe semantics per D-10 + plan 03-01).
- No blockers. Plan 03-04 can proceed immediately.

## Known Stubs

None. Every code path in `src/core/messages.ts` has a real implementation and is test-covered. No TODOs, no placeholder data, no mocked return values leaking into the module. The `hasTextBody` / `hasHtmlBody` booleans and the absence of body strings in `MessageView` are INTENTIONAL — the body is returned by the single-message endpoint (API-04 in Phase 5), not by the list view. This is documented in the plan and in the code comment.

## Threat Flags

None new. This plan implements the mitigations required by CORE-03 (atomic ingest + emit), CORE-04 (view-token gated list), D-13 (core-stores-verbatim-html), D-14 (defensive attachment reject), and D-15 (wrong-token → forbidden):

- **Atomicity (CORE-03):** The repo's `withTransaction` guarantees all-or-nothing for the message row + attachment rows. A mid-insert throw leaves zero new DB state. A listener throw is caught by the bus wrapper and never reaches the SMTP hot path.
- **Emit-after-commit (D-11):** The bus.emit line is textually (and therefore execution-order) AFTER the synchronous repo call returns. A subscriber that re-reads via `repos.messages.findMessageById(messageId)` inside its listener is guaranteed to see the row — covered directly by test 1.
- **Enumeration-safe listing (D-15):** Wrong view-token returns `forbidden`, never `not_found`. Test 12 asserts exactly `reason === 'forbidden'` on an existing inbox with a wrong token. The constant-time compare is delegated to `verifyViewToken` (plan 03-02) — single source of truth.
- **No body/sha/storage_path leakage (D-14):** `AttachmentView` is locked to `{id, filename, contentType, size}`. Test 13 string-serializes the entire response and asserts `sha256`, `storage_path`, `storagePath`, and the body strings do NOT appear anywhere. Future refactors that accidentally widen the shape will fail this test.
- **Defensive attachment validation:** Uppercase hex, wrong-length hex, non-hex chars, and empty paths are all rejected before DB contact and before bus emit. No partial state.

No new network surface, no new auth path, no schema changes.

## Self-Check: PASSED

- `src/core/messages.ts` — FOUND
- `tests/core/messages.test.ts` — FOUND
- `.planning/phases/03-core-domain-logic/03-03-SUMMARY.md` — FOUND (this file)
- Commit `8679453` (feat(core): add ingestMessage and listMessages) — FOUND in `git log`
- Commit `bcb0b9b` (test(core): cover ingestMessage atomicity, emit-after-commit, and listMessages enumeration safety) — FOUND in `git log`
- `npm run typecheck` — exit 0
- `npm run check` — exit 0 (37 files)
- `npx vitest run` — exit 0 (90/90 tests)
- Forbidden-imports greps — all three clean (no `better-sqlite3` imports, no `node:fs`, no `db.prepare|db.exec` under `src/core/`)
- AttachmentView shape grep — no `'sha256'`, `'storage_path'`, or `'storagePath'` string literals in `src/core/messages.ts`

---
*Phase: 03-core-domain-logic*
*Plan: 03*
*Completed: 2026-04-18*
