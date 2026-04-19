# Phase 2: Storage Layer - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto (--auto flag) — defaults derived from concrete requirements + convergent research

<domain>
## Phase Boundary

A durable, concurrent-safe SQLite schema with hash-sharded attachment storage that every other phase reads and writes through a single client wrapper. No HTTP, no SMTP, no UI — pure data layer.

Scope (from ROADMAP.md + REQUIREMENTS.md STORE-01..04):
- `inboxes`, `messages`, `attachments`, `abuse_counters` tables with `domain` as first-class column
- WAL mode with documented PRAGMAs
- Hash-sharded attachment directory on disk, metadata in DB
- Single prepared-statement client wrapper used by all other phases

Out of scope for this phase: the event bus (Phase 3), any HTTP surface (Phase 5), any SMTP (Phase 4), migrations tooling beyond initial bootstrap.

</domain>

<decisions>
## Implementation Decisions

### Driver and Runtime
- **D-01:** Runtime is Node 22 LTS (locked by STACK.md research)
- **D-02:** Driver is `better-sqlite3@12.x` (synchronous API, in-process, zero separate services)
- **D-03:** Language is TypeScript, strict mode; compiled via `tsx` in dev

### Schema
- **D-04:** Four tables: `inboxes`, `messages`, `attachments`, `abuse_counters`
- **D-05:** `inboxes(id TEXT PK, local_part TEXT, domain TEXT, view_token_hash TEXT, created_at INT, last_activity_at INT, expires_at INT, hard_expires_at INT)` — `domain` as first-class column (v1 ships one domain but data model supports multi from day one)
- **D-06:** `messages(id TEXT PK, inbox_id TEXT FK, sender TEXT, subject TEXT, text_body TEXT, html_body_sanitized TEXT, received_at INT, size_bytes INT, envelope_from TEXT, envelope_to TEXT, headers_json TEXT)`
- **D-07:** `attachments(id TEXT PK, message_id TEXT FK, filename TEXT, content_type TEXT, size_bytes INT, sha256 TEXT, storage_path TEXT)` — path stores the relative hash-sharded path, not the bytes
- **D-08:** `abuse_counters(ip_prefix TEXT, bucket TEXT, count INT, window_start INT, PK(ip_prefix, bucket, window_start))` — rolling counters for rate limit and abuse tracking
- **D-09:** All FKs declared with `ON DELETE CASCADE` so `expireInbox()` cascades without application logic
- **D-10:** Timestamps are integer epoch milliseconds (UTC), not TEXT — enables fast range queries and sweeper scans
- **D-11:** `html_body_sanitized` is stored ALREADY sanitized (server sanitization happens at SMTP ingestion, not on read) — renderers trust this column

### PRAGMAs and Open Flags
- **D-12:** `journal_mode=WAL` — one writer, many readers; no reader blocks the writer
- **D-13:** `synchronous=NORMAL` — WAL-safe; not FULL (overkill for ephemeral data)
- **D-14:** `busy_timeout=5000` — automatic retry on transient lock
- **D-15:** `foreign_keys=ON` — enforce FKs (off by default in SQLite)
- **D-16:** `mmap_size=134217728` (128 MB) — faster reads on small VPS
- **D-17:** `temp_store=MEMORY` — temp tables in RAM
- **D-18:** `wal_autocheckpoint=1000` — default; revisit if WAL grows unbounded under load
- **D-19:** Connection is a single long-lived handle opened at process start; not per-request pooling (better-sqlite3 is sync and single-threaded-safe)

### Client Wrapper
- **D-20:** One module `src/db/client.ts` exports `openDb(path: string)` + typed repositories (`inboxRepo`, `messageRepo`, `attachmentRepo`, `abuseRepo`)
- **D-21:** All SQL goes through prepared statements cached on the repo object — no ad-hoc `db.prepare()` in callers
- **D-22:** Repos expose intent-named methods (`createInbox`, `findInboxByLocalPart`, `insertMessageWithAttachments`) — not generic `query()` / `run()` passthroughs
- **D-23:** Transactions expressed as arrow functions passed to `db.transaction(fn)` — atomic ingestion of message + attachments in a single commit

