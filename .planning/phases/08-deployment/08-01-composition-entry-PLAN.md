---
phase: 08
plan: 08-01
title: Composition entry (src/main.ts + src/config.ts)
covers: DEPLOY-01, D-15, D-16, D-04, D-05
---

# Goal

Add `src/config.ts` (zod env schema) and `src/main.ts` (factory composition root) so the container / systemd unit has a single entry point: `node --enable-source-maps dist/main.js`.

## Must-have checklist

- [ ] `src/config.ts` validates env vars with zod, fails fast with clear message
- [ ] `src/main.ts` composes openDb, createRepos, createAttachmentStore, createCore, createSweeper, createSmtpServer, createHttpServer
- [ ] wires `isAcceptingMail` (SMTP) and `diskState` (HTTP) from sweeper
- [ ] SIGTERM / SIGINT handlers: smtp.close → http.close → sweeper.stop → db.close, with 30s force-exit timer
- [ ] Structured startup log `{event:'startup', node, domain, db, data_dir, smtp_port, http_port}`
- [ ] Tests: `tests/config/env.test.ts` — valid/invalid shapes, defaults, PII_LOG_SALT length check
- [ ] `npm test` remains 238+ passing
- [ ] `npm run typecheck` 0 errors
- [ ] `npm run check` clean

## Tasks

1. Create `src/config.ts` with zod schema: DOMAIN, PII_LOG_SALT, SMTP_PORT, SMTP_HOST, HTTP_PORT, HTTP_HOST, COOKIE_SECRET, IDLE_TTL_MS, HARD_TTL_MS, DB_PATH, ATTACHMENTS_DIR, TLS_CERT_PATH, TLS_KEY_PATH, TLS_DEV_SELF_SIGNED, ADMIN_ENABLED, NODE_ENV.
2. Create `src/main.ts` composition root per D-15.
3. Add `tests/config/env.test.ts`.
4. Package.json: verify `build` + `start` scripts point at `dist/main.js`.

<automated>
npm run typecheck
npm run check
npm test
</automated>

## Commit

`feat(08-01): add config schema + main.ts composition root`
