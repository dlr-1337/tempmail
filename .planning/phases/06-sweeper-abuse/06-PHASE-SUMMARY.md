# Phase 6 — Retention Sweeper & Abuse Hardening — Summary

**Status:** COMPLETE
**Delivered:** 2026-04-19
**Branch:** gsd/phase-02-storage-layer (cumulative)

Phase 6 adds a background sweeper that expires idle + hard-TTL-exceeded
inboxes, reaps orphan attachment blobs, and monitors disk pressure. It also
ships the operator-only blocklist endpoint, fail2ban jail templates, and
cross-layer invariant tests that encode the PII-whitelist + no-external-log-
shipping promises from PROJECT.md.

---

## Sweeper API

```ts
import { createSweeper } from 'src/sweeper/index.js';

const sweeper = createSweeper({
  core, repos, attachmentStore, logger,
  // optional:
  config?: { expireBatchSize, reaperMaxPerRun, disk: { highWatermarkPct, criticalWatermarkPct }, intervals: { expireMs, reaperMs, diskMs } },
  now?, nextTickId?, statfs?,
});

sweeper.start();                    // schedule intervals (idempotent)
await sweeper.stop();               // clear intervals + await in-flight (idempotent)
await sweeper.runOnce('all');       // deterministic trigger for tests / admin
sweeper.diskState();                // snapshot { percentUsed, bytesFree, bytesTotal, updatedAt, status }
```

Three scheduled jobs (D-03):

| Job     | Interval | Entry point          | Re-entrancy guard |
|---------|----------|----------------------|-------------------|
| expire  | 60 s     | `runExpireSweep`     | one in-flight promise per job; overlap logs `sweeper.tick_skipped` |
| reaper  | 1 h      | `runOrphanReaper`    | same |
| disk    | 30 s     | `diskProbe.refresh`  | same |

Aggregate log lines per tick (D-07, D-11, D-13) use only whitelisted fields —
never individual inbox ids, addresses, or filenames.

---

## SMTP / HTTP integration with disk state

Both adapters accept a callback that reads `sweeper.diskState()`:

```ts
await createSmtpServer({
  ...deps,
  isAcceptingMail: () => isAcceptingMail(sweeper.diskState()),
});

await createHttpServer({
  ...deps,
  diskState: () => sweeper.diskState(),
});
```

- SMTP: when `isAcceptingMail()` returns `false` (high or critical), the
  `onData` hook drains the stream and responds `452 4.3.1 Insufficient
  system storage`. Legitimate senders queue and retry.
- HTTP mint: when `diskState().status === 'critical'`, `POST /api/inbox`
  returns `503` with `{error:{code:'unavailable',message:'service temporarily unavailable'}}`.
- `GET /healthz` reports `{ status: 'ok'|'degraded', disk: { percentUsed, status } }`
  but never 5xxs — the circuit breaker reports, doesn't fail.

Gotcha addressed: `fs.statfs` failures degrade gracefully to
`status: 'normal'` + one-time warn, so a missing permission never
false-positive refuses mail.

---

## Admin endpoint (ABUSE-02) — auth model

Route: `POST /admin/blocklist` (registered only when
`config.admin.enabled === true`).

Trust model: **bind-based**, per D-17 / D-20.

- `preHandler` rejects every request whose `req.ip` is not `127.0.0.1`,
  `::1`, `::ffff:127.0.0.1`, or `127.0.0.0/8`.
- No auth token. Operators are expected to access via SSH + localhost curl:
  `curl -X POST http://127.0.0.1:<port>/admin/blocklist -d '{"address":"..."}'`.
- In production, Fastify binds to `127.0.0.1` and Caddy never proxies
  `/admin/*` — exposing this route externally would be catastrophic and is
  documented as such in the route docstring.

Body: `{ address: string } | { inboxId: string }` (one required).
Response: 204 on success, 404 if inbox unknown, 400 on missing/malformed,
403 if non-loopback.

