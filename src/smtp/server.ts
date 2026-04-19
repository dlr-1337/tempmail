/**
 * `createSmtpServer(deps)` — the Phase 4 factory.
 *
 * Wires an `smtp-server` instance with:
 *   - AUTH disabled (D-09/D-10/D-11)
 *   - 10 MiB size cap (D-12)
 *   - STARTTLS via `loadTlsOptions` (D-06/D-07/D-08)
 *   - Explicit socketTimeout / closeTimeout (D-24)
 *   - onRcptTo → Core lookup + rate-limit (D-14/D-15, D-21)
 *   - onData → streaming parse + sanitize + ingestMessage (D-16/D-17/D-18)
 *   - PII-safe logging throughout (D-26..D-29)
 *
 * Deps are injected — no global state. The returned handle exposes `listen`,
 * `close`, and `address` for the integration harness and Phase 8 composition.
 */

import type { AddressInfo } from 'node:net';
import {
  type SMTPResponseError,
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerDataStream,
  type SMTPServerOptions,
  type SMTPServerSession,
} from 'smtp-server';

import type { AttachmentStore } from '../attachments/index.js';
import type { CoreApi } from '../core/index.js';
import type { AbuseRepo } from '../db/repos/index.js';
import { nowMs } from '../util/now.js';
import { type SmtpConfig, validateSmtpConfig } from './config.js';
import { buildOnData } from './data.js';
import { type SmtpLogger, type SmtpPinoLike, createSmtpLogger } from './log.js';
import { type RateLimiter, createRateLimiter, ipPrefix } from './rate-limit.js';
import { buildOnRcptTo } from './recipient.js';
import { type HtmlSanitizer, createHtmlSanitizer } from './sanitizer.js';
import { type TlsWarner, loadTlsOptions } from './tls.js';

export interface SmtpServerDeps {
  core: CoreApi;
  attachmentStore: AttachmentStore;
  /** AbuseRepo is injected directly so the SMTP adapter can increment `smtp_452`
   *  counters (D-23) without forcing a new Core method purely for observability. */
  abuseRepo: AbuseRepo;
  config: SmtpConfig;
  /** Already-configured pino-compatible logger. */
  logger: SmtpPinoLike;
  /** Injectable clock for determinism in tests. Defaults to `nowMs`. */
  now?: () => number;
}

export interface SmtpServerHandle {
  /** Start listening. Resolves when the underlying `net.Server` emits 'listening'.
   *  Returns the assigned port (useful when `config.port === 0`). */
  listen(): Promise<number>;
  /** Graceful shutdown — waits for in-flight connections up to `closeTimeout`. */
  close(): Promise<void>;
  /** Current bound address, or null before `listen` resolves. */
  address(): AddressInfo | null;
  /** Advanced: direct access to smtp-server for integration tests that need
   *  to inspect `options.socketTimeout` etc. Do not use in production code. */
  readonly raw: SMTPServer;
  readonly rateLimiter: RateLimiter;
  readonly sanitizer: HtmlSanitizer;
  readonly smtpLog: SmtpLogger;
}

export async function createSmtpServer(deps: SmtpServerDeps): Promise<SmtpServerHandle> {
  const config = validateSmtpConfig(deps.config);
  const now = deps.now ?? nowMs;

  const warner: TlsWarner = {
    warn: (msg) => deps.logger.warn({ warning: msg }, 'smtp.tls.warning'),
  };
  const tlsMaterial = await loadTlsOptions(config, warner);

  const rateLimiter = createRateLimiter({ config: config.rateLimit, now });
  const sanitizer = createHtmlSanitizer();
  const smtpLog = createSmtpLogger({ pino: deps.logger, salt: config.piiLogSalt, now });

  const onRcptTo = buildOnRcptTo({
    core: deps.core,
    config,
    rateLimiter,
    abuseRepo: deps.abuseRepo,
    smtpLog,
    now,
  });

  const onData = buildOnData({
    core: deps.core,
    attachmentStore: deps.attachmentStore,
    sanitizer,
    smtpLog,
    now,
  });

  const options: SMTPServerOptions = {
    banner: 'tempmail SMTP',
    size: config.maxMessageBytes,
    authOptional: true,
    disabledCommands: ['AUTH'],
    hideSTARTTLS: false,
    secure: false,
    needsUpgrade: false,
    socketTimeout: config.timeouts.socketMs,
    closeTimeout: config.timeouts.closeMs,
    key: tlsMaterial.key,
    cert: tlsMaterial.cert,
    minVersion: tlsMaterial.minVersion,
    logger: false,
    onConnect(session, cb) {
      smtpLog.connectionStart({
        remoteIp: session.remoteAddress,
        startedAtMs: now(),
      });
      cb();
    },
    onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, cb) {
      onRcptTo(address, session, cb);
    },
    onData(stream: SMTPServerDataStream, session: SMTPServerSession, cb) {
      onData(stream, session, cb);
    },
  };

  const raw = new SMTPServer(options);

  // Quiet the default EventEmitter 'error' behavior — smtp-server emits on the
  // SMTPServer itself for socket errors. We log and swallow (do not crash).
  raw.on('error', (...args: unknown[]) => {
    const err = args[0];
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && 'responseCode' in err
        ? ((err as SMTPResponseError).responseCode ?? null)
        : null;
    deps.logger.error({ error: message, code }, 'smtp.server.error');
  });

  const handle: SmtpServerHandle = {
    raw,
    rateLimiter,
    sanitizer,
    smtpLog,
    address() {
      const addr = raw.server.address();
      if (addr && typeof addr === 'object') return addr;
      return null;
    },
    listen() {
      return new Promise<number>((resolve, reject) => {
        const onListenError = (err: Error): void => {
          raw.server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          raw.server.off('error', onListenError);
          const addr = raw.server.address();
          if (addr && typeof addr === 'object') resolve(addr.port);
          else resolve(config.port);
        };
        raw.server.once('error', onListenError);
        raw.server.once('listening', onListening);
        raw.listen(config.port, config.hostname);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        raw.close(() => resolve());
      });
    },
  };

  return handle;
}

/** Re-export the helper for external use (tests, diagnostics). */
export { ipPrefix };
