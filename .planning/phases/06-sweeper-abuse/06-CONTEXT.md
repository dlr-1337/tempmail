# Phase 6: Retention Sweeper & Abuse Hardening - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto

<domain>
## Phase Boundary

Periodic expiry of inboxes + orphan attachment reaper + disk-watermark circuit breaker + per-address blocklist admin endpoint + fail2ban jail templates. Makes the service safe to leave unattended.

Scope (REQUIREMENTS.md RETN-01..04, ABUSE-01..05):
- `setInterval(60s)` sweeper deletes expired inboxes + cascade via FK + unlink attachment files (orphan-safe)
- Hourly orphan reaper finds attachment blobs with zero DB references and deletes
- Disk watermark circuit breaker: 80% → SMTP 452 temp-fail; 90% → refuse new inboxes
- Localhost-only admin endpoint `POST /admin/blocklist` to blocklist a specific address on demand
- Per-IP rate limits on inbox creation + reads — already implemented in Phase 5 via @fastify/rate-limit. Verify coverage + document thresholds.
- Whitelist-only logs (timestamp, sender IP, hashed local-part, status code) — already implemented in Phase 4's smtpLog + Phase 5's pino config. Verify.
- No third-party log aggregators — verify absence (no shipping sdk imports, no external endpoints in config)
- `fail2ban` jail templates for SMTP 452/550 bursts and HTTP 429 bursts

Out of scope: rate-limit tuning (post-launch), abuse triage procedures (runbook for Phase 8), multi-tenant provider-AUP checks.

</domain>

<decisions>
## Implementation Decisions

### Module Layout
- **D-01:** New module root `src/sweeper/`. Files: `sweeper.ts` (interval runner), `expire.ts` (inbox expiry logic), `reaper.ts` (orphan attachment reaper), `disk.ts` (watermark probe + state), `index.ts` (compose).
- **D-02:** Factory `createSweeper({ core, repos, attachmentStore, config, logger, now? }) → { start(), stop(), runOnce() }` — DI style consistent with Core/SMTP/HTTP.
- **D-03:** `start()` schedules `setInterval(60_000, runExpireSweep)` + `setInterval(3_600_000, runOrphanReaper)` + `setInterval(30_000, updateDiskState)`. `stop()` clears all intervals and waits for any in-flight runs.
- **D-04:** Re-entrancy guard per sweep: a single boolean flag per interval; if still running, skip this tick (log once).

### Expiry Sweep (RETN-01, RETN-02)
- **D-05:** Query via new repo method `inboxRepo.listExpired(nowMs)`: returns `[{ id, ... }]` where `expires_at <= nowMs` OR `hard_expires_at <= nowMs`.
- **D-06:** For each expired inbox: call `core.expireInbox({ inboxId })` (already implemented in Phase 3). Core handles cascade + orphan-safe unlink. Sweeper just loops + aggregates counts.
- **D-07:** Log aggregate per tick: `{ tick_id, expired_count, deleted_messages, unlinked_blobs, duration_ms }`. No individual inbox IDs in logs (privacy).
- **D-08:** Idle-vs-hard semantics: `expires_at = last_activity_at + idleTtlMs`. On any inbox activity (incoming message, API access), updater bumps `expires_at`. `hard_expires_at = created_at + hardTtlMs` never moves. Default idleTtlMs=10min, hardTtlMs=1hr (per PROJECT.md).

### Orphan Reaper (RETN-03)
- **D-09:** Walk `/data/attachments/**` recursively, for each file extract sha256 from path, call `attachmentRepo.existsBySha(sha256)` — if false, `attachmentStore.unlinkBySha(sha256)`.
- **D-10:** Bounded: process at most 10k files per run to avoid blocking event loop; resume next hour if more. Track last-seen file in memory (not persisted — restart re-walks).
- **D-11:** Report aggregate: `{ scanned, orphaned, unlinked, duration_ms }`.

