/**
 * Protocol-agnostic message operations — the surface the SMTP adapter (Phase 4)
 * and HTTP adapter (Phase 5) call into.
 *
 * Scope (CORE-03, CORE-04):
 *   - `ingestMessage()` validates the envelope, resolves the inbox by
 *     `local-part + domain`, inserts the message row + attachment rows inside
 *     the repo's `withTransaction`, bumps `last_activity_at`, and THEN emits
 *     `bus.emit('message', ...)` strictly AFTER the DB commit (D-11). Listener
 *     failures are isolated by the bus wrapper and never roll back the insert.
 *   - `listMessages()` resolves the inbox by id, constant-time-compares the
 *     view-token via the shared `verifyViewToken` helper from `./inboxes.ts`
 *     (D-15: wrong-token → forbidden, never not_found), then returns messages
 *     sorted ASC by `received_at` with attachment metadata only — NEVER the
 *     sha256, storage_path, or body contents (internal-only / single-message
 *     endpoint's responsibility).
 *
 * Core stores `htmlBody` verbatim per D-13 — sanitization is the SMTP
 * adapter's concern, not this layer's.
 *
 * No direct `better-sqlite3`, no `node:fs`, no `db.prepare`/`db.exec` — only
 * the Phase 2 repos and the Phase 3 bus (D-03).
 */

import type { Repos } from '../db/repos/index.js';
import { nowMs } from '../util/now.js';
import type { Bus } from './bus.js';
import { verifyViewToken } from './inboxes.js';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface MessagesConfig {
  /** Domain the address is rooted at (e.g. `example.test`). Never hardcoded (D-05). */
  domain: string;
  /** Sliding idle TTL in ms — added to `receivedAt` to produce the new `expires_at`. */
  idleTtlMs: number;
}

export interface MessagesDeps {
  repos: Repos;
  bus: Bus;
  config: MessagesConfig;
  /** Override clock for determinism in tests. Defaults to `nowMs`. */
  now?: () => number;
}

/**
 * Already-written attachment descriptor handed to `ingestMessage`. The SMTP
 * adapter streams the bytes to the attachment store BEFORE calling ingest, so
 * `path` is the assigned `storage_path` and `sha256` is the computed digest.
 */
export interface IngestAttachmentInput {
  /** `null` is allowed — inline parts frequently have no filename. */
  filename: string | null;
  contentType: string | null;
  size: number;
  /** REQUIRED. 64-char lowercase hex (D-14). */
  sha256: string;
  /** REQUIRED. The storage_path returned by attachmentStore.writeAttachment(). */
  path: string;
}

export interface IngestInput {
  /** e.g. `abc123@example.test`. Parsed into local-part + domain; must have exactly one `@`. */
  envelopeTo: string;
  envelopeFrom: string | null;
  sender: string | null;
  subject: string | null;
  textBody: string | null;
  /** Already sanitized by the SMTP adapter (D-13). Core stores it verbatim. */
  htmlBody: string | null;
  headers: Record<string, string | string[]> | null;
  attachments: readonly IngestAttachmentInput[];
  /** Total SMTP DATA size in bytes. */
  sizeBytes: number;
}

export type IngestResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'unknown_recipient' | 'invalid_attachment' | 'invalid_envelope' };

export interface AttachmentView {
  id: string;
  filename: string | null;
  contentType: string | null;
  size: number;
}

export interface MessageView {
  id: string;
  receivedAt: number;
  sender: string | null;
  subject: string | null;
  /** True iff the message has a plain-text body. The body itself is returned by
   *  the single-message endpoint (Phase 5), not by `listMessages`. */
  hasTextBody: boolean;
  hasHtmlBody: boolean;
  sizeBytes: number;
  attachments: readonly AttachmentView[];
}

export interface ListMessagesInput {
  inboxId: string;
  viewToken: string;
}

export type ListMessagesResult =
  | { ok: true; messages: readonly MessageView[] }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export interface MessagesApi {
  ingestMessage(input: IngestInput): IngestResult;
  listMessages(input: ListMessagesInput): ListMessagesResult;
}

/**
 * Parse `envelopeTo` into `{ localPart, domain }`. Returns `null` for any
 * malformed input: no `@`, multiple `@`, empty local-part, or empty domain.
 *
 * This is deliberately stricter than RFC 5321 — we don't accept quoted
 * local-parts or source routes. The SMTP adapter (Phase 4) decides which
 * shapes to accept before calling ingest; if something still gets through,
 * we reject here defensively.
 */
const parseEnvelope = (envelopeTo: string): { localPart: string; domain: string } | null => {
  const at = envelopeTo.indexOf('@');
  if (at <= 0 || at !== envelopeTo.lastIndexOf('@')) return null;
  const localPart = envelopeTo.slice(0, at);
  const domain = envelopeTo.slice(at + 1);
  if (!localPart || !domain) return null;
  return { localPart, domain };
};

