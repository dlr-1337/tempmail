---
phase: 06-sweeper-abuse
plan: 06-05
title: Admin blocklist endpoint (loopback-only) + fail2ban jail templates
depends_on: []
requirements:
  - ABUSE-02
  - ABUSE-05
decisions:
  - D-17
  - D-18
  - D-19
  - D-20
  - D-21
  - D-27
  - D-28
  - D-29
  - D-30
---

# Plan 06-05 — Admin endpoint + fail2ban

## Goal

Add `POST /admin/blocklist` for operator-initiated inbox expiry. Bind-based
trust: loopback-only. Ship fail2ban jail templates for SMTP + HTTP abuse.

## Must-have checklist

- [ ] `src/http/routes/admin.ts` registers `POST /admin/blocklist` and is
      only wired into the app when `config.admin?.enabled === true`
- [ ] Loopback-only guard: reject with 403 when `req.ip` is not `127.0.0.1`
      or `::1` (also accept `::ffff:127.0.0.1` IPv4-mapped)
- [ ] Body schema: `{ address: string } | { inboxId: string }` (one or
      the other — zod `.or` union). Reject missing both with 400.
- [ ] Success: call `core.expireInbox({ inboxId })`. Map `not_found` → 404.
      Otherwise 204 No Content.
- [ ] Logs event `blocklist_applied` with whitelisted fields
      `{ event, by_ip, inbox_id_hash_first8, reason: 'manual' }` — NEVER
      the raw address or inbox id
- [ ] Rate limit disabled on this route (admin is trusted)
- [ ] `ops/fail2ban/filter.d/tempmail-smtp.conf` — regex matching Phase 4
      smtpLog whitelist format for 550/452/5xx
- [ ] `ops/fail2ban/filter.d/tempmail-http.conf` — regex matching 429 lines
- [ ] `ops/fail2ban/jail.d/tempmail.conf` — jail definitions (findtime=10m,
      maxretry=20, bantime=1h)
- [ ] `tests/sweeper/admin-blocklist.test.ts` covers:
      - 204 when called via loopback with a valid inboxId
      - 404 when inbox doesn't exist
      - 400 when neither `address` nor `inboxId` provided
      - 403 when simulated non-loopback IP
      - 204 when called with `address` → core lookup resolves → expired
      - Log line contains only whitelisted fields
- [ ] `tests/sweeper/fail2ban-files.test.ts` asserts the three files exist
      and contain expected regex anchors (`failregex`, `logpath` or `journalmatch` placeholder)

## Tasks

### 06-05-01 Admin route file `<automated>`

Create `src/http/routes/admin.ts`:
- `registerAdminRoutes(app, { core, config })`
- Zod body: `z.object({ address: z.string().min(3).optional(), inboxId: z.string().min(1).optional() }).refine(v => v.address || v.inboxId)`
- Resolve address → `core.findInboxByAddress(local, domain)` → `inboxId`
- Call `core.expireInbox({ inboxId })`; 404 on `not_found`
- Loopback check via a `preHandler` hook; use `req.ip`
- Hash inbox id with sha256 + salt from `config.admin.logSalt` (reuse
  `hashLocalPart` pattern or inline) — take first 16 hex chars.

Conventional commit: `feat(http): add POST /admin/blocklist loopback-only route`

### 06-05-02 Wire admin route + config `<automated>`

Update `src/http/server.ts`:
- `HttpServerConfig` gains `admin?: { enabled: boolean; logSalt?: string }`.
- When enabled, `await registerAdminRoutes(app, { core: deps.core, config: deps.config.admin })`.

Conventional commit: `feat(http): register admin routes when config.admin.enabled`

### 06-05-03 Fail2ban templates `<automated>`

Create three files under `ops/fail2ban/`:
- `filter.d/tempmail-smtp.conf` — `[Definition]` + `failregex` matching
  JSON log lines emitted by `smtpLog.rcptRejected` / `dataRejected` /
  `rateLimited` (match on `"sender_ip":"<HOST>"` and `"smtp_code":(452|550|554)`).
- `filter.d/tempmail-http.conf` — match pino-http 429 lines with
  `"statusCode":429` and `"remoteAddress":"<HOST>"`.
- `jail.d/tempmail.conf` — two jails: `tempmail-smtp` / `tempmail-http`,
  bantime=3600, findtime=600, maxretry=20, backend=auto.

Conventional commit: `ops(fail2ban): add SMTP + HTTP jail and filter templates`

### 06-05-04 Tests `<automated>`

`tests/sweeper/admin-blocklist.test.ts`:
- Use `buildTestRig({ config: { admin: { enabled: true, logSalt: 's' }}})` then
  `app.inject()` to exercise loopback (default `req.ip` in inject = '127.0.0.1').
- Simulate non-loopback by setting `remoteAddress` on inject or
  `X-Forwarded-For` + disabling trustProxy.

`tests/sweeper/fail2ban-files.test.ts`:
- `readFileSync` each file, assert it contains `[Definition]`/`[DEFAULT]` +
  `failregex` / `bantime` keywords.

Conventional commit: `test(sweeper): cover admin blocklist and fail2ban templates`

## Verification

- Admin tests pass
- Fail2ban file tests pass
- `npm run typecheck` / `npm run check` clean
