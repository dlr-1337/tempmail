/**
 * TLS options loader for the SMTP server.
 *
 * Production path (D-06): read `certPath` + `keyPath` from disk.
 * Dev path (D-07): generate a short-lived self-signed RSA cert in memory via
 * the `selfsigned` package and log a clear warning so operators cannot
 * mistake it for production readiness.
 *
 * Always enforces `minVersion: 'TLSv1.2'` per D-08.
 */

import { readFileSync } from 'node:fs';
import { generate as generateSelfSigned } from 'selfsigned';
import type { SmtpConfig } from './config.js';

export interface SmtpTlsMaterial {
  /** PEM-encoded private key. */
  key: string | Buffer;
  /** PEM-encoded certificate. */
  cert: string | Buffer;
  /** Always `'TLSv1.2'` for Phase 4 (D-08). */
  minVersion: 'TLSv1.2';
}

export interface TlsWarner {
  warn: (msg: string) => void;
}

/**
 * Build the TLS material to pass to smtp-server. Never throws for the dev
 * self-signed path; only throws if `certPath`/`keyPath` are set but unreadable
 * (programmer error — D-31).
 */
export async function loadTlsOptions(
  config: SmtpConfig,
  warner: TlsWarner,
): Promise<SmtpTlsMaterial> {
  const tls = config.tls;

  if (tls.certPath && tls.keyPath) {
    const cert = readFileSync(tls.certPath);
    const key = readFileSync(tls.keyPath);
    return { cert, key, minVersion: 'TLSv1.2' };
  }

  if (tls.devGenerateSelfSigned) {
    warner.warn(
      '[smtp] devGenerateSelfSigned is ENABLED — this is a dev-only path, never use it in production',
    );
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const pems = await generateSelfSigned([{ name: 'commonName', value: config.hostname }], {
      keySize: 2_048,
      algorithm: 'sha256',
      notBeforeDate: notBefore,
      notAfterDate: notAfter,
    });
    return { cert: pems.cert, key: pems.private, minVersion: 'TLSv1.2' };
  }

  // validateSmtpConfig should have caught this, but guard anyway.
  throw new Error('tls config missing: need {certPath,keyPath} or devGenerateSelfSigned');
}