/**
 * Defensive reject per D-14: the SMTP adapter should have filtered these out
 * already, but core refuses to persist a row with an unverifiable blob
 * pointer. Empty filename is allowed (inline parts).
 */
const isValidAttachment = (a: IngestAttachmentInput): boolean => {
  if (!a.path) return false;
  if (typeof a.sha256 !== 'string') return false;
  return SHA256_HEX_RE.test(a.sha256);
};

/**
 * Factory for the message operations bound to a specific set of deps.
 *
 * Every side effect flows through `deps.repos` or `deps.bus`; the only direct
 * Node API use is `nowMs` for timestamps (injectable via `deps.now`).
 * Deps are never mutated.
 */
export function createMessages(deps: MessagesDeps): MessagesApi {
  const now = deps.now ?? nowMs;

  const ingestMessage = (input: IngestInput): IngestResult => {
    const parsed = parseEnvelope(input.envelopeTo);
    if (!parsed) return { ok: false, reason: 'invalid_envelope' };

    const inbox = deps.repos.inboxes.findInboxByLocalPart(parsed.localPart, parsed.domain);
    if (!inbox) return { ok: false, reason: 'unknown_recipient' };

    for (const a of input.attachments) {
      if (!isValidAttachment(a)) return { ok: false, reason: 'invalid_attachment' };
    }

    const receivedAt = now();

    // Transactional write (repo wraps in withTransaction). Either the message
    // row AND all attachment rows land, or none do — one atomic unit.
    const { messageId } = deps.repos.messages.insertMessageWithAttachments(
      {
        inbox_id: inbox.id,
        sender: input.sender,
        subject: input.subject,
        text_body: input.textBody,
        html_body_sanitized: input.htmlBody,
        size_bytes: input.sizeBytes,
        envelope_from: input.envelopeFrom,
        envelope_to: input.envelopeTo,
        headers_json: input.headers ? JSON.stringify(input.headers) : null,
        received_at: receivedAt,
      },
      input.attachments.map((a) => ({
        filename: a.filename,
        content_type: a.contentType,
        size_bytes: a.size,
        sha256: a.sha256,
        storage_path: a.path,
      })),
    );

    // Sliding-TTL bump. `updateLastActivity` caps the new expires_at at
    // `hard_expires_at` in SQL, so we can pass the naive sum without a cap
    // check here. Ignore the return — we only care that the bump happened.
    deps.repos.inboxes.updateLastActivity(inbox.id, receivedAt + deps.config.idleTtlMs);

    // D-11: emit AFTER the DB transaction commits. The repo's withTransaction
    // is synchronous, so by the time we reach this line the commit has
    // already landed — any subscriber that re-reads via the repos will see
    // the new row. The bus wrapper catches listener throws (see bus.ts), so
    // a faulty subscriber cannot propagate an error here and cannot roll
    // back the insert.
    deps.bus.emit('message', { inboxId: inbox.id, messageId, receivedAt });

    return { ok: true, messageId };
  };

  const listMessages = (input: ListMessagesInput): ListMessagesResult => {
    const row = deps.repos.inboxes.findInboxById(input.inboxId);
    if (!row) return { ok: false, reason: 'not_found' };

    // D-15: wrong token → forbidden, NEVER not_found (anti-enumeration).
    // Uses the shared constant-time compare from inboxes.ts — single source
    // of truth for this check.
    if (!verifyViewToken(row, input.viewToken)) return { ok: false, reason: 'forbidden' };

    // Repo returns DESC (newest-first) paginated. Inboxes are bounded (D-16),
    // so pull everything and reorder ASC in-memory.
    const descending = deps.repos.messages.listMessagesByInbox(input.inboxId, {
      limit: 100_000,
      offset: 0,
    });

    const messages: MessageView[] = descending.map((m) => {
      // Attachment metadata ONLY — never `sha256` or `storage_path`. Those
      // are internal identifiers; leaking them would let a caller probe the
      // attachment store directly.
      const attachments = deps.repos.attachments.listAttachmentsByMessage(m.id).map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.content_type,
        size: a.size_bytes,
      }));
      return {
        id: m.id,
        receivedAt: m.received_at,
        sender: m.sender,
        subject: m.subject,
        // Bodies themselves are returned by the single-message endpoint
        // (API-04 in Phase 5), not by the list view. We surface booleans so
        // the UI can badge "has attachment", "has html", etc., without
        // forcing a second round-trip on empty inboxes.
        hasTextBody: m.text_body !== null,
        hasHtmlBody: m.html_body_sanitized !== null,
        sizeBytes: m.size_bytes,
        attachments,
      };
    });

    // D-15: ASC chronological. Stable sort on a primitive numeric key.
    messages.sort((a, b) => a.receivedAt - b.receivedAt);

    return { ok: true, messages };
  };

  return { ingestMessage, listMessages };
}