### Attachment Storage
- **D-24:** Root directory is `/data/attachments` (dev: `./data/attachments`)
- **D-25:** Hash sharding is two-level: `<first-2-hex>/<next-2-hex>/<sha256>` — caps single-directory entries at ~65k worst case, typically <10k
- **D-26:** Filename on disk is the sha256, never the original filename (content-addressed, free dedup, immune to traversal)
- **D-27:** Write path: open temp file → stream bytes → rename to final hash path (atomic)
- **D-28:** Read path: `sendFile()` from the hash path, never from a user-controlled path component
- **D-29:** Content-addressed storage means identical attachments across different inboxes share a single blob; DB row still per-message

### Migrations
- **D-30:** No migrations framework in v1 — single `schema.sql` file run once on DB open if `schema_version` table is missing or outdated
- **D-31:** `schema_version` table tracks a monotonically increasing integer; new migrations append as additional SQL files (`schema-v2.sql`, etc.); all applied in one transaction on open
- **D-32:** Backward-compatible-only migrations in v1 (additive); destructive migrations require explicit ops step, not automatic

### Testing
- **D-33:** Unit tests in Vitest with an in-memory SQLite (`:memory:`) — fast, parallel, no fs cleanup
- **D-34:** Integration test with a real file DB in a temp dir for PRAGMA behavior + WAL mode verification

### Claude's Discretion
- Exact TypeScript interface shape for each repo (as long as `D-22` intent-naming holds)
- Whether to use a single `db.ts` file or a folder layout under `src/db/`
- nanoid vs ulid for IDs (both OK; pick one and use throughout — D-35 reserves the slot)
- **D-35:** ID generator picked by planner — any ≥128-bit URL-safe ID scheme (nanoid default, ulid acceptable)

</decisions>

<specifics>
## Specific Ideas

- Attachment dedup by sha256 is deliberate — reference: git object store pattern, IPFS content addressing.
- `inboxes.domain` column is carried forward even though v1 is single-domain — costs nothing now, saves a schema migration later.
- `abuse_counters.ip_prefix` stores `/24` for IPv4 and `/64` for IPv6 — stronger abuse signal than raw IP, avoids fragmenting counters across mobile carrier pools.

</specifics>

<canonical_refs>
## Canonical References

### Roadmap and requirements
- `.planning/PROJECT.md` — core value, constraints, out-of-scope
- `.planning/REQUIREMENTS.md` §Storage (STORE-01..04) — the phase's requirement contract
- `.planning/ROADMAP.md` §Phase 2 — phase goal and success criteria

### Research (already done — do not re-research)
- `.planning/research/STACK.md` — locks `better-sqlite3`, PRAGMAs, Node 22 LTS
- `.planning/research/ARCHITECTURE.md` — storage component responsibilities + hash-shard layout
- `.planning/research/PITFALLS.md` — inode exhaustion, disk watermark, blob-in-DB anti-pattern
- `.planning/research/SUMMARY.md` — cross-stream convergence summary

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield. No existing codebase.

### Patterns to Follow
- None yet — Phase 2 sets the patterns subsequent phases follow.

### Known Gotchas
- Windows + `better-sqlite3` prebuilds: ensure `npm rebuild` works on target platform; dev on Windows, deploy on Linux — use `node-gyp` prebuilt binaries from npm, no manual compile expected.
- WAL files (`*.db-wal`, `*.db-shm`) live next to the DB file — ignore in backups OR checkpoint before copy.
- SQLite's `PRAGMA foreign_keys=ON` must be set on every connection (not stored in the DB file).

</code_context>

<specifics>
## Deferred Ideas

- Backup/restore tooling (v2)
- Read-only replica for reporting (v2+)
- Encryption-at-rest via SQLCipher (v2 — maybe; costs complexity for a service that holds ephemeral data)

</specifics>
