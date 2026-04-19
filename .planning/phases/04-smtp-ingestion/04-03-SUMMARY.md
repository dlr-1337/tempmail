# Plan 04-03 Summary — Recipient lookup (SMTP-04)

## Delivered
- Core extension: `InboxAddressView` + `InboxesApi.findInboxByAddress(local, domain)`
  added to `src/core/inboxes.ts`, surfaced on `CoreApi` in `src/core/index.ts`.
  Thin passthrough to `repos.inboxes.findInboxByLocalPart` that returns a
  neutral `{id, localPart, domain}` view — no view-token hash, no
  timestamps — honoring Phase 3 D-03 boundary.
- `src/smtp/recipient.ts` — `buildOnRcptTo(deps)` returns an `onRcptTo`
  handler that, in order:
  1. Consumes a token from the per-prefix rate limiter (plan 04-05).
  2. Validates `address.address` syntax.
  3. Rejects wrong-domain with `550 5.7.1 Relay access denied`.
  4. Calls `core.findInboxByAddress` — missing → `550 5.1.1 Unknown recipient`
     (no catch-all).
- Tests in `tests/core/find-inbox-by-address.test.ts` cover found /
  not-found / wrong-domain branches on the Core helper itself.
- Integration test `tests/smtp/rcpt.test.ts` drives a raw SMTP client and
  asserts 550 for unknown local-part, 550 for wrong-domain, 250 for existing
  inbox.

## Notes
- Phase 5 agent added other Core methods in parallel (`getInbox`,
  `verifyInboxAccess`, `getMessage`, `getAttachmentForInbox`,
  `recordAbuse`). Those are their scope, but the shared interface file
  forced us to keep the factory synchronization tight; resolved cleanly.

## Verification
- All Core + SMTP tests green.

## Commit
Folded into the consolidated SMTP commit.
