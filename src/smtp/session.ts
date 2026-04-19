/**
 * Per-connection state we derive from smtp-server's `session` object.
 *
 * smtp-server itself hands us a rich object, but we only want a narrow,
 * PII-careful view that the rest of the SMTP adapter can reason about —
 * in particular, the IP prefix used for rate limiting and logging (D-21, D-26).
 */

import type { SMTPServerSession } from 'smtp-server';
import { ipPrefix } from './rate-limit.js';

export interface SmtpSessionView {
  /** Opaque per-connection id from smtp-server (safe to log, not PII). */
  sessionId: string;
  /** Raw remote IP — used as a rate-limit-lookup input, NOT emitted in logs. */
  remoteAddress: string;
  /** Normalized IP prefix (`/24` IPv4, `/64` IPv6) — used for rate limiting
   *  and as the `sender_ip_prefix` log field. */
  ipPrefix: string;
  /** Wall-clock start of the connection, epoch ms. Used to compute
   *  `duration_ms` at log emit time. */
  startedAtMs: number;
}

/** Extract our narrow view from smtp-server's session. */
export function readSession(session: SMTPServerSession, now: () => number): SmtpSessionView {
  return {
    sessionId: session.id,
    remoteAddress: session.remoteAddress,
    ipPrefix: ipPrefix(session.remoteAddress),
    startedAtMs: now(),
  };
}
