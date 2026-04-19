# Plan 04-06 Summary — Tests

## Delivered
- `tests/smtp/support/smtp-harness.ts` — integration harness.
  Spins up in-memory SQLite + real Core + real attachment store in a
  tmpdir + dev self-signed cert + capturing pino-like logger.
  `buildHarness({ tokensPerMinute?, burst?, maxMessageBytes?, initialNowMs? })`
  → `{ port, server, core, repos, config, captured, setNow, close }`.
- `tests/smtp/support/smtp-client.ts` — tiny line-oriented SMTP client
  (connect / read / command / writeRaw / close) that handles CRLF framing
  and multi-line replies. Enough surface for EHLO, MAIL FROM, RCPT TO, DATA,
  and AUTH probes; doesn't depend on nodemailer's user-facing client so
  tests don't bleed in nodemailer's own retry/timeout behavior.

## Tests (by requirement)
- **SMTP-01** `server-bind.test.ts` — port binds, banner arrives.
- **SMTP-02** `server-bind.test.ts` — AUTH → 500-series rejection.
- **SMTP-03** `server-bind.test.ts` + `data.test.ts` — EHLO SIZE=10485760,
  oversize → 552.
- **SMTP-04** `rcpt.test.ts` — 550 unknown-recipient, 550 wrong-domain,
  250 existing inbox.
- **SMTP-05** `data.test.ts` — multipart message ingested, text + sanitized
  html + attachment preserved via `listMessages`.
- **SMTP-06** `server-bind.test.ts` — EHLO advertises STARTTLS.
- **SMTP-07** `rate-limit.test.ts` + `rate-limit-integration.test.ts` —
  bucket math, 452 trip, `abuse_counters` row bumped.
- **SMTP-08** `server-bind.test.ts` — `raw.options.socketTimeout` / 
  `closeTimeout` match config.
- **SMTP-09** `log.test.ts` + `pii-logs.test.ts` — whitelist enforced at
  the helper level; end-to-end grep assertion on a real session shows no
  PII leaks.
- Plus `invariants.test.ts` — grep tests banning `better-sqlite3` and raw
  `pino` imports under `src/smtp/*` (except `log.ts`).

## Verification
- `npm test` — 170 tests passing (100 baseline + ~35 HTTP added by parallel
  Phase 5 + ~35 SMTP added here).

## Commit
Folded into the consolidated SMTP commit.