Log: single `blocklist_applied` line with whitelisted fields only —
`{ event, reason, by_ip, inbox_id_hash_first8, deleted_messages, unlinked_attachments }`.
Raw address / inbox id NEVER logged.

---

## Invariant tests

| Test                                              | Guards against                            |
|---------------------------------------------------|-------------------------------------------|
| `tests/smtp/invariants.test.ts` (Phase 4)         | SMTP imports `better-sqlite3` or raw pino |
| `tests/smtp/pii-logs.test.ts` (Phase 4)           | SMTP logs leak address / subject / body   |
| `tests/invariants/no-pii-logs.test.ts` (Phase 6)  | HTTP mint/meta/messages/healthz/admin leak address / local-part / inboxId / view-token |
| `tests/invariants/no-external-log-shipping.test.ts` | New dependency on datadog / sentry / logtail / loggly / papertrail / @opentelemetry / splunk-logging / newrelic / bugsnag, or hardcoded exfil hostnames |

The no-external-log-shipping test grep runs in ~35 ms across all
`src/**/*.ts` and is effectively free insurance.

---

## fail2ban files shipped

| File                                     | Purpose                                  |
|------------------------------------------|------------------------------------------|
| `ops/fail2ban/filter.d/tempmail-smtp.conf` | regex matching Phase 4 JSON log lines with `smtp_code` in (452, 550, 554) |
| `ops/fail2ban/filter.d/tempmail-http.conf` | regex matching HTTP 429 log lines with `<HOST>` on `remoteAddress` or `ip` |
| `ops/fail2ban/jail.d/tempmail.conf`        | Two jails (`tempmail-smtp`, `tempmail-http`), bantime=3600, findtime=600, maxretry=20 |

Static content is covered by `tests/sweeper/fail2ban-files.test.ts`.

---

## Test coverage per requirement

| Req       | Tests                                                                 |
|-----------|------------------------------------------------------------------------|
| RETN-01   | `tests/sweeper/expire.test.ts` (idle + hard-TTL), `tests/db/inbox-repo.test.ts` (regression) |
| RETN-02   | `tests/sweeper/expire.test.ts` (aggregate counts, whitelisted fields) |
| RETN-03   | `tests/sweeper/reaper.test.ts` (referenced survive, orphan deleted, .incoming safe, bogus names skipped, maxPerRun) |
| RETN-04   | `tests/sweeper/disk.test.ts`, `tests/sweeper/http-mint-gate.test.ts`, `tests/sweeper/smtp-mail-gate.test.ts` |
| ABUSE-01  | `tests/http/rate-limit.test.ts` (Phase 5, mint), `tests/sweeper/rate-limit-coverage.test.ts` (meta bucket) |
| ABUSE-02  | `tests/sweeper/admin-blocklist.test.ts` (9 cases: loopback, remote, 400, 404, 204 by id, 204 by address, log shape, disabled route) |
| ABUSE-03  | `tests/smtp/pii-logs.test.ts` (Phase 4), `tests/invariants/no-pii-logs.test.ts` (Phase 6 cross-layer) |
| ABUSE-04  | `tests/invariants/no-external-log-shipping.test.ts` (imports + URLs) |
| ABUSE-05  | `tests/sweeper/fail2ban-files.test.ts` (filter + jail content anchors) |

---

## Totals

- Tests: 189 → **238** (+49 from Phase 6 additions)
- Test files: 33 → **44**
- New files created under `src/sweeper/`: 5
- New files created under `tests/sweeper/` + `tests/invariants/`: 11
- New ops files under `ops/fail2ban/`: 3
- Modified files: `src/smtp/server.ts`, `src/http/server.ts`,
  `src/http/routes/inbox.ts`, `src/http/errors.ts`, `src/db/repos/inbox-repo.ts`,
  `tests/db/inbox-repo.test.ts`
- `npm run typecheck`: 0 errors
- `npm run check` on Phase 6 scope: 0 errors (pre-existing Phase 7 `web/*`
  issues are outside my scope and unchanged)
- `npm test`: 238/238 green
