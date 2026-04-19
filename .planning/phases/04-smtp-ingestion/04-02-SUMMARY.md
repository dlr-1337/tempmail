# Plan 04-02 Summary — Server bind, TLS, config

## Delivered
- `src/smtp/config.ts` — `SmtpConfig` shape (D-30) + `validateSmtpConfig`
  (D-31) that throws on invalid fields at factory entry.
- `src/smtp/tls.ts` — `loadTlsOptions(config, warner)` returns TLS material.
  Production path reads `certPath`/`keyPath`; dev path uses the `selfsigned`
  package to mint a 24h cert and logs a warning (D-06, D-07, D-08).
- `src/smtp/session.ts` — `readSession(session, now)` builds a narrow view
  containing the sessionId, remoteAddress, `/24`-or-`/64` prefix, and
  wall-clock start.
- `src/smtp/server.ts` — `createSmtpServer(deps) → Promise<SmtpServerHandle>`.
  Wires smtp-server with `authOptional`, `disabledCommands: ['AUTH']`,
  `size: config.maxMessageBytes`, explicit `socketTimeout`/`closeTimeout`,
  `hideSTARTTLS: false`, `minVersion: 'TLSv1.2'`. `listen()` resolves with the
  actual port (supports ephemeral port 0). `close()` is graceful.
- `src/smtp/index.ts` — public barrel exporting the factory, config types,
  logger types, rate-limiter, and the `ipPrefix` helper.

## Notes
- Factory became `async` to accommodate selfsigned v5's async API. Prod
  path (`certPath`/`keyPath`) is synchronous underneath but the factory's
  signature is uniformly `Promise<SmtpServerHandle>` for a single call site.
- Biome rewrote several imports to alphabetical order — harmless, accepted.

## Verification
- Typecheck + lint clean.
- `tests/smtp/server-bind.test.ts` exercises the factory end-to-end (binds,
  banner, EHLO capabilities, socket/close timeout options).

## Commit
`feat(04-smtp): add SMTP ingestion layer (server, TLS, parser, sanitizer,
rate-limit, logs) and integration tests` (consolidated with plans 04-03..05).
