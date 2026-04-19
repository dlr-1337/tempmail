/**
 * Strict `SmtpConfig` shape and validator per Phase 4 CONTEXT D-30 / D-31.
 *
 * Config is validated at `createSmtpServer` entry. Missing/invalid fields throw
 * a programmer-error (Phase 3 D-20 philosophy) — this is not a business error
 * surface, it's a boot-time misconfiguration.
 */

export interface SmtpTlsConfig {
  /** Absolute path to PEM cert file. Required unless `devGenerateSelfSigned`. */
  certPath?: string;
  /** Absolute path to PEM key file. Required unless `devGenerateSelfSigned`. */
  keyPath?: string;
  /** Dev-only: generate an in-memory self-signed cert at startup. Never use
   *  in production — log a clear warning when enabled. */
  devGenerateSelfSigned?: boolean;
}

export interface SmtpRateLimitConfig {
  /** Token refill rate per IP prefix per minute (D-21 default: 10). */
  tokensPerMinute: number;
  /** Max burst (bucket capacity). D-21 default: 20. */
  burst: number;
}

export interface SmtpTimeoutsConfig {
  /** Idle-socket timeout in ms (D-24 default: 60_000). */
  socketMs: number;
  /** Grace period on .close() in ms (D-24 default: 30_000). */
  closeMs: number;
}

export interface SmtpConfig {
  /** Listen port (25 prod, 2525 dev). */
  port: number;
  /** Bind hostname. `0.0.0.0` or `::` for all interfaces; `127.0.0.1` for
   *  loopback-only tests. */
  hostname: string;
  /** Single domain we accept mail for (e.g. `tempmail.local`). */
  domain: string;
  /** Per-message size cap in bytes (D-12: 10 * 1024 * 1024). */
  maxMessageBytes: number;
  tls: SmtpTlsConfig;
  rateLimit: SmtpRateLimitConfig;
  timeouts: SmtpTimeoutsConfig;
  /** Salt for the `local_part_hash_first8` log field (D-27). Rotated per deploy. */
  piiLogSalt: string;
}

/**
 * Defensive validator. Throws Error with a clear message pointing at the
 * offending field. Returns the same object (identity passthrough) so callers
 * can write `const cfg = validateSmtpConfig(raw);`.
 */
export function validateSmtpConfig(config: SmtpConfig): SmtpConfig {
  const errors: string[] = [];

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    // Port 0 is valid — "pick any ephemeral" — useful for integration tests
    // and for dev setups where a non-conflicting port is desired.
    errors.push(`port must be an integer in [0, 65535], got ${String(config.port)}`);
  }
  if (typeof config.hostname !== 'string' || config.hostname.length === 0) {
    errors.push('hostname must be a non-empty string');
  }
  if (
    typeof config.domain !== 'string' ||
    config.domain.length === 0 ||
    config.domain.includes('@')
  ) {
    errors.push('domain must be a non-empty string without `@`');
  }
  if (
    !Number.isInteger(config.maxMessageBytes) ||
    config.maxMessageBytes < 1_024 ||
    config.maxMessageBytes > 1_000_000_000
  ) {
    errors.push('maxMessageBytes must be an integer in [1024, 1_000_000_000]');
  }

  const tls = config.tls;
  if (!tls) {
    errors.push('tls block is required');
  } else {
    const hasPaths = Boolean(tls.certPath) && Boolean(tls.keyPath);
    if (!hasPaths && !tls.devGenerateSelfSigned) {
      errors.push('tls requires either {certPath, keyPath} or devGenerateSelfSigned:true (D-07)');
    }
  }

  const rl = config.rateLimit;
  if (!rl || rl.tokensPerMinute <= 0 || rl.burst <= 0) {
    errors.push('rateLimit.tokensPerMinute and rateLimit.burst must be positive');
  }

  const to = config.timeouts;
  if (!to || to.socketMs < 1_000 || to.closeMs < 1_000) {
    errors.push('timeouts.socketMs and timeouts.closeMs must be >= 1000');
  }

  if (typeof config.piiLogSalt !== 'string' || config.piiLogSalt.length < 8) {
    errors.push('piiLogSalt must be a string of length >= 8');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid SmtpConfig: ${errors.join('; ')}`);
  }

  return config;
}
