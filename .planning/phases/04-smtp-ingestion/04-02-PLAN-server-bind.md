---
phase: 4
plan: 2
status: ready
type: execute
wave: 2
depends_on: [1]
requirements: [SMTP-01, SMTP-02, SMTP-03, SMTP-06, SMTP-08]
files_modified:
  - src/smtp/config.ts
  - src/smtp/server.ts
  - src/smtp/session.ts
  - src/smtp/tls.ts
  - src/smtp/index.ts
autonomous: true
tags: [smtp, server, tls, config]
---

## Goal

Construct the `createSmtpServer(deps)` factory. It wires an `smtp-server` instance with:
- AUTH disabled (D-09/D-10/D-11)
- `size: 10 MiB` (SMTP-03, D-12)
- STARTTLS with `minVersion: 'TLSv1.2'`; if `tlsCert`/`tlsKey` are provided, use them; else in dev mode generate a self-signed cert at startup (D-07, D-08) and log a warning.
- Explicit `socketTimeout` and `closeTimeout` from config (D-24, SMTP-08)
- `authOptional: true`, `disabledCommands: ['AUTH']`
- `hideSTARTTLS: false` (i.e. advertise)
- Handler stubs for `onRcptTo`/`onData` that will be filled in by plan 04-03 and 04-04 via DI.

Config + factory shape defined here; handlers receive the factory's internal state and the injected deps.

## Must-have checklist (requirement IDs)

- SMTP-01: server binds on configurable port via `listen(port, hostname?)` returning the underlying `net.Server`
- SMTP-02: AUTH is in `disabledCommands`, `authOptional: true`
- SMTP-03: `size: config.maxMessageBytes`
- SMTP-06: `hideSTARTTLS: false`, `secure: false`, `needsUpgrade: false`, TLS cert/key loaded if provided; dev self-signed fallback when `devGenerateSelfSigned === true`
- SMTP-08: `socketTimeout` and `closeTimeout` explicitly set from config (not left defaults)
- Config validation at entry (D-31): missing required fields throw a clear programmer-error

## Tasks

1. Write `src/smtp/config.ts` — zod-less plain-TS validator + the `SmtpConfig` interface (D-30).
2. Write `src/smtp/tls.ts` — `loadTlsOptions(config, logger) → { key, cert, minVersion }`; uses `node:fs.readFileSync` for provided paths, falls back to a one-shot self-signed cert via `node:crypto.generateKeyPairSync`+`X509Certificate` (dev only).
3. Write `src/smtp/session.ts` — a lightweight interface for per-connection state (sender IP + prefix + start time) extracted from the smtp-server `session` object.
4. Write `src/smtp/server.ts` — the factory. Exposes `{ listen, close, address }`. Handlers delegate to placeholders wired in plans 04-03 and 04-04.
5. Write `src/smtp/index.ts` — barrel: `createSmtpServer`, `SmtpConfig`, `SmtpServer`, `SmtpDeps`.
6. `<automated>` verify: `npm run typecheck` and `npm run check` both exit 0.

Commits (one per feature, atomic):
- `feat(04-smtp): add SmtpConfig with strict validation`
- `feat(04-smtp): add TLS options loader with dev self-signed fallback`
- `feat(04-smtp): add session adapter and createSmtpServer factory`

## Verification

- Import `createSmtpServer` in a throwaway ts-node probe returns `{ listen, close }` when given well-formed deps.
- `npm run typecheck && npm run check` both exit 0.
