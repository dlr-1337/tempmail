/**
 * Row types for the tempmail schema v1.
 *
 * Every field corresponds exactly to a column in src/db/schema.sql.
 * Types follow SQLite STRICT + our NOT NULL declarations:
 *   - SQL `INTEGER NOT NULL` -> TS `number`
 *   - SQL `TEXT NOT NULL`    -> TS `string`
 *   - SQL `TEXT` (nullable)  -> TS `string | null`
 *
 * better-sqlite3 returns `null` (not `undefined`) for NULL columns.
 *
 * Do NOT add business-logic fields here. This file is the SQL-to-TS boundary;
 * richer domain types (e.g., `Inbox` with a `Date` field) belong to Phase 3.
 */

export interface InboxRow {
  id: string;
  local_part: string;
  domain: string;
  view_token_hash: string;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  hard_expires_at: number;
}

export interface MessageRow {
  id: string;
  inbox_id: string;
  sender: string | null;
  subject: string | null;
  text_body: string | null;
  html_body_sanitized: string | null;
  received_at: number;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string | null;
  headers_json: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
}

export interface AbuseCounterRow {
  ip_prefix: string;
  bucket: string;
  count: number;
  window_start: number;
}

export interface SchemaVersionRow {
  version: number;
  applied_at: number;
}
