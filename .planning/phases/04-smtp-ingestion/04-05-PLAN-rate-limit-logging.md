---
phase: 4
plan: 5
status: ready
type: execute
wave: 4
depends_on: [2]
requirements: [SMTP-07, SMTP-09]
files_modified:
  - src/smtp/rate-limit.ts
  - src/smtp/log.ts
  - src/smtp/server.ts
autonomous: true
tags: [smtp, rate-limit, logging, pii]
---

## Goal

Implement two orthogonal concerns:

1. **Token-bucket rate limiter** keyed on sender IP prefix (`/24` IPv4, `/64` IPv6). Applied at `onRcptTo` (so a 452 is returned before any DATA bandwidth is consumed; smtp-server supports `responseCode` on errors). Refill 10 tokens / 60s, burst 20 (D-21). On bucket empty → 452 error AND `core.abuseRepo.incrementCounter(ipPrefix, 'smtp_452')` via a minimal repo passthrough (D-23).
2. **PII-safe log helper** that wraps `pino` with an explicit whitelist (D-26). NEVER logs addresses, subjects, bodies. Computes `local_part_hash_first8 = sha256(local + domain + salt).slice(0, 16)`.

Rate limiter and log are constructed by the factory, injected into both the `onRcptTo` handler (plan 04-03) and the `onData` handler (plan 04-04).

## Must-have checklist

- SMTP-07: per-sender-IP prefix token bucket; bucket empty → 452 response code.
- D-21: refill 10/60s, burst 20, in-memory Map keyed on normalized prefix, periodic cleanup of stale buckets (simple LRU via last-touch timestamp).
- D-23: 452 trips increment `abuse_counters` via a minimal repo-scoped method on the deps (we pass the concrete `AbuseRepo` into the factory so we don't muddy Core).
- D-26 whitelist: `timestamp, sender_ip, sender_ip_prefix, sender_domain, message_size, smtp_code, duration_ms, local_part_hash_first8`
- D-27: hash helper uses salt from deps (`config.piiLogSalt`)
- D-28: no raw pino import outside `src/smtp/log.ts` (enforced by a grep test in plan 04-06)

## Tasks

1. Write `src/smtp/rate-limit.ts`:
   - `createRateLimiter(config, { now }) → { take(prefix): boolean; size(): number }`.
   - Map<string, { tokens: number; lastRefill: number }>.
   - On `take`: refill since last visit, decrement if >=1, else return false.
   - Cleanup: drop entries not touched in >10 minutes on each `take` call when map size > 10_000 (cheap amortized).
   - Utility `ipPrefix(ip: string): string` — IPv4 `/24` (first three octets + `.0/24`); IPv6 `/64` (first four hex groups + `::/64`); unknown → raw string.
2. Write `src/smtp/log.ts`:
   - `createSmtpLogger({ pino, salt }) → SmtpLogger` with methods `connectionStart`, `rcptAccepted`, `rcptRejected`, `dataAccepted`, `dataRejected`, `rateLimited`. Each builds a whitelisted JSON payload and calls `pino.info`/`pino.warn`.
   - `hashLocalPart(local: string, domain: string, salt: string): string` returns first 16 hex chars.
3. Wire into `server.ts`:
   - Accept `{ core, config, attachmentStore, repos, logger, now }` as deps.
   - Build `rateLimiter`, `smtpLog`, `sanitizer` once; share across handlers.
   - `onRcptTo`: call rateLimiter.take first; if false → abuse counter bump + 452.
4. `<automated>` verify: `npm run typecheck && npm run check`.

Commits:
- `feat(04-smtp): add token-bucket rate limiter with IP-prefix keying`
- `feat(04-smtp): add PII-safe logger with whitelist fields and salted hash`
- `feat(04-smtp): wire rate limit + abuse counter + logging into onRcptTo/onData`

## Verification

- Rate limit + logger have targeted unit tests in plan 04-06.
- `grep -r "import.*pino" src/smtp --include='*.ts' --exclude=log.ts` returns no hits.
