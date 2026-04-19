---
phase: 4
plan: 6
status: ready
type: execute
wave: 5
depends_on: [1, 2, 3, 4, 5]
requirements: [SMTP-01, SMTP-02, SMTP-03, SMTP-04, SMTP-05, SMTP-06, SMTP-07, SMTP-08, SMTP-09]
files_modified:
  - tests/smtp/support/smtp-harness.ts
  - tests/smtp/rate-limit.test.ts
  - tests/smtp/sanitizer.test.ts
  - tests/smtp/log.test.ts
  - tests/smtp/server-bind.test.ts
  - tests/smtp/rcpt.test.ts
  - tests/smtp/data.test.ts
  - tests/smtp/invariants.test.ts
autonomous: true
tags: [smtp, tests, integration]
---

## Goal

Cover all SMTP-01..09 with a mix of unit tests (rate limiter, sanitizer, log helper) and integration tests driving a real `smtp-connection` client against the in-process server with an in-memory SQLite + real attachment store on a tmp dir.

## Must-have checklist (mapping tests to reqs)

- SMTP-01: server-bind test opens a port, smtp-connection gets the 220 banner
- SMTP-02: AUTH attempt → reject (smtp-server with `disabledCommands:['AUTH']` refuses AUTH commands)
- SMTP-03: 11 MiB message → 552 at DATA
- SMTP-04: unknown recipient → 550; wrong-domain recipient → 550
- SMTP-05: streaming parse (verify no whole-message buffer via attachment hash + body presence)
- SMTP-06: STARTTLS present (EHLO response includes `STARTTLS`); a TLS-upgraded session sends a message successfully
- SMTP-07: 21 RCPT TO from the same IP trips 452 after bucket empties; abuse counter incremented
- SMTP-08: socket timeout configured (observe `server.options.socketTimeout === config.timeouts.socketMs`)
- SMTP-09: log events emitted for a full session contain ZERO occurrences of the real address, subject, body, or filename (grep assertion on captured pino transport)

Also:
- invariants.test.ts: grep for raw `pino` imports in `src/smtp/*.ts` (except `log.ts`); grep for `better-sqlite3` import in `src/smtp/**`.
- findInboxByAddress regression already landed in plan 04-03's test file.

## Tasks

1. `tests/smtp/support/smtp-harness.ts`:
   - `buildHarness()` returns `{ core, repos, attachmentStore, db, config, captured, server, connect }`.
   - Uses `@ tests/support/db-helper` + `tmpdir` helpers.
   - Builds an ephemeral pino with an in-memory transport that captures log lines for later assertion.
   - Starts the server on port 0 (ephemeral) and returns the assigned port.
2. Individual test files. Each uses an `smtp-connection` client (already in node_modules via smtp-server's dep chain) or constructs a raw net socket for EHLO + rejection tests.
3. `<automated>` verify: `npm run typecheck && npm run check && npm test`.

Commits:
- `test(04-smtp): add integration harness with in-memory sqlite and captured logs`
- `test(04-smtp): cover SMTP-01..04 server bind, AUTH disabled, rcpt 550`
- `test(04-smtp): cover SMTP-05 streaming parse + sanitizer behavior`
- `test(04-smtp): cover SMTP-06 STARTTLS negotiation`
- `test(04-smtp): cover SMTP-07 rate limit and abuse counter`
- `test(04-smtp): cover SMTP-08/09 timeouts + PII-safe logs`
- `test(04-smtp): enforce no-raw-pino and no-better-sqlite3 invariants`

## Verification

- `npm test` exits 0 with +30-ish new test cases.
- Log-grep test sees no PII byte sequences.