### Disk Watermark (RETN-04)
- **D-12:** Use `fs.statfs()` (Node 18.15+) or `statvfs` shim on the data volume path. Update every 30s.
- **D-13:** State published via a getter `sweeper.diskState() → { percentUsed, bytesFree, updatedAt, status: 'normal' | 'high' | 'critical' }`.
- **D-14:** At 80% (high): SMTP layer consults this getter via DI callback and responds 452 to new DATA. Hook: extend SMTP's `onData` to call `disk.isAcceptingMail()`; if false, end with `452 4.3.1 Insufficient system storage`.
- **D-15:** At 90% (critical): HTTP layer consults via DI callback; `POST /api/inbox` returns 503. Hook: extend `createHttpServer` deps to accept `diskState?: () => DiskState` and `createInbox` route checks it.
- **D-16:** Expose via `GET /healthz` — augment existing healthz to return `{ status: 'ok' | 'degraded', disk: { percent, status } }`. Never 5xx on healthz itself (circuit breaker reports, doesn't fail).

### Admin Blocklist Endpoint (ABUSE-02)
- **D-17:** New route `POST /admin/blocklist` in a new file `src/http/routes/admin.ts`. Registered ONLY when config supplies `adminSocketPath` (Unix domain socket) OR request comes from `127.0.0.1`/`::1`.
- **D-18:** Body: `{ address: "local@domain.tld" }` or `{ inboxId: "..." }`. Response `204` on success, `404` if address unknown.
- **D-19:** Action: mark inbox as expired-now (`core.expireInbox(id)` does full cleanup). Alternative: add `blocklisted_until INTEGER` column; deferred to v2.
- **D-20:** NO auth token — bind-based trust (loopback/unix socket only). Document in security.txt / README that exposing this to the internet is catastrophic.
- **D-21:** Logs emit `{ event: 'blocklist_applied', reason, by_ip, inbox_id_hash_first8 }` — never full address.

### Rate Limits (ABUSE-01)
- **D-22:** Verify Phase 5's @fastify/rate-limit config matches REQUIREMENTS.md thresholds. Add a dedicated test that spams an endpoint and asserts 429.
- **D-23:** Surface configured thresholds in a single `config.rateLimits` block — make it easy to tune post-launch via env overrides (document in Phase 8 runbook).

### Logging Invariants (ABUSE-03, ABUSE-04)
- **D-24:** Write a cross-layer invariant test `tests/invariants/no-pii-logs.test.ts` that:
  - Imports the project logger factory
  - Feeds synthetic PII-bearing events through SMTP + HTTP log helpers
  - Asserts no full address / subject / body bytes in output
- **D-25:** Write a cross-layer invariant test `tests/invariants/no-external-log-shipping.test.ts` that greps `src/**/*.ts` for known shipping SDKs (`datadog`, `sentry`, `logtail`, `loggly`, `papertrail`, etc.) — fails if any match.
- **D-26:** Logs rotate via `pino` file-target + systemd logrotate config (documented in Phase 8). No code change here beyond ensuring pino is configurable.

### Fail2Ban (ABUSE-05)
- **D-27:** `ops/fail2ban/filter.d/tempmail-smtp.conf` — matches SMTP log pattern for 550/452/5xx bursts. Ships a regex matching the Phase 4 smtpLog whitelist format.
- **D-28:** `ops/fail2ban/filter.d/tempmail-http.conf` — matches pino-http 429 pattern.
- **D-29:** `ops/fail2ban/jail.d/tempmail.conf` — jail definitions (findtime=10min, maxretry=20, bantime=1hr). Ships alongside docker-compose in Phase 8.
- **D-30:** No runtime code change — pure ops config. Tests: static content check that files exist with expected regexes.

### Testing
- **D-31:** Vitest + in-memory DB + real attachment tmpdir. Cover:
  - Sweeper ticks expire inboxes past idle TTL; honors hard TTL even if active
  - Re-entrancy guard prevents overlap
  - Orphan reaper deletes truly orphaned blobs, preserves referenced ones
  - Disk watermark transitions normal → high → critical; SMTP/HTTP callbacks respect
  - Admin endpoint works over loopback, rejects remote IP via local-IP check
  - Healthz reports disk state
  - Invariant tests pass (no-pii-logs, no-external-log-shipping)
- **D-32:** Integration test using real `setInterval` with fake timers (vitest's `useFakeTimers`).

### Claude's Discretion
- Whether sweeper runs as a standalone entry or is composed into a single "main" app that also hosts HTTP/SMTP (Phase 8 wires it; for now build it reusable)
- Exact `DiskState` shape beyond D-13
- Whether to use a dependency for statfs or `node:fs/promises.statfs`

</decisions>

<specifics>
## Specific Ideas

- D-20 "bind-based trust" for admin — the operational story is: access via `ssh user@vps` then `curl --unix-socket /var/run/tempmail-admin.sock ...`. Or, if unix socket skipped, just `curl -X POST http://127.0.0.1:<port>/admin/blocklist`. Unix socket preferred because it forces a filesystem permission step, harder to expose accidentally.
- D-14/D-15 callback-based disk checks avoid coupling sweeper to SMTP/HTTP — sweeper publishes state, consumers pull.
- The invariant tests (D-24, D-25) are cheap insurance — they catch regressions where someone adds `console.log(req.body)` or `import sentry` in a hurry.

</specifics>

<canonical_refs>
## Canonical References

### Roadmap and requirements
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md` §Retention, §Abuse (RETN-01..04, ABUSE-01..05)
- `.planning/ROADMAP.md` §Phase 6

### Research
- `.planning/research/ARCHITECTURE.md` §Expiry sweeper
- `.planning/research/PITFALLS.md` §Disk / inode (watermark motivation)
- `.planning/research/PITFALLS.md` §PII logs (whitelist enforcement)

### Prior phases (consume)
- `src/core/index.ts` — `expireInbox`, config types
- `src/db/repos/*` — `inboxRepo.listExpired` (may need adding), `attachmentRepo.existsBySha`
- `src/attachments/index.ts` — `unlinkBySha`, directory walking
- `src/http/server.ts` — extend deps with `diskState?` callback; add `routes/admin.ts`
- `src/smtp/index.ts` — extend deps with `isAcceptingMail?` callback

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable
- Phase 3 `core.expireInbox` — the orphan-safe full expiry already exists; sweeper just iterates
- Phase 2 `attachmentStore` + repos — everything needed for orphan detection
- Phase 4 `smtpLog` — PII-safe format already set
- Phase 5 `@fastify/rate-limit` — ABUSE-01 already implemented; verify + add test

### Gotchas
- `setInterval` in long-lived Node processes drifts if the event loop is saturated — acceptable here; 60s granularity
- Orphan walker can starve event loop if `/data/attachments` has millions of files — D-10 bounding
- Unix domain sockets on Windows: Node supports named pipes; prod target is Linux so document Linux path in config
- `fs.statfs` on Windows needs fallback (doesn't exist on all platforms; Node has it on win32 from 18.15+ but may return different fields) — code should degrade gracefully

</code_context>

<deferred>
## Deferred Ideas
- Persistent rate-limit store (redis) — not needed single-process
- Explicit blocklist table (`blocklisted_until`) — v2; current approach just hard-expires
- Metrics endpoint (`/metrics` in Prometheus format) — v2
- WebHook callback on abuse events for operator alerts — v2
</deferred>
