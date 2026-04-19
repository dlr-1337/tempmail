---
phase: 4
plan: 4
status: ready
type: execute
wave: 4
depends_on: [2, 3]
requirements: [SMTP-03, SMTP-05]
files_modified:
  - src/smtp/parser.ts
  - src/smtp/sanitizer.ts
  - src/smtp/data.ts
  - src/smtp/server.ts
autonomous: true
tags: [smtp, mailparser, dompurify, streaming]
---

## Goal

Implement `onData` — stream-parse the incoming message with `mailparser.simpleParser(stream)`, pipe each attachment through `attachmentStore.writeAttachment` to get `{sha256, storagePath, sizeBytes}`, sanitize HTML via DOMPurify with the locked config (D-18), then call `core.ingestMessage`.

Bridge `IngestResult`:
- `ok:true` → `cb(null, 'Message queued')`
- `ok:false, reason:'unknown_recipient'` → `cb` with a 550 error (unreachable if onRcptTo did its job; defensive)
- `ok:false, reason:'invalid_attachment'` → 550
- `ok:false, reason:'invalid_envelope'` → 550
- stream `sizeExceeded` → 552 (SMTP-03)

Key invariants:
- Streaming throughout. No `Buffer.concat` of the whole message (D-17).
- HTML sanitizer initialized ONCE at factory time (D-03, D-18, gotcha re: jsdom startup cost).
- `javascript:`, `vbscript:`, `data:` URIs are stripped; `script`/`style`/`iframe`/`object`/`embed`/`base`/`link` tags removed; `on*`/`style`/`srcset`/`srcdoc`/`formaction` attributes removed.
- Remote `img src` is left intact (D-20).

## Must-have checklist (requirement IDs)

- SMTP-03: oversize → 552 via `stream.sizeExceeded`
- SMTP-05: uses `simpleParser(stream)` (streaming form), NOT `simpleParser(Buffer)`
- D-13 + D-18: sanitizer applied to `htmlBody` before `core.ingestMessage`
- D-20: remote-src images preserved, `data:` image srcs stripped
- Attachments: each piped through `attachmentStore.writeAttachment(stream)` — content-addressed

## Tasks

1. Write `src/smtp/sanitizer.ts`:
   - `createHtmlSanitizer()` returns `{ sanitize(html: string | null): string | null }`.
   - Uses `isomorphic-dompurify` with the exact config from D-18.
   - Initialized once, reused.
2. Write `src/smtp/parser.ts`:
   - `parseIncoming(stream, { attachmentStore }) → Promise<ParsedMessage>` where `ParsedMessage = { sender, subject, textBody, htmlBody, headers, attachments: WrittenAttachment[], sizeBytes }`.
   - Uses `simpleParser(stream)` with `skipTextLinks`, `skipImageLinks` default — we rely on the sanitizer.
   - For each attachment returned by mailparser, create a `Readable.from(content)` for the buffer and write via `attachmentStore.writeAttachment`. (Mailparser buffers attachments by design in simpleParser — that's acceptable per D-13; per-attachment buffer, NOT whole-message buffer.)
3. Write `src/smtp/data.ts`:
   - `buildOnData({ core, attachmentStore, sanitizer, rateLimiter, log, config })` → returns the `onData` handler.
   - Flow: check `stream.sizeExceeded` on 'end' → 552; parse; sanitize html; call `core.ingestMessage`; map result to SMTP codes.
4. Wire into `server.ts` via the factory's injected deps.
5. `<automated>` verify: `npm run typecheck && npm run check`.

Commits:
- `feat(04-smtp): add DOMPurify-backed HTML sanitizer with locked policy`
- `feat(04-smtp): add streaming message parser and attachment bridge`
- `feat(04-smtp): wire onData to ingestMessage with 550/552 bridging`

## Verification

- Types clean, Biome clean.
- End-to-end covered in plan 04-06 integration tests.
