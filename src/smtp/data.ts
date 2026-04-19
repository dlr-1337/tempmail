/**
 * `onData` handler — parse the DATA stream, sanitize, persist (D-16, D-18, D-19).
 *
 * Flow:
 *   1. Wait for the stream's `end` event, then check `sizeExceeded` → 552.
 *   2. Call `parseIncoming` which pipes each attachment through the content-
 *      addressed attachment store.
 *   3. Sanitize HTML body (D-18) — remote `<img>` left intact (D-20).
 *   4. For every RCPT TO on this transaction, call `core.ingestMessage` once
 *      per recipient. (smtp-server surfaces each RCPT in `session.envelope.rcptTo`
 *      and calls `onData` ONCE for the whole DATA block, per SMTP spec.)
 *   5. Map `IngestResult` → SMTP code.
 */

import type {
  OnDataCallback,
  SMTPResponseError,
  SMTPServerDataStream,
  SMTPServerSession,
} from 'smtp-server';

import type { AttachmentStore } from '../attachments/index.js';
import type { CoreApi, IngestInput, IngestResult } from '../core/index.js';
import type { SmtpLogger } from './log.js';
import { parseIncoming } from './parser.js';
import type { HtmlSanitizer } from './sanitizer.js';

export interface DataHandlerDeps {
  core: CoreApi;
  attachmentStore: AttachmentStore;
  sanitizer: HtmlSanitizer;
  smtpLog: SmtpLogger;
  now: () => number;
}

export type OnDataHandler = (
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
  cb: OnDataCallback,
) => void;

export function buildOnData(deps: DataHandlerDeps): OnDataHandler {
  const { core, attachmentStore, sanitizer, smtpLog, now } = deps;

  return (stream, session, cb) => {
    const remoteIp = session.remoteAddress;
    const startedAtMs = now();

    const handle = async (): Promise<void> => {
      let parsed: Awaited<ReturnType<typeof parseIncoming>>;
      try {
        parsed = await parseIncoming(stream, { attachmentStore });
      } catch (err) {
        smtpLog.dataRejected({
          remoteIp,
          startedAtMs,
          smtpCode: 550,
          messageSize: null,
          senderDomain: null,
        });
        const e = new Error('550 5.6.0 Malformed message') as SMTPResponseError;
        e.responseCode = 550;
        throw coerceThrown(err, e);
      }

      // After the parser has drained the stream, smtp-server sets
      // `sizeExceeded` on it. If so, reject with 552.
      if (stream.sizeExceeded) {
        smtpLog.dataRejected({
          remoteIp,
          startedAtMs,
          smtpCode: 552,
          messageSize: parsed.sizeBytes,
          senderDomain: null,
        });
        const err = new Error('552 5.3.4 Message exceeds fixed maximum size') as SMTPResponseError;
        err.responseCode = 552;
        throw err;
      }

      const sanitizedHtml = sanitizer.sanitize(parsed.htmlBody);
      const senderDomain = parseSenderDomain(session.envelope.mailFrom || null);

      const recipients = session.envelope.rcptTo;
      if (recipients.length === 0) {
        // Shouldn't happen — smtp-server requires at least one accepted RCPT
        // to reach DATA. Defensive: reject.
        smtpLog.dataRejected({
          remoteIp,
          startedAtMs,
          smtpCode: 554,
          messageSize: parsed.sizeBytes,
          senderDomain,
        });
        const err = new Error('554 5.5.1 No recipients') as SMTPResponseError;
        err.responseCode = 554;
        throw err;
      }

      // Ingest once per recipient. Each recipient has its own inbox row —
      // per CORE-03, `ingestMessage` is idempotent for attachment rows via
      // the sha256 column, so the same payload delivered to two recipients
      // shares blobs on disk.
      for (const rcpt of recipients) {
        const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : null;
        const input: IngestInput = {
          envelopeTo: rcpt.address,
          envelopeFrom,
          sender: parsed.sender,
          subject: parsed.subject,
          textBody: parsed.textBody,
          htmlBody: sanitizedHtml,
          headers: parsed.headers,
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
            sha256: a.sha256,
            path: a.path,
          })),
          sizeBytes: parsed.sizeBytes,
        };

        const result: IngestResult = core.ingestMessage(input);
        if (!result.ok) {
          const code = result.reason === 'invalid_attachment' ? 550 : 550;
          smtpLog.dataRejected({
            remoteIp,
            startedAtMs,
            smtpCode: code,
            messageSize: parsed.sizeBytes,
            senderDomain,
          });
          const err = new Error(
            `${code} 5.0.0 Ingest failed: ${result.reason}`,
          ) as SMTPResponseError;
          err.responseCode = code;
          throw err;
        }
      }

      const first = recipients[0];
      const firstAt = first ? first.address.indexOf('@') : -1;
      const localHint = first && firstAt > 0 ? first.address.slice(0, firstAt) : undefined;
      const domainHint = first && firstAt > 0 ? first.address.slice(firstAt + 1) : undefined;

      smtpLog.dataAccepted({
        remoteIp,
        startedAtMs,
        messageSize: parsed.sizeBytes,
        senderDomain,
        localPart: localHint,
        domain: domainHint,
      });
    };

    handle().then(
      () => cb(null, '250 Message queued'),
      (err: Error) => cb(err),
    );
  };
}

function parseSenderDomain(mailFrom: { address: string } | null): string | null {
  if (!mailFrom) return null;
  const at = mailFrom.address.indexOf('@');
  if (at < 0 || at === mailFrom.address.length - 1) return null;
  return mailFrom.address.slice(at + 1).toLowerCase();
}

function coerceThrown(primary: unknown, fallback: Error): Error {
  if (primary instanceof Error && 'responseCode' in primary) return primary;
  return fallback;
}
