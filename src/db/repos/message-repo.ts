import { newId } from '../../util/id.js';
import { nowMs } from '../../util/now.js';
import type { Db } from '../client.js';
import { withTransaction } from '../transaction.js';
import type { MessageRow } from '../types.js';

/**
 * Input for inserting a message. `id` and `received_at` are assigned by the repo
 * unless the caller overrides (rare — mostly for tests that pin time).
 */
export interface NewMessage {
  inbox_id: string;
  sender: string | null;
  subject: string | null;
  text_body: string | null;
  html_body_sanitized: string | null;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string | null;
  headers_json: string | null;
  /** Optional override. Default: nowMs(). */
  received_at?: number;
  /** Optional override. Default: newId(). */
  id?: string;
}

/**
 * Input for an attachment row accompanying a message.
 * The `storage_path` is assigned by the attachment-store layer (plan 04);
 * this repo only persists the metadata.
 */
export interface NewAttachment {
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  /** Optional override. Default: newId(). */
  id?: string;
}

export interface InsertResult {
  messageId: string;
  attachmentIds: readonly string[];
}

export interface MessageRepo {
  /**
   * Atomically inserts one message row and zero-or-more attachment rows.
   * All succeed or all fail — FK constraint + one transaction.
   *
   * Returns the assigned IDs. Caller uses them for log correlation and
   * for the event bus emission (Phase 3).
   */
  insertMessageWithAttachments(
    message: NewMessage,
    attachments: readonly NewAttachment[],
  ): InsertResult;

  findMessageById(id: string): MessageRow | undefined;

  /**
   * Returns messages for an inbox, newest first (ORDER BY received_at DESC),
   * paginated by a simple LIMIT/OFFSET. The API in Phase 5 will wrap this.
   */
  listMessagesByInbox(
    inboxId: string,
    opts: { limit: number; offset: number },
  ): readonly MessageRow[];

  countMessagesByInbox(inboxId: string): number;

  /** Deletes all messages for an inbox (rare — usually the inbox DELETE cascades).
   *  Exists for completeness; returns rows deleted. */
  deleteMessagesByInbox(inboxId: string): number;
}

export function createMessageRepo(db: Db): MessageRepo {
  // 11 params: (id, inbox_id, sender, subject, text_body, html_body_sanitized,
  //             received_at, size_bytes, envelope_from, envelope_to, headers_json)
  const insertMsgStmt = db.prepare<
    [
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      number,
      number,
      string | null,
      string | null,
      string | null,
    ]
  >(`
    INSERT INTO messages (id, inbox_id, sender, subject, text_body,
      html_body_sanitized, received_at, size_bytes, envelope_from,
      envelope_to, headers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 7 params: (id, message_id, filename, content_type, size_bytes, sha256, storage_path)
  const insertAttStmt = db.prepare<
    [string, string, string | null, string | null, number, string, string]
  >(`
    INSERT INTO attachments (id, message_id, filename, content_type,
      size_bytes, sha256, storage_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const findByIdStmt = db.prepare<[string], MessageRow>(`
    SELECT id, inbox_id, sender, subject, text_body, html_body_sanitized,
           received_at, size_bytes, envelope_from, envelope_to, headers_json
    FROM messages WHERE id = ?
  `);

  const listByInboxStmt = db.prepare<[string, number, number], MessageRow>(`
    SELECT id, inbox_id, sender, subject, text_body, html_body_sanitized,
           received_at, size_bytes, envelope_from, envelope_to, headers_json
    FROM messages
    WHERE inbox_id = ?
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `);

  const countByInboxStmt = db.prepare<[string], { c: number }>(
    'SELECT COUNT(*) AS c FROM messages WHERE inbox_id = ?',
  );

  const deleteByInboxStmt = db.prepare<[string]>('DELETE FROM messages WHERE inbox_id = ?');

  return {
    insertMessageWithAttachments(message, attachments) {
      const messageId = message.id ?? newId();
      const receivedAt = message.received_at ?? nowMs();

      // Pre-assign attachment IDs so we can return them outside the transaction.
      const attachmentIds = attachments.map((a) => a.id ?? newId());

      withTransaction(db, () => {
        insertMsgStmt.run(
          messageId,
          message.inbox_id,
          message.sender,
          message.subject,
          message.text_body,
          message.html_body_sanitized,
          receivedAt,
          message.size_bytes,
          message.envelope_from,
          message.envelope_to,
          message.headers_json,
        );
        for (let i = 0; i < attachments.length; i += 1) {
          const att = attachments[i];
          const attId = attachmentIds[i];
          // noUncheckedIndexedAccess appeasement — cannot be undefined given our
          // own pre-allocation, but TS can't prove that.
          if (!att || !attId) continue;
          insertAttStmt.run(
            attId,
            messageId,
            att.filename,
            att.content_type,
            att.size_bytes,
            att.sha256,
            att.storage_path,
          );
        }
      });

      return { messageId, attachmentIds };
    },

    findMessageById(id) {
      return findByIdStmt.get(id);
    },

    listMessagesByInbox(inboxId, opts) {
      return listByInboxStmt.all(inboxId, opts.limit, opts.offset);
    },

    countMessagesByInbox(inboxId) {
      const r = countByInboxStmt.get(inboxId);
      return r?.c ?? 0;
    },

    deleteMessagesByInbox(inboxId) {
      return deleteByInboxStmt.run(inboxId).changes;
    },
  };
}
