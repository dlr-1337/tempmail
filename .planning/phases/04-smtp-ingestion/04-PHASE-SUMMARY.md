# Phase 4: SMTP Ingestion — Complete

**Completed:** 2026-04-19
**Requirements covered:** SMTP-01..09 (all 9)
**Tests:** 170 total project-wide (100 baseline + ~35 HTTP by parallel Phase 5
+ ~35 added here)

## What the SMTP layer exposes

Public barrel at `src/smtp/index.ts`:

```ts
createSmtpServer(deps: SmtpServerDeps) => Promise<SmtpServerHandle>

interface SmtpServerDeps {
  core: CoreApi;                  // Phase 3
  attachmentStore: AttachmentStore; // Phase 2
  abuseRepo: AbuseRepo;           // Phase 2 — for SMTP-452 counters (D-23)
  config: SmtpConfig;
  logger: SmtpPinoLike;           // pino-compatible
  now?: () => number;
}

interface SmtpServerHandle {
  listen(): Promise<number>;    // returns actual bound port (supports 0)
  close(): Promise<void>;       // graceful shutdown
  address(): AddressInfo | null;
  readonly raw: SMTPServer;
  readonly rateLimiter: RateLimiter;
  readonly sanitizer: HtmlSanitizer;
  readonly smtpLog: SmtpLogger;
}
```

Also exported: `SmtpConfig`, `validateSmtpConfig`, `createHtmlSanitizer`,
`createRateLimiter`, `ipPrefix`, `createSmtpLogger`, `hashLocalPart`.

## API surface for Phase 6/8

Phase 6 (retention + disk breaker) and Phase 8 (composition / deployment)
consume only the factory. Typical boot:

```ts
const smtp = await createSmtpServer({ core, attachmentStore, abuseRepo, config, logger });
await smtp.listen();
// ... later
await smtp.close();
```

## Requirement → test mapping

| Req     | Test file(s)                                            |
|---------|---------------------------------------------------------|
| SMTP-01 | `tests/smtp/server-bind.test.ts`                        |
| SMTP-02 | `tests/smtp/server-bind.test.ts`                        |
| SMTP-03 | `tests/smtp/server-bind.test.ts`, `data.test.ts`        |
| SMTP-04 | `tests/smtp/rcpt.test.ts`                               |
| SMTP-05 | `tests/smtp/data.test.ts`                               |
| SMTP-06 | `tests/smtp/server-bind.test.ts`                        |
| SMTP-07 | `tests/smtp/rate-limit.test.ts`, `rate-limit-integration.test.ts` |
| SMTP-08 | `tests/smtp/server-bind.test.ts`                        |
| SMTP-09 | `tests/smtp/log.test.ts`, `tests/smtp/pii-logs.test.ts` |

Plus `tests/smtp/invariants.test.ts` enforcing:
- `src/smtp/**/*.ts` never imports `better-sqlite3` (D-03)
- Only `src/smtp/log.ts` imports `pino` (D-29)

## Notable deviations from CONTEXT

1. **TLS: swapped hand-rolled ASN.1 for `selfsigned` package.**
   CONTEXT.md left the cert-generation implementation to Claude's discretion.
   We initially hand-rolled the X.509 DER encoding inside `src/smtp/tls.ts`,
   but the bit-level serial-number encoding proved fragile under
   X509Certificate's validator. Switched to the 5 KB `selfsigned` package
   (pure JS, no native deps, async API in v5). Net effect:
   `createSmtpServer` is now `async` — downstream callers `await` it.

2. **`abuseRepo` injected directly into `createSmtpServer` deps, not via Core.**
   D-23 wanted abuse-counter increments on 452 trips. Rather than extend
   Core with a `recordAbuse` method (Phase 5's parallel agent did add one
   for their needs), the SMTP factory accepts `AbuseRepo` directly. This
   keeps Core's surface narrow and matches our "Core is for protocol-
   agnostic business ops; observability hooks are adapter-local" pattern.

3. **DOMPurify policy augmented with a custom hook.**
   `ALLOWED_URI_REGEXP` alone doesn't block `data:` URIs in `img src`
   because DOMPurify special-cases that MIME family. Added a
   `uponSanitizeAttribute` hook that rejects `data:`, `javascript:`,
   and `vbscript:` values on src/href/action attributes. Tests
   (`sanitizer.test.ts`) confirm every D-18 clause.

4. **Port 0 is permitted by `validateSmtpConfig`.**
   Integration tests bind on ephemeral ports; Node treats port 0 as
   "pick any free port". The validator allows `[0, 65535]` and the
   factory's `listen()` resolves with the assigned port after
   `listening`.

5. **mailparser still buffers individual attachment bodies.**
   CONTEXT.md's D-17 bans buffering the whole message. Mailparser's
   `simpleParser(stream)` streams the DATA body but buffers each MIME
   part's decoded bytes before emitting `attachments[i].content`. That's
   upstream design and is bounded by `size: 10 MiB` at the server level.
   Acceptable per CONTEXT.md gotchas section.

## Open items for Phase 8

- **TLS cert paths** (`SmtpConfig.tls.certPath` / `keyPath`) must be provided
  by the Phase 8 composition root in production. Dev uses
  `devGenerateSelfSigned: true`; production must refuse this flag or log a
  red warning banner at boot.
- **Privileged port 25** requires `CAP_NET_BIND_SERVICE` on Linux or running
  as root. Recommend systemd unit with
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` (Phase 8 will write this).
  Windows dev environments should set `port: 2525` in local config.
- **`piiLogSalt` rotation** — CONTEXT D-27 says a new salt per deploy. Phase
  8 should wire this from an environment variable (e.g. `PII_LOG_SALT`)
  that CI re-generates on each deployment.
- **Phase 6 disk circuit breaker**: the `onData` handler currently accepts
  whatever Core accepts. Phase 6 will inject a pre-DATA check that returns
  452 when `/data` disk usage crosses the 80% threshold, per RETN-03.
- **`swaks` integration smoke test** (D-33) was NOT added — skipped because
  `swaks` is not guaranteed on the CI runner. The integration tests using
  our bespoke text client provide equivalent coverage without the external
  binary dependency.

## Files owned by Phase 4
- `src/smtp/*.ts` (14 files)
- `tests/smtp/*.ts` + `tests/smtp/support/*.ts` (11 files)
- `tests/core/find-inbox-by-address.test.ts`

## Core extensions (scope exception per D-15)
- `src/core/inboxes.ts` — added `findInboxByAddress` + `InboxAddressView`.
- `src/core/index.ts` — re-exported the above on `CoreApi`.
- No other files outside `src/smtp/*` / `tests/smtp/*` touched by this phase.

## Gate status
- `npm run typecheck` — 0
- `npm run check` — 0
- `npm test` — 170 passing, 0 failing
- `grep better-sqlite3 src/smtp/*` — no hits
- `grep "from 'pino'" src/smtp/*` — no hits outside `log.ts` (doc reference only)
