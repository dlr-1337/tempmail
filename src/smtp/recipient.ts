/**
 * `onRcptTo` handler — the 550 wall (SMTP-04, D-14) and 452 rate-limit point.
 *
 * Order of checks:
 *   1. Rate-limit the sender IP prefix (D-21, D-23). Empty bucket → 452 + abuse bump.
 *   2. Validate the recipient's local-part + domain syntax (D-14).
 *   3. Reject wrong-domain addresses with 550 before hitting the DB.
 *   4. Look up the inbox via `core.findInboxByAddress`. No match → 550 5.1.1.
 *
 * Every branch emits a PII-safe log event through `smtpLog` (D-26..D-29).
 */

import type {
  OnRcptToCallback,
  SMTPResponseError,
  SMTPServerAddress,
  SMTPServerSession,
} from 'smtp-server';

import type { CoreApi } from '../core/index.js';
import type { AbuseRepo } from '../db/repos/index.js';
import type { SmtpConfig } from './config.js';
import type { SmtpLogger } from './log.js';
import { type RateLimiter, ipPrefix } from './rate-limit.js';

export interface RecipientHandlerDeps {
  core: CoreApi;
  config: SmtpConfig;
  rateLimiter: RateLimiter;
  abuseRepo: AbuseRepo;
  smtpLog: SmtpLogger;
  now: () => number;
}

export type OnRcptToHandler = (
  address: SMTPServerAddress,
  session: SMTPServerSession,
  cb: OnRcptToCallback,
) => void;

export function buildOnRcptTo(deps: RecipientHandlerDeps): OnRcptToHandler {
  const { core, config, rateLimiter, abuseRepo, smtpLog, now } = deps;
  const configDomain = config.domain.toLowerCase();

  return (address, session, cb) => {
    const remoteIp = session.remoteAddress;
    const startedAtMs = now();
    const prefix = ipPrefix(remoteIp);

    // 1. Rate limit first — cheap, deterministic, no DB touch.
    if (!rateLimiter.take(prefix)) {
      // Bucket to minute-windows so Phase 6's sweeper can prune old rows.
      const windowStart = Math.floor(startedAtMs / 60_000) * 60_000;
      try {
        abuseRepo.incrementCounter(prefix, 'smtp_452', windowStart);
      } catch {
        // Best-effort observability; never fail the SMTP branch because abuse
        // counter write failed. Swallow silently — logger still emits 452.
      }
      smtpLog.rateLimited({ remoteIp, startedAtMs });
      const err = new Error('452 4.7.1 Too many requests, try later') as SMTPResponseError;
      err.responseCode = 452;
      cb(err);
      return;
    }

    // 2. Parse `address.address` into local + domain. Defensive check — the
    //    smtp-server parser already ensures a single `@`, but we guard.
    const raw = address.address ?? '';
    const at = raw.indexOf('@');
    if (at <= 0 || at !== raw.lastIndexOf('@')) {
      smtpLog.rcptRejected({ remoteIp, startedAtMs, smtpCode: 550 });
      const err = new Error('550 5.1.3 Bad recipient syntax') as SMTPResponseError;
      err.responseCode = 550;
      cb(err);
      return;
    }
    const localPart = raw.slice(0, at);
    const domain = raw.slice(at + 1).toLowerCase();
    if (!localPart || !domain) {
      smtpLog.rcptRejected({ remoteIp, startedAtMs, smtpCode: 550 });
      const err = new Error('550 5.1.3 Bad recipient syntax') as SMTPResponseError;
      err.responseCode = 550;
      cb(err);
      return;
    }

    // 3. Domain mismatch → 550 Relay access denied.
    if (domain !== configDomain) {
      smtpLog.rcptRejected({
        remoteIp,
        startedAtMs,
        smtpCode: 550,
        localPart,
        domain,
      });
      const err = new Error('550 5.7.1 Relay access denied') as SMTPResponseError;
      err.responseCode = 550;
      cb(err);
      return;
    }

    // 4. Inbox lookup. No catch-all.
    const inbox = core.findInboxByAddress(localPart, domain);
    if (!inbox) {
      smtpLog.rcptRejected({
        remoteIp,
        startedAtMs,
        smtpCode: 550,
        localPart,
        domain,
      });
      const err = new Error('550 5.1.1 Unknown recipient') as SMTPResponseError;
      err.responseCode = 550;
      cb(err);
      return;
    }

    smtpLog.rcptAccepted({ remoteIp, startedAtMs, localPart, domain });
    cb();
  };
}
