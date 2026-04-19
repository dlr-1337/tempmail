/**
 * Stream-based incoming-message parser (D-16, D-17, SMTP-05).
 *
 * Wraps `mailparser.simpleParser(stream)` — the streaming form, NOT the
 * `simpleParser(Buffer)` form — so the full raw message never lands in a
 * single heap buffer. Attachment bytes are piped through the injected
 * `AttachmentStore` (content-addressed) before we hand anything to Core.
 *
 * Mailparser still buffers individual attachment bodies as it decodes them;
 * that's an upstream design choice and is bounded by the server-level `size`
 * cap (10 MiB per message, SMTP-03).
 */

import { Readable } from 'node:stream';
import { type ParsedMail, simpleParser } from 'mailparser';

import type { AttachmentStore } from '../attachments/index.js';

export interface WrittenAttachment {
  filename: string | null;
  contentType: string | null;
  size: number;
  sha256: string;
  /** Relative path from the store root (matches `attachments.storage_path`). */
  path: string;
}

export interface ParsedIncomingMessage {
  sender: string | null;
  subject: string | null;
  textBody: string | null;
  /** Raw HTML from mailparser — NOT yet sanitized. */
  htmlBody: string | null;
  headers: Record<string, string | string[]> | null;
  attachments: readonly WrittenAttachment[];
  /** Number of bytes observed on the DATA stream. Accurate counter-check
   *  against `size_bytes` in the DB. */
  sizeBytes: number;
}

export interface ParseDeps {
  attachmentStore: AttachmentStore;
}

/**
 * Count bytes as they flow from the DATA stream through the parser. We tee
 * the stream: the parser consumes one copy, we count on the other. But rather
 * than actually fork the stream (expensive), we wrap the source in a
 * PassThrough that tracks `.length` as data events flow through.
 *
 * Input stream is consumed in full; returned promise resolves once parsing is
 * complete. If parsing throws, the returned promise rejects.
 */
export async function parseIncoming(
  source: Readable,
  deps: ParseDeps,
): Promise<ParsedIncomingMessage> {
  let sizeBytes = 0;

  // Wrap the source so we can count bytes as they flow through to mailparser.
  const counting = new Readable({
    read() {
      // No-op — we push from the upstream listener below.
    },
  });

  source.on('data', (chunk: Buffer) => {
    sizeBytes += chunk.length;
    counting.push(chunk);
  });
  source.once('end', () => {
    counting.push(null);
  });
  source.once('error', (err) => {
    counting.destroy(err);
  });

  const parsed: ParsedMail = await simpleParser(counting);

  // Persist each attachment via the content-addressed store.
  const attachments: WrittenAttachment[] = [];
  for (const a of parsed.attachments ?? []) {
    const content = a.content;
    if (!content) continue;
    const stream = Readable.from(content);
    // `writeAttachment` consumes the stream and returns `{sha256, storagePath, sizeBytes}`.
    const written = await deps.attachmentStore.writeAttachment(stream);
    attachments.push({
      filename: a.filename ?? null,
      contentType: a.contentType ?? null,
      size: written.sizeBytes,
      sha256: written.sha256,
      path: written.storagePath,
    });
  }

  const sender = extractSender(parsed);
  const subject = parsed.subject ?? null;
  const textBody = parsed.text ?? null;
  const htmlBody = typeof parsed.html === 'string' ? parsed.html : null;

  // Headers: mailparser returns a Map; shallow-serialize to a plain object so
  // JSON.stringify downstream is well-defined. Values may be arrays or strings.
  const headers: Record<string, string | string[]> = {};
  parsed.headers?.forEach((value, key) => {
    if (typeof value === 'string') {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    } else {
      headers[key] = JSON.stringify(value);
    }
  });

  return {
    sender,
    subject,
    textBody,
    htmlBody,
    headers: Object.keys(headers).length > 0 ? headers : null,
    attachments,
    sizeBytes,
  };
}

function extractSender(parsed: ParsedMail): string | null {
  const from = parsed.from;
  if (!from) return null;
  // `from` is an AddressObject (or array). Display the first address's .text.
  const single = Array.isArray(from) ? from[0] : from;
  if (!single) return null;
  if ('text' in single && typeof single.text === 'string') return single.text;
  return null;
}
