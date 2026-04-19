/**
 * Public barrel for the SMTP ingestion layer.
 *
 * External callers (the process entrypoint, integration tests, Phase 8
 * composition) import from `./smtp` and never reach into the internal
 * `server.ts`, `recipient.ts`, etc. directly.
 */

export type {
  SmtpConfig,
  SmtpRateLimitConfig,
  SmtpTimeoutsConfig,
  SmtpTlsConfig,
} from './config.js';
export { validateSmtpConfig } from './config.js';
export { createHtmlSanitizer, type HtmlSanitizer } from './sanitizer.js';
export {
  createRateLimiter,
  ipPrefix,
  type RateLimiter,
  type RateLimiterDeps,
} from './rate-limit.js';
export {
  createSmtpLogger,
  hashLocalPart,
  type SmtpLogger,
  type SmtpLogFields,
  type SmtpPinoLike,
} from './log.js';
export {
  createSmtpServer,
  type SmtpServerDeps,
  type SmtpServerHandle,
} from './server.js';
