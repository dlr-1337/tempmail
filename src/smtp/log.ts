/**
 * PII-safe SMTP log helper (D-26, D-27, D-28, D-29).
 *
 * This module is the ONLY place in `src/smtp/*` that calls a raw pino logger.
 * Every log emission goes through one of the named methods below, each of
 * which accepts only a typed, whitelisted payload. No free-form log calls.
 *
 * Whitelist (D-26): `timestamp, sender_ip, sender_ip_prefix, sender_domain,
 * message_size, smtp_code, duration_ms, local_part_hash_first8`.
 *
 * An invariant test in `tests/smtp/invariants.test.ts` greps the `src/smtp/`
 * tree for `from 'pino'` (or `"pino"`) imports outside this file and fails
 * the build if any are found.
 */

import { createHash } from 'node:crypto';
import { ipPrefix } from './rate-limit.js';

/**
 * Minimal pino-shaped interface — narrowed to the two-arg overload we actually
 * call. Intentionally accepts `object` (not `Record<string, unknown>`) so
 * nominal interfaces like `SmtpLogFields` are assignable without an
 * index-signature escape hatch.
 */
export interface SmtpPinoLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
}

export interface SmtpLoggerDeps {
  /** Already-configured pino-compatible logger. */
  pino: SmtpPinoLike;
  /** Salt used to hash recipient local-parts before logging (D-27). */
  salt: string;
  /** Injectable clock for `timestamp` field. */
  now: () => number;
}

/**
 * Fields that are ALLOWED to appear in an SMTP log event (D-26).
 * `local_part_hash_first8` is only present when a recipient was validated.
 */
export interface SmtpLogFields {
  /** Epoch ms of the event. */
  timestamp: number;
  /** Raw sender IP — NOT a forbidden PII field per D-26 (operator debugging
   *  needs it; it's also present at the transport layer). Paired with
   *  `sender_ip_prefix` for rate-limit correlation. */
  sender_ip: string;
  /** Normalized `/24` or `/64` prefix. Safer for long-term retention. */
  sender_ip_prefix: string;
  /** Sender address domain (right-of-`@`) — not a recipient, not PII-critical. */
  sender_domain: string | null;
  /** DATA byte count if known. */
  message_size: number | null;
  /** SMTP response code (220, 250, 452, 550, 552, ...). */
  smtp_code: number;
  /** Session duration in ms at time of log. */
  duration_ms: number;
  /** First 16 hex chars of sha256(localPart + domain + salt). Absent for
   *  events that never saw a RCPT TO. */
  local_part_hash_first8?: string;
}

export interface SmtpLogger {
  connectionStart(input: {
    remoteIp: string;
    startedAtMs: number;
  }): void;
  rcptAccepted(input: {
    remoteIp: string;
    startedAtMs: number;
    localPart: string;
    domain: string;
  }): void;
  rcptRejected(input: {
    remoteIp: string;
    startedAtMs: number;
    smtpCode: number;
    localPart?: string;
    domain?: string;
  }): void;
  dataAccepted(input: {
    remoteIp: string;
    startedAtMs: number;
    messageSize: number;
    senderDomain: string | null;
    localPart?: string;
    domain?: string;
  }): void;
  dataRejected(input: {
    remoteIp: string;
    startedAtMs: number;
    smtpCode: number;
    messageSize: number | null;
    senderDomain: string | null;
    localPart?: string;
    domain?: string;
  }): void;
  rateLimited(input: {
    remoteIp: string;
    startedAtMs: number;
    localPart?: string;
    domain?: string;
  }): void;
}

/** First 16 hex chars of sha256(local + domain + salt) per D-27. */
export function hashLocalPart(localPart: string, domain: string, salt: string): string {
  return createHash('sha256')
    .update(localPart)
    .update(domain)
    .update(salt)
    .digest('hex')
    .slice(0, 16);
}

export function createSmtpLogger(deps: SmtpLoggerDeps): SmtpLogger {
  const { pino, salt, now } = deps;

  const baseFields = (input: {
    remoteIp: string;
    startedAtMs: number;
  }): Pick<SmtpLogFields, 'timestamp' | 'sender_ip' | 'sender_ip_prefix' | 'duration_ms'> => {
    const nowMs = now();
    return {
      timestamp: nowMs,
      sender_ip: input.remoteIp,
      sender_ip_prefix: ipPrefix(input.remoteIp),
      duration_ms: nowMs - input.startedAtMs,
    };
  };

  const maybeHash = (localPart?: string, domain?: string): string | undefined => {
    if (!localPart || !domain) return undefined;
    return hashLocalPart(localPart, domain, salt);
  };

  return {
    connectionStart(input) {
      const fields: SmtpLogFields = {
        ...baseFields(input),
        sender_domain: null,
        message_size: null,
        smtp_code: 220,
      };
      pino.info(fields, 'smtp.connect');
    },
    rcptAccepted(input) {
      const fields: SmtpLogFields = {
        ...baseFields(input),
        sender_domain: null,
        message_size: null,
        smtp_code: 250,
        local_part_hash_first8: hashLocalPart(input.localPart, input.domain, salt),
      };
      pino.info(fields, 'smtp.rcpt.accept');
    },
    rcptRejected(input) {
      const fields: SmtpLogFields = {
        ...baseFields(input),
        sender_domain: null,
        message_size: null,
        smtp_code: input.smtpCode,
        local_part_hash_first8: maybeHash(input.localPart, input.domain),
      };
      pino.warn(fields, 'smtp.rcpt.reject');
    },
    dataAccepted(input) {
      const fields: SmtpLogFields = {
        ...baseFields(input),
        sender_domain: input.senderDomain,
        message_size: input.messageSize,
        smtp_code: 250,
        local_part_hash_first8: maybeHash(input.localPart, input.domain),
      };
      pino.info(fields, 'smtp.data.accept');
    },
    dataRejected(input) {
      const fields: SmtpLogFields = {
        ...baseFields(input),
        sender_domain: input.senderDomain,
        message_size: input.messageSize,
        smtp_code: input.smtpCode,
        local_part_hash_first8: maybeHash(input.localPart, input.domain),
      };
      pino.warn(fields, 'smtp.data.reject');
    },
    rateLimited(input) {
      const fields: SmtpLogFields = {
        ...baseFields(input),
        sender_domain: null,
        message_size: null,
        smtp_code: 452,
        local_part_hash_first8: maybeHash(input.localPart, input.domain),
      };
      pino.warn(fields, 'smtp.rate_limited');
    },
  };
}
