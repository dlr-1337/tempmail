# Plan 04-04 Summary — DATA parse + sanitize + ingest (SMTP-03, SMTP-05)

## Delivered
- `src/smtp/sanitizer.ts` — `createHtmlSanitizer()` returns a
  reusable `{ sanitize }` backed by isomorphic-dompurify. Locked config per
  D-18: FORBID_TAGS script/style/iframe/object/embed/base/link,
  FORBID_ATTR style/srcset/srcdoc/formaction, ALLOW_DATA_ATTR:false,
  plus a `uponSanitizeAttribute` hook that strips `on*` handlers AND
  zaps `data:` / `javascript:` / `vbscript:` URIs on src/href/action.
  Remote-src `<img>` tags DELIBERATELY preserved (D-20).
- `src/smtp/parser.ts` — `parseIncoming(stream, { attachmentStore })` wraps
  `mailparser.simpleParser` in its streaming form (D-17: NEVER
  `simpleParser(Buffer)`). Counts bytes on a PassThrough while data flows
  through to the parser. Every attachment buffer is piped through
  `attachmentStore.writeAttachment` → `{sha256, storagePath, sizeBytes}`.
- `src/smtp/data.ts` — `buildOnData(deps)` returns the `onData` handler:
  check `sizeExceeded` → 552 (SMTP-03), parse, sanitize HTML, iterate
  `session.envelope.rcptTo` and call `core.ingestMessage` per recipient.
  Rejects with 550 on any ingest failure.

## Notes
- mailparser's `simpleParser` inherently buffers individual attachment
  bodies as it decodes them. That's upstream design and is bounded by
  `size: 10 MiB` at the server level — acceptable per CONTEXT.md.
- `data:` URI blocking required a custom `uponSanitizeAttribute` hook;
  DOMPurify's default `ALLOWED_URI_REGEXP` alone is insufficient because
  DOMPurify special-cases `data:image/*` for img src.

## Verification
- `tests/smtp/sanitizer.test.ts` — 10 cases covering every D-18 clause.
- `tests/smtp/data.test.ts` — happy-path persists via Core, 552 for oversize.

## Commit
Folded into the consolidated SMTP commit.
