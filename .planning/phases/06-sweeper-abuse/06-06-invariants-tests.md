---
phase: 06-sweeper-abuse
plan: 06-06
title: Invariant tests — no PII logs, no external log shipping
depends_on: []
requirements:
  - ABUSE-03
  - ABUSE-04
decisions:
  - D-24
  - D-25
---

# Plan 06-06 — Cross-layer invariants

## Goal

Ship two cheap grep-style invariant tests that guard against future
regressions:
1. No PII in log output (smtp + http)
2. No third-party log-shipping SDK imports

## Must-have checklist

- [ ] `tests/invariants/no-pii-logs.test.ts`:
      - Builds the SMTP harness (already PII-safe tested) AND drives a full
        HTTP mint→GET→messages flow capturing the HTTP logger output.
      - Asserts no captured log line contains: full address, local-part,
        subject literal, body canary, attachment filename.
      - This complements the existing `tests/smtp/pii-logs.test.ts` by
        extending the guarantee across HTTP.
- [ ] `tests/invariants/no-external-log-shipping.test.ts`:
      - Recursively reads every `.ts` file under `src/`.
      - Fails if any file imports or references any of:
        `datadog`, `@datadog`, `sentry`, `@sentry`, `logtail`, `loggly`,
        `papertrail`, `logstash`, `@opentelemetry`, `splunk-logging`,
        `newrelic`, `winston-mongodb`, `bugsnag`.
      - Also fails if any file contains a URL matching known shipping hosts
        (`intake.logs.datadoghq`, `sentry.io`, `in.logs.betterstack`).
      - Allowlists the test file itself (self-reference is fine).

## Tasks

### 06-06-01 no-pii-logs cross-layer `<automated>`

`tests/invariants/no-pii-logs.test.ts`:
- Reuse `buildTestRig` with a pino logger that captures to an array via
  `pino({ level: 'info' }, { write(chunk) { captured.push(chunk) }})`.
- Mint an inbox, GET it, list messages (empty), call healthz.
- Serialize captured lines → assert none contain literal address / inboxId /
  view-token. (Inbox id is opaque nanoid; check that address local-part is
  absent.)

Conventional commit: `test(invariants): cross-layer no-PII-in-logs assertion`

### 06-06-02 no-external-log-shipping `<automated>`

`tests/invariants/no-external-log-shipping.test.ts`:
- Walk `src/**/*.ts` with `readdirSync` recursion (same pattern as
  `tests/smtp/invariants.test.ts`).
- For each file, for each forbidden substring, assert `.not.toContain(...)`.

Conventional commit: `test(invariants): forbid external log-shipping SDK imports`

### 06-06-03 Ratelimit coverage test `<automated>`

`tests/sweeper/rate-limit-coverage.test.ts` — ABUSE-01 verification:
- Given the documented per-route limits in `src/http/routes/*.ts`, the test
  mints/reads until 429 and asserts the envelope + `Retry-After` header.
- Adds coverage for `meta` bucket (60/min) and `attach` bucket (default 120/min)
  that weren't tested in Phase 5's rate-limit.test.ts.

Conventional commit: `test(abuse): verify per-route rate-limit coverage`

## Verification

- `npm test -- tests/invariants` passes
- `npm test -- tests/sweeper/rate-limit-coverage.test.ts` passes
- `npm run typecheck` / `npm run check` clean
