# Plan 04-05 Summary — Rate limit + PII-safe logs (SMTP-07, SMTP-09)

## Delivered
- `src/smtp/rate-limit.ts` — `createRateLimiter({ config, now })` returns a
  `{ take, peek, size }` token-bucket keyed on IP prefix. Refill is continuous
  (`tokensPerMinute` / 60_000 per ms). Cleanup is amortized — only when the
  map exceeds 10_000 entries, evicts ones untouched for 10 minutes.
- `ipPrefix(ip)` helper — IPv4 `/24`, IPv4-mapped IPv6 treated as IPv4,
  IPv6 `/64`. Unknown inputs pass through so the limiter still isolates.
- `src/smtp/log.ts` — `createSmtpLogger({ pino, salt, now })` returns a
  `SmtpLogger` with named methods (`connectionStart`, `rcptAccepted`,
  `rcptRejected`, `dataAccepted`, `dataRejected`, `rateLimited`). Each
  builds a whitelisted field object (D-26) and calls pino's typed
  interface. `hashLocalPart(local, domain, salt)` → first 16 hex chars of
  sha256 (D-27).
- `src/smtp/server.ts` wires the rate limiter and log emitter into the
  recipient and data handlers; the recipient handler also calls
  `repos.abuse.incrementCounter(prefix, 'smtp_452', windowStart)` per D-23.

## Notes
- HTTP layer's rate limiter is separate (Phase 5 uses `@fastify/rate-limit`).
  No cross-layer sharing per D-22.
- `src/smtp/log.ts` is the ONLY file in `src/smtp/*` that touches pino's
  method signatures. Enforced by `tests/smtp/invariants.test.ts`.

## Verification
- `tests/smtp/rate-limit.test.ts` — bucket exhaustion, refill, isolation,
  peek.
- `tests/smtp/log.test.ts` — every log method, salt rotation, whitelist
  enforcement.
- `tests/smtp/rate-limit-integration.test.ts` — end-to-end 452 response +
  `abuse_counters` row bumped.
- `tests/smtp/pii-logs.test.ts` — full SMTP session produces ZERO log bytes
  containing the address, subject, body, or attachment filename.

## Commit
Folded into the consolidated SMTP commit.
