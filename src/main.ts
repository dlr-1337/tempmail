/**
 * Production composition root (Phase 8 D-04 / D-15).
 *
 * Launched by Docker / systemd as `node --enable-source-maps dist/main.js`.
 *
 * Responsibilities:
 *   1. Load + validate env via `loadAppConfig`. Fail fast with a human-readable
 *      error list on misconfiguration.
 *   2. Open the SQLite DB (migrations auto-apply).
 *   3. Construct repos, attachment store, core, sweeper.
 *   4. Wire disk-state circuit-breakers into SMTP (`isAcceptingMail`) and HTTP
 *      (`diskState` for 503 + /healthz).
 *   5. Start listeners: SMTP, HTTP, sweeper intervals.
 *   6. Install SIGTERM / SIGINT handlers that close every resource in reverse
 *      order with a 30s grace window, then `process.exit(0)`.
 *   7. Emit a structured startup log so operators see boot success in logs.
 *
 * No tests cover this file directly (it's the process entrypoint). Components
 * it composes are exhaustively tested elsewhere. A tiny integration test
 * (`tests/config/env.test.ts`) covers the env-schema behavior in isolation.
 */

import process from 'node:process';
import pino, { type Logger } from 'pino';
import { z } from 'zod';

import { createAttachmentStore } from './attachments/index.js';
import { type AppConfig, formatEnvErrors, loadAppConfig } from './config.js';
import { createCore } from './core/index.js';
import { type Db, openDb } from './db/client.js';
import { createRepos } from './db/repos/index.js';
import { createHttpServer } from './http/server.js';
import { type SmtpServerHandle, createSmtpServer } from './smtp/index.js';
import { type SweeperHandle, createSweeper, isAcceptingMail } from './sweeper/index.js';

/** Force-exit after this many ms even if resources are slow to release. */
const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Main entrypoint. Returns a handle only so the integration harness and any
 * future embedded host (tests, electron) can reach the internals; the CLI path
 * ignores the return value.
 */
export async function main(): Promise<void> {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'tempmail' },
  });

  let config: AppConfig;
  try {
    config = loadAppConfig(process.env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Write to stderr directly — logger isn't trustworthy at this point
      // (we might be mid-init). Also give the operator a copy-pasteable list.
      process.stderr.write('Invalid environment configuration:\n');
      for (const line of formatEnvErrors(err)) {
        process.stderr.write(`  - ${line}\n`);
      }
      process.stderr.write('See .env.example for the full variable list.\n');
      process.exit(1);
    }
    throw err;
  }

  // ---------------- Storage layer ----------------
  const db: Db = openDb(config.dbPath);
  const repos = createRepos(db);
  const attachmentStore = createAttachmentStore(config.attachmentsDir);

  // ---------------- Core ----------------
  const core = createCore({
    db,
    repos,
    attachmentStore,
    config: {
      domain: config.domain,
      idleTtlMs: config.retention.idleTtlMs,
      hardTtlMs: config.retention.hardTtlMs,
    },
  });

  // ---------------- Sweeper ----------------
  const sweeper: SweeperHandle = createSweeper({
    core,
    repos,
    attachmentStore,
    logger,
  });

  // ---------------- SMTP ----------------
  const smtp: SmtpServerHandle = await createSmtpServer({
    core,
    attachmentStore,
    abuseRepo: repos.abuse,
    logger,
    config: {
      port: config.smtp.port,
      hostname: config.smtp.host,
      domain: config.domain,
      maxMessageBytes: config.smtp.maxMessageBytes,
      tls: {
        certPath: config.smtp.tlsCertPath,
        keyPath: config.smtp.tlsKeyPath,
        devGenerateSelfSigned: config.smtp.tlsDevSelfSigned,
      },
      rateLimit: {
        tokensPerMinute: config.smtp.tokensPerMinute,
        burst: config.smtp.burst,
      },
      timeouts: {
        socketMs: config.smtp.socketTimeoutMs,
        closeMs: config.smtp.closeTimeoutMs,
      },
      piiLogSalt: config.smtp.piiLogSalt,
    },
    isAcceptingMail: () => isAcceptingMail(sweeper.diskState()),
  });

  // ---------------- HTTP ----------------
  const http = await createHttpServer({
    core,
    attachmentStore,
    logger,
    config: {
      cookieSecret: config.http.cookieSecret,
      hardTtlMs: config.retention.hardTtlMs,
      trustProxy: true,
      admin: config.http.adminEnabled
        ? { enabled: true, logSalt: config.smtp.piiLogSalt }
        : undefined,
    },
    diskState: () => sweeper.diskState(),
  });

  // ---------------- Listen ----------------
  const smtpPort = await smtp.listen();
  await http.listen({ port: config.http.port, host: config.http.host });
  sweeper.start();

  logger.info(
    {
      event: 'startup',
      node: process.version,
      pid: process.pid,
      domain: config.domain,
      db: config.dbPath,
      data_dir: config.dataDir,
      attachments_dir: config.attachmentsDir,
      smtp_port: smtpPort,
      http_port: config.http.port,
      http_host: config.http.host,
      admin_enabled: config.http.adminEnabled,
      tls_dev_self_signed: config.smtp.tlsDevSelfSigned,
    },
    'tempmail.started',
  );

  // ---------------- Shutdown ----------------
  installShutdown({ logger, smtp, http, sweeper, db });
}

interface ShutdownDeps {
  logger: Logger;
  smtp: SmtpServerHandle;
  http: Awaited<ReturnType<typeof createHttpServer>>;
  sweeper: SweeperHandle;
  db: Db;
}

function installShutdown(deps: ShutdownDeps): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ event: 'shutdown.begin', signal }, 'tempmail.shutdown');

    // Hard deadline — if graceful close hangs (TLS handshake stuck, slow client
    // refusing to drain), we still exit so the orchestrator can restart us.
    const killer = setTimeout(() => {
      deps.logger.error({ event: 'shutdown.forced' }, 'tempmail.shutdown.forced');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    killer.unref?.();

    graceful(deps)
      .then(() => {
        deps.logger.info({ event: 'shutdown.done' }, 'tempmail.shutdown.done');
        clearTimeout(killer);
        process.exit(0);
      })
      .catch((err) => {
        deps.logger.error(
          { event: 'shutdown.error', err: err instanceof Error ? err.message : String(err) },
          'tempmail.shutdown.error',
        );
        clearTimeout(killer);
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function graceful(deps: ShutdownDeps): Promise<void> {
  // Stop accepting new connections FIRST.
  await Promise.allSettled([deps.smtp.close(), deps.http.close()]);
  // Then stop scheduled work (sweeper awaits in-flight ticks internally).
  await deps.sweeper.stop();
  // DB last — something may still want to record a final event.
  try {
    deps.db.close();
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'tempmail.shutdown.db_close_warn',
    );
  }
}

// Process-level safety nets. These should never fire — if they do, we log and
// exit so the orchestrator restarts us (fail fast, recover via supervision).
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  process.exit(1);
});

// ESM "main module" check. When imported by a test / tool, we don't auto-run.
const entry = process.argv[1];
if (entry && import.meta.url === new URL(`file://${entry.replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    console.error('tempmail.startup.failed', err);
    process.exit(1);
  });
}
