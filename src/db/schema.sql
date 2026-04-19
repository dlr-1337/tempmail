-- Tempmail schema v1
-- This file is run once on a fresh DB, then recorded in schema_version.
-- PRAGMAs are set by the client wrapper on every connection (not here).

-- Schema version tracking (D-30, D-31).
-- The client reads MAX(version) on open; if missing or < latest, runs pending migrations.
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
) STRICT;

-- Inboxes (D-05). The `domain` column is first-class so multi-domain (v2) is a pure INSERT change.
CREATE TABLE IF NOT EXISTS inboxes (
  id                TEXT PRIMARY KEY,
  local_part        TEXT NOT NULL,
  domain            TEXT NOT NULL,
  view_token_hash   TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  hard_expires_at   INTEGER NOT NULL
) STRICT;

-- Public address is (local_part, domain). v1 ships single-domain; uniqueness still enforced across both columns.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inboxes_local_domain
  ON inboxes(local_part, domain);

-- Sweeper scans expired inboxes by expires_at. Index mandatory.
CREATE INDEX IF NOT EXISTS ix_inboxes_expires_at
  ON inboxes(expires_at);

-- Messages (D-06). FK to inboxes with CASCADE (D-09).
CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT PRIMARY KEY,
  inbox_id              TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  sender                TEXT,
  subject               TEXT,
  text_body             TEXT,
  html_body_sanitized   TEXT,
  received_at           INTEGER NOT NULL,
  size_bytes            INTEGER NOT NULL,
  envelope_from         TEXT,
  envelope_to           TEXT,
  headers_json          TEXT
) STRICT;

-- listMessages(inbox_id) ORDER BY received_at DESC — covered index.
CREATE INDEX IF NOT EXISTS ix_messages_inbox_received
  ON messages(inbox_id, received_at DESC);

-- Attachments (D-07). FK to messages with CASCADE (D-09). Bytes live on disk; this table is metadata only.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL
) STRICT;

-- Orphan reaper (Phase 6) will walk the attachments dir and ask "does this sha256 appear in the DB?" — index needed.
CREATE INDEX IF NOT EXISTS ix_attachments_sha256
  ON attachments(sha256);

-- Listing a message's attachments — covered by (message_id).
CREATE INDEX IF NOT EXISTS ix_attachments_message
  ON attachments(message_id);

-- Abuse counters (D-08). Composite PK on (ip_prefix, bucket, window_start).
-- ip_prefix is the /24 for IPv4 or /64 for IPv6 per the "Specific Ideas" section of CONTEXT.md.
-- bucket is a short string like 'inbox_create', 'msg_read', 'smtp_ingest'.
-- window_start is the floor of the rate-limit window start, unix ms.
CREATE TABLE IF NOT EXISTS abuse_counters (
  ip_prefix     TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  PRIMARY KEY (ip_prefix, bucket, window_start)
) STRICT, WITHOUT ROWID;
