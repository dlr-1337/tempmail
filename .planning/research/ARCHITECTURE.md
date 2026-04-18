# Architecture Research

**Domain:** Self-hosted public disposable email (tempmail) service — receive-only, anonymous, ephemeral inboxes on a single small VPS (~1-2 GB RAM, 1 vCPU)
**Researched:** 2026-04-18
**Confidence:** HIGH (architecture patterns are well-established across multiple reference implementations; single-VPS sizing is conservative)

## Standard Architecture

Tempmail systems have a consistent shape across reference implementations (elbunuelo/tempmail, synox/disposable-mailbox, ahem, mail.tm-style services). The pattern:

1. **Inbound MTA** listens on port 25, accepts SMTP, hands each raw message to an application process.
2. **Application process** parses MIME, persists to a store, and pushes a real-time event to any browser subscribed to that inbox.
3. **Web API + UI** serves HTTP/HTTPS on 80/443 via a reverse proxy, exposes inbox creation, message listing, message read, and a real-time stream endpoint.
4. **Periodic sweeper** prunes expired inboxes and their messages/attachments.

Everything runs on one box. The two concurrency realities to design around are:

- Port 25 must be reachable from the public internet (inbound not outbound). Most VPS providers allow inbound 25; outbound 25 is commonly blocked but that's not needed here (receive-only).
- Email bodies can be tens of KB to several MB. The parser must stream, not buffer whole messages in RAM, or a single 25 MB attachment from one connection eats a measurable chunk of a 1 GB VPS.

### System Overview

```
                   Internet                                  Browser
                       |                                        |
                       | port 25 (SMTP)          port 443 (HTTPS, HTTP/2)
                       v                                        v
           +---------------------+                 +---------------------------+
           |   SMTP Ingestion    |                 |   Reverse Proxy (Caddy)   |
           |  (smtp-server /     |                 |   TLS term + Let's Encrypt|
           |   Haraka)           |                 |   HTTP/3, SSE passthrough |
           +----------+----------+                 +------+----------+---------+
                      |                                   |          |
                      | raw RFC 5322 stream               | /api/*   | /stream/:inbox
                      v                                   v          v
           +---------------------+             +-------------------------------+
           |  Parser Pipeline    |             |   Web App (Node / Fastify)    |
           |  (mailparser        |             |   - REST endpoints            |
           |   simpleParser)     |             |   - SSE publisher             |
           +----------+----------+             +------+----------------+-------+
                      |                               |                |
                      | structured record             | queries        | subscribe
                      | + attachment streams          v                ^
                      |                    +------------------+        |
                      +------------------->|   Core Logic /   |<-------+
                                           |   Event Bus      |
                                           |  (EventEmitter)  |
                                           +---------+--------+
                                                     |
                        +----------------------------+---------------------------+
                        |                            |                           |
                        v                            v                           v
              +---------------------+     +---------------------+     +---------------------+
              |  SQLite (WAL mode)  |     |  Attachment Blobs   |     |  Expiry Sweeper     |
              |  inboxes, messages, |     |  on disk            |     |  setInterval / cron |
              |  abuse counters     |     |  /var/data/attach/  |     |  TTL-based purge    |
              +---------------------+     +---------------------+     +---------------------+
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation | Input | Output |
|-----------|----------------|------------------------|-------|--------|
| **DNS (MX + A)** | Tells the world where to deliver mail for the domain | User-configured at registrar | DNS query | `mx.example.com` → VPS IP |
| **SMTP Ingestion** | Accept TCP on port 25, speak SMTP, validate recipient, stream raw message to parser | `smtp-server` (npm), Haraka, or Postfix+LMTP | SMTP session on :25 | Raw RFC 5322 stream + envelope (MAIL FROM / RCPT TO) |
| **Parser** | Decode MIME, extract headers, text/HTML bodies, attachments | `mailparser.simpleParser` or streaming `MailParser` | Raw byte stream | Structured `ParsedMail` + attachment streams |
| **Core/API** | Owns business rules: inbox creation, message persistence, rate limits, retention | Node.js with Fastify or Hono | HTTP requests / parser callbacks | JSON responses / DB writes / SSE events |
| **Data Store** | Persist inboxes, messages, counters; enforce unique constraints | SQLite in WAL mode | SQL writes | SQL reads |
| **Attachment Store** | Hold binary blobs (don't jam into SQLite) | Filesystem directory, filename = SHA-256 or UUID | Readable streams | Readable streams on read |
| **Event Bus** | Fan out "new message" to subscribed SSE clients | In-process `EventEmitter` keyed by inbox ID | `publish(inboxId, msg)` | `.on('inbox:<id>')` listeners |
| **Reverse Proxy** | TLS termination, HTTP/2, static asset serving, SSE flush passthrough | Caddy (preferred) or nginx | HTTPS :443 | Proxied to app on localhost |
| **Expiry Sweeper** | Delete expired inboxes, messages, orphaned attachments | `setInterval` in-process or system cron | Clock tick | DB DELETEs + file unlinks |
| **Abuse Layer** | Per-IP rate limits at both SMTP and HTTP edges | In-memory LRU counters + SQLite-backed long-term counters | IP, action | Allow / reject |

## Recommended Project Structure

```
tempmail/
├── docker-compose.yml        # Single file, 1-2 services
├── Caddyfile                 # Reverse proxy + auto-HTTPS config
├── .env.example              # DOMAIN, RETENTION_MINUTES, MAX_MSG_SIZE, etc.
├── data/                     # Host-mounted volume
│   ├── tempmail.db           # SQLite file (+ -wal, -shm)
│   └── attachments/          # Blobs, subdir-sharded by first 2 hex of hash
├── src/
│   ├── index.ts              # Entry: starts SMTP server + HTTP server + sweeper
│   ├── config.ts             # Env parsing, single source of truth for tunables
│   ├── smtp/
│   │   ├── server.ts         # smtp-server instance, onData hook
│   │   ├── validate.ts       # Recipient check, size cap, rate limit
│   │   └── parse.ts          # Wraps mailparser, returns normalized record
│   ├── http/
│   │   ├── server.ts         # Fastify app wiring
│   │   ├── routes/
│   │   │   ├── inbox.ts      # POST /api/inbox (create), GET /api/inbox/:id
│   │   │   ├── messages.ts   # GET /api/inbox/:id/messages, GET .../messages/:msgId
│   │   │   ├── attachments.ts# GET /api/attachments/:id (streamed)
│   │   │   └── stream.ts     # GET /api/inbox/:id/stream (SSE)
│   │   └── middleware/
│   │       ├── ratelimit.ts  # IP-based, token bucket
│   │       └── auth.ts       # Inbox-token check (bearer-ish)
│   ├── core/
│   │   ├── inbox.ts          # createInbox, getInbox, expireInbox
│   │   ├── messages.ts       # ingest, list, get, delete
│   │   ├── events.ts         # EventEmitter singleton, publish/subscribe helpers
│   │   └── retention.ts      # Sweeper: findExpired, purgeInbox, purgeOrphans
│   ├── db/
│   │   ├── schema.sql        # CREATE TABLE inboxes, messages, attachments, abuse_counters
│   │   ├── migrations/       # Numbered .sql files
│   │   └── client.ts         # better-sqlite3 wrapper with prepared stmts
│   └── util/
│       ├── address.ts        # Random local-part generator (readable, no-collision)
│       ├── hash.ts           # SHA-256 helpers for attachment dedup
│       └── log.ts            # Structured logging (pino)
├── public/                   # Static UI assets (or served from Vite build output)
└── web/                      # Frontend (Svelte/React/plain) — separate build
    └── dist/                 # Built assets, served by Caddy directly
```

### Structure Rationale

- **`src/smtp/` vs `src/http/`:** Two totally different protocols and threat profiles (port 25 is inherently public-internet; port 443 is browser-origin). Keeping them side-by-side makes it obvious where each security boundary lives. Both import from `src/core/` — the business logic — so they can't diverge on what "ingest a message" means.
- **`src/core/events.ts`:** Singleton EventEmitter. SMTP ingestion writes to the DB then calls `events.publish('inbox:abc', msg)`. The `/stream/:id` SSE handler does `events.on('inbox:abc', send)`. No external broker needed; everything's in one process.
- **`data/` as a mounted volume:** Makes backup trivial (`tar czf backup.tgz data/`) and means the container is disposable. The database file, WAL, and attachments all live under one root.
- **`web/` is separate:** Frontend is a static SPA. Caddy serves it directly; the Node process only handles `/api/*` and `/stream/*`. This halves the Node memory footprint and avoids SSR complexity.
- **Monolithic Node process:** On a 1 GB VPS you cannot afford 4 microservices each with their own V8 heap. One Node process that runs the SMTP listener, HTTP server, event bus, and interval-based sweeper is correct here.

## Architectural Patterns

### Pattern 1: Stream-Don't-Buffer at the SMTP Boundary

**What:** The `onData` callback of `smtp-server` hands you a `Readable` stream of the raw message. Pipe it straight into `simpleParser` (or the streaming `MailParser`), which emits attachments as streams — write each attachment stream directly to disk. Never collect the full message into a `Buffer`.

**When to use:** Always, on a small VPS. A 20 MB attachment buffered = 20 MB heap; ten concurrent deliveries = 200 MB, which on a 1 GB VPS is the difference between working and OOM-killed.

**Trade-offs:**
- Pro: Bounded memory regardless of message size.
- Pro: `smtp-server` exposes `stream.sizeExceeded` so you can reject oversize before committing.
- Con: Slightly more complex than "just buffer and parse." Worth it.

**Example:**
```typescript
const server = new SMTPServer({
  size: 10 * 1024 * 1024,               // 10 MB advertised MAXSIZE
  disabledCommands: ['AUTH'],           // receive-only, no AUTH
  onRcptTo(address, session, cb) {
    if (!isOurDomain(address.address)) return cb(new Error('550 Relay denied'));
    if (!inboxExists(localPart(address.address))) return cb(new Error('550 No such user'));
    cb();
  },
  onData(stream, session, cb) {
    simpleParser(stream, { skipHtmlToText: false }, (err, parsed) => {
      if (stream.sizeExceeded) return cb(new Error('552 Message too large'));
      if (err) return cb(new Error('451 Parse error'));
      ingest(session.envelope, parsed)    // writes DB + attachments + publishes event
        .then(() => cb())
        .catch(() => cb(new Error('451 Storage error')));
    });
  },
});
server.listen(25);
```

### Pattern 2: In-Process Pub/Sub for Real-Time Delivery

**What:** Use Node's built-in `EventEmitter` as the message bus. SMTP ingestion publishes. The SSE endpoint subscribes per inbox ID. No Redis, no NATS, no Kafka.

**When to use:** When you have exactly one process handling both ingestion and HTTP. Which, on a single VPS tempmail, you do.

**Trade-offs:**
- Pro: Zero extra infrastructure. Zero network hops. Zero serialization overhead.
- Pro: Naturally scoped to one process — no cross-process coordination bugs.
- Con: Won't fan out across multiple Node processes. If you ever need to scale horizontally you'd swap this for Redis pub/sub — but that's explicitly out of scope for v1.
- Con: Memory leaks if you forget to `off()` on disconnect. The SSE handler must wire cleanup into `req.on('close')`.

**Example:**
```typescript
// src/core/events.ts
import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
bus.setMaxListeners(10_000);   // SSE clients can pile up; default is 10

// ingestion side
bus.emit(`inbox:${inboxId}`, { id: msgId, from, subject, receivedAt });

// SSE side (Fastify)
app.get('/api/inbox/:id/stream', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // belt-and-suspenders for nginx
  });
  const send = (msg) => reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
  const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 15_000);
  bus.on(`inbox:${req.params.id}`, send);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    bus.off(`inbox:${req.params.id}`, send);
  });
});
```

### Pattern 3: Attachments on Disk, Metadata in SQL

**What:** Store attachment blobs as files in a sharded directory (`/data/attachments/ab/cd/abcd1234...`). Store their SHA-256, original filename, content-type, and size as a row in an `attachments` table FK'd to `messages`. The file's path is derived from its hash.

**When to use:** Always, for any binary content over ~16 KB. SQLite CAN store blobs, but it makes the DB file bloat, backups slow, and VACUUM expensive.

**Trade-offs:**
- Pro: Database file stays small (kilobytes per message, not megabytes). Cheap to back up, cheap to VACUUM.
- Pro: Hash-addressed files give you free dedup across inboxes (rare but free).
- Pro: Streaming a download = just `createReadStream(path)`. No DB pressure.
- Con: Two places to purge on expiry — the DB row AND the file. The sweeper must handle both, and handle the case where one succeeds and the other fails (orphan reaper pass).

**Example:**
```typescript
// Ingest path
const hash = createHash('sha256');
const tmpPath = `/data/attachments/.incoming/${randomUUID()}`;
const out = createWriteStream(tmpPath);
attachmentStream.on('data', (c) => hash.update(c));
await pipeline(attachmentStream, out);
const digest = hash.digest('hex');
const finalPath = `/data/attachments/${digest.slice(0,2)}/${digest.slice(2,4)}/${digest}`;
await mkdir(dirname(finalPath), { recursive: true });
await rename(tmpPath, finalPath);     // atomic on same FS
db.prepare('INSERT INTO attachments ...').run({ messageId, digest, filename, size, contentType });
```

### Pattern 4: Two-Tier Rate Limiting

**What:** Rate-limit at BOTH the SMTP and HTTP edges, with different keys and different limits.

- SMTP side: limit per **client IP** (the sending MTA's IP). Cap deliveries-per-minute to a sane number like 60. Reject with `421` (temporary failure) to get well-behaved senders to back off.
- HTTP side: limit per **client IP** for inbox creation (e.g. 5 new inboxes per minute per IP) and per **inbox token** for reads (prevents scraping every inbox).

**When to use:** Always. A public tempmail without rate limits becomes a spam ingestion lab within 48 hours.

**Trade-offs:**
- Pro: Abuse containment from day one.
- Con: Need an in-memory structure (LRU-keyed token bucket) that survives restarts "well enough." For permanent bans, back it with a SQLite `abuse_counters` table.

### Pattern 5: Lazy Expiry + Periodic Sweep

**What:** Every inbox has an `expires_at` column. Reads check it and return `410 Gone` if past. A background sweeper runs every minute and hard-deletes expired inboxes, their messages, and their attachment files.

**When to use:** Always, for any TTL-based system. Combining lazy (per-request) and active (sweeper) expiry means nobody sees stale data AND the DB doesn't bloat.

**Trade-offs:**
- Pro: No race where a just-expired inbox serves one last request.
- Pro: Physical disk use stays bounded.
- Con: The sweeper must be idempotent and safe to run concurrently with reads.

## Data Flow

### Inbound Mail Flow (most critical path)

```
External sender
     |
     | DNS: MX mail.example.com.
     v
Their MTA connects TCP :25 to VPS IP
     |
     | HELO / MAIL FROM / RCPT TO
     v
[SMTP Ingestion] validates recipient exists in inboxes table
     |
     | DATA: streamed raw RFC 5322 bytes
     v
[Parser] mailparser.simpleParser (streaming)
     |
     +---> attachments piped to /data/attachments/<hash>
     |
     v
[Core] insert message row, insert attachment rows
     |
     +---> publish event: bus.emit('inbox:<id>', {msgId, from, subject})
     |
     v
SMTP 250 OK returned to sender

             (meanwhile...)

Browser holds open GET /api/inbox/<id>/stream (SSE)
     ^
     | event delivered as: data: {"id":"...","from":"...","subject":"..."}\n\n
     |
[Core] event bus listener writes to SSE response stream
```

### API Request Flow

```
Browser: POST /api/inbox
     |
     v
[Caddy] TLS term -> proxy to localhost:3000
     |
     v
[Fastify] ratelimit middleware (by IP)
     |
     v
[Core] generateAddress() -> INSERT inbox -> return {address, token, expiresAt}
     |
     v
[Response] JSON -> browser stores token in localStorage

---

Browser: GET /api/inbox/<id>/messages  (Authorization: Bearer <token>)
     |
     v
[Fastify] auth middleware: token matches inbox.token AND inbox.expires_at > now
     |
     v
[Core] SELECT messages WHERE inbox_id = ? ORDER BY received_at DESC LIMIT 50
     |
     v
[Response] JSON array

---

Browser: GET /api/attachments/<id>  (Authorization: Bearer <inbox-token>)
     |
     v
[Fastify] auth: attachment -> message -> inbox -> token match
     |
     v
[Core] createReadStream('/data/attachments/ab/cd/abcd...')
     |
     v
[Response] piped stream with Content-Type + Content-Disposition
```

### Expiry Flow

```
setInterval(60_000)
     |
     v
[Sweeper] SELECT id FROM inboxes WHERE expires_at < now LIMIT 100
     |
     v
For each expired inbox:
  BEGIN TRANSACTION
    SELECT attachment paths for all its messages
    DELETE FROM messages WHERE inbox_id = ?
    DELETE FROM inboxes WHERE id = ?
  COMMIT
  unlink() each attachment path (ignore ENOENT)
     |
     v
Orphan pass (once per hour): walk /data/attachments, DELETE files with no DB row
```

### Schema Sketch

```sql
CREATE TABLE inboxes (
  id           TEXT PRIMARY KEY,            -- short random, e.g. 10 char base32
  address      TEXT NOT NULL UNIQUE,        -- local-part@domain
  token        TEXT NOT NULL,               -- bearer secret, 32+ bytes
  created_at   INTEGER NOT NULL,            -- unix ms
  expires_at   INTEGER NOT NULL,            -- unix ms; bumped on reads if sliding TTL
  created_ip   TEXT                         -- for abuse tracking; nullable
);
CREATE INDEX idx_inboxes_expires ON inboxes(expires_at);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  inbox_id     TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  received_at  INTEGER NOT NULL,
  from_addr    TEXT,
  to_addr      TEXT,
  subject      TEXT,
  text_body    TEXT,
  html_body    TEXT,
  size_bytes   INTEGER NOT NULL,
  sender_ip    TEXT                         -- connecting MTA IP
);
CREATE INDEX idx_messages_inbox ON messages(inbox_id, received_at DESC);

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL                -- used for on-disk path
);

CREATE TABLE abuse_counters (
  key          TEXT PRIMARY KEY,            -- e.g. "ip:1.2.3.4:inbox-create"
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- WAL mode for concurrent reads alongside the ingestion writer
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

## Scaling Considerations

The project scope (single VPS, receive-only, ephemeral data) caps realistic scale. Don't engineer past it.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0–1k daily active inboxes | Default stack as described. SQLite WAL handles single-writer ingestion + many SSE reader connections fine. |
| 1k–10k daily active | Tune: bump `ulimit -n` (many SSE connections), set `PRAGMA cache_size = -64000` (64 MB), shard attachments by first 2 hex chars (already in design). Consider moving Caddy access logs off the hot disk. Still one VPS. |
| 10k+ daily active | You have a hit product. At this point: move to a bigger VPS first (vertical scaling is cheap up to ~8 GB). Only split if you hit real bottlenecks — likely not SQLite, likely port 25 ingestion CPU (MIME parsing) or SSE connection count. At that point, split SMTP ingestion to its own process behind a local socket, and consider replacing the EventEmitter bus with Redis Pub/Sub so you can run 2+ HTTP processes. This is explicitly v2+ territory. |

### Scaling Priorities

1. **First bottleneck: SSE connection count vs. `ulimit -n`.** Default Linux ulimits are 1024 open FDs per process. Each SSE client = 1 FD. Raise to 65535 in systemd unit or Docker. Free fix.
2. **Second bottleneck: attachment disk I/O during sweeps.** Under load the periodic sweep can hammer the disk. Mitigation: rate-limit deletions inside the sweeper (100 per tick), and don't fsync on unlink.
3. **Third bottleneck: MIME parse CPU.** Each inbound message parses a full MIME tree, including HTML-to-text. A single vCPU can parse ~50-100 messages/sec of typical size; this is usually fine. If it isn't, offload parsing to a worker thread.
4. **SQLite write contention is NOT the bottleneck** at this scale. WAL mode lets readers run concurrently with the single writer; tempmail writes are modest (one INSERT per message, a few INSERTs for attachments).

## Anti-Patterns

### Anti-Pattern 1: Running Postfix as the Whole Stack

**What people do:** Install Postfix + Dovecot, create system users for each "inbox," parse mail by tailing Maildir directories.
**Why it's wrong:** Postfix is an MTA meant to deliver mail to persistent mailboxes for real users. Ephemeral random inboxes fight its model at every turn — you'd be creating and deleting system users, or wiring up virtual user maps backed by a DB that Postfix reloads on change. It's an enormous amount of config for functionality you don't need. Postfix also does not natively give you a "call my app when a message arrives" hook without more glue (LMTP, a pipe transport, etc.).
**Do this instead:** Use a library-grade SMTP server (`smtp-server` from the Nodemailer project, or Haraka if you want a richer plugin system) that hands you the raw stream in-process. Your app IS the MTA for this use case.

### Anti-Pattern 2: Storing Attachments as SQLite BLOBs

**What people do:** `INSERT INTO attachments (content) VALUES (?)` with 5 MB Buffers.
**Why it's wrong:** The DB file balloons to gigabytes. `VACUUM` becomes a 30-second stall. Backups become slow. Attachment streaming on read means loading the whole blob into memory.
**Do this instead:** Hash-addressed files on disk, metadata row in SQLite. The DB stays small and fast; attachment reads are `fs.createReadStream`.

### Anti-Pattern 3: Polling the API for New Messages

**What people do:** Frontend does `setInterval(fetch('/messages'), 2000)`.
**Why it's wrong:** "Feels instant" is a core value in PROJECT.md. 2s polling gives 0-2s latency (median 1s). It also means every open tab does 30 requests/minute even when idle — which the rate limiter then has to distinguish from abuse. And the VPS burns CPU on mostly-empty responses.
**Do this instead:** SSE (`EventSource`). One long-lived connection per tab, server push, auto-reconnect built in, no extra libraries needed in the browser. For tempmail specifically, SSE is a better fit than WebSocket because traffic is one-way (server → client); new messages arrive, clicks go through separate REST calls.

### Anti-Pattern 4: Using Catch-All + IMAP

**What people do:** Configure Postfix catch-all to forward `*@example.com` to one IMAP mailbox, then have the webapp IMAP-poll that mailbox.
**Why it's wrong:** Mixes two storage systems (IMAP + app DB) and introduces polling latency and concurrency headaches. Fine as a quick-and-dirty prototype (synox/disposable-mailbox does this), but it's structurally inferior to direct SMTP ingestion — you lose the ability to apply per-recipient policies at SMTP time (reject unknown recipients, reject oversize) and you move expiry logic into a sync job.
**Do this instead:** Direct SMTP ingestion where the app process IS the mail receiver.

### Anti-Pattern 5: Terminating TLS Inside the Node Process

**What people do:** Have Node load the cert and bind :443 directly.
**Why it's wrong:** You'd reimplement certificate renewal, OCSP stapling, HTTP/2, HTTP/3, and static asset serving, all for no benefit. You'd also couple restarts-for-config-changes to restarts-for-code-changes.
**Do this instead:** Caddy in front. It handles Let's Encrypt automatically, serves static assets directly (no round-trip to Node for `/app.js`), reloads config without dropping connections, and is ~15 MB of RAM. Proxy `/api/*` and `/stream/*` to Node on localhost. Explicitly disable response buffering for the SSE route (`flush_interval -1` in Caddy).

### Anti-Pattern 6: Ignoring Idle TCP Timeouts on SMTP and SSE

**What people do:** Leave default timeouts. Eventually ISP NATs and cloud load balancers sever "idle" long-lived connections.
**Why it's wrong:**
- SMTP: A stingy `socketTimeout` drops slow-but-legitimate senders mid-DATA.
- SSE: Without periodic heartbeats, intermediaries close the socket after 30-120 seconds. Browser reconnects, but you burn cycles churning.
**Do this instead:**
- SMTP: `socketTimeout: 60_000`, `closeTimeout: 30_000` in `smtp-server` options. Haraka defaults are sane.
- SSE: Write a comment line `: heartbeat\n\n` every 15 seconds. Set `Connection: keep-alive` and `X-Accel-Buffering: no`. Set `reply.raw.socket.setNoDelay(true)`.

### Anti-Pattern 7: Trusting the Client-Declared Inbox Lifetime

**What people do:** Let the browser pick its own expiry and store it in a cookie.
**Why it's wrong:** Trivially bypassed. A persistent inbox defeats the product.
**Do this instead:** Server assigns `expires_at` at creation time, caps it (e.g. 1 hour max, 10 min default), and refuses to bump it past the cap on reads.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| DNS registrar | User configures MX + A records manually | MX: `mail.example.com. 3600 IN MX 10 mx.example.com.` + A: `mx.example.com. 3600 IN A <VPS_IP>`. MX MUST point to a hostname (A record), never an IP directly. TTL short during rollout (300s) so you can change without long waits. |
| Let's Encrypt | Caddy auto-manages via ACME HTTP-01 challenge on :80 | Requires port 80 open. One-time DNS propagation delay on first provision. |
| VPS provider | Must allow inbound TCP :25, :80, :443 | **Outbound :25 doesn't matter** for this project (receive-only). Check provider docs — Hetzner, DO, OVH, Linode all allow inbound :25 by default; some require support ticket to open **outbound** but inbound is fine. |
| External MTAs | Speak SMTP to our :25 | They may retry for days on `4xx` responses. Use `451`/`421` (temporary) for transient problems, `5xx` (permanent) for "no such user" or "too large" so they stop. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| SMTP server ↔ Core | Direct function call with streams | In-process; no serialization. `onData(stream, session, cb)` is the contract. |
| Core ↔ DB | `better-sqlite3` prepared statements (sync) | Synchronous API is intentional — for a single-writer workload it's faster than async wrappers and trivially easier to reason about. |
| Core ↔ Attachment store | Node `fs` streams | Write to `.incoming/` + `rename()` for atomicity. |
| Core ↔ SSE clients | `EventEmitter` in-process pub/sub | Keyed by `inbox:<id>`. Remember to `off()` on disconnect. |
| HTTP ↔ SMTP | Neither talks to the other directly | Both go through Core. No cross-boundary coupling. |
| Caddy ↔ Node | Reverse proxy over `localhost:3000` | Node binds to `127.0.0.1` only, never public interface. Caddy is the only public HTTP surface. |

## Build Order (with hard dependencies)

This is the order a roadmap should slot phases into. Each item cannot be meaningfully built or tested until its prerequisites exist.

**0. Infrastructure prerequisites (not code, but block everything)**
   - Domain purchased, DNS control confirmed.
   - VPS provisioned, public IP known.
   - Provider confirmed to allow inbound :25.
   - A record and MX record configured, resolving globally. Verify with `dig MX example.com @8.8.8.8`.
   - **Blocks: all downstream phases** that need real inbound mail.

**1. Data model + storage layer (no dependencies)**
   - SQLite schema + migrations.
   - `db/client.ts` wrapper with prepared statements.
   - Unit test: insert inbox, insert message, query.
   - **Enables:** everything that reads/writes state. Can be built and tested in isolation.

**2. Core domain logic (depends on 1)**
   - `createInbox`, `ingestMessage`, `listMessages`, `expireInbox`.
   - Pure functions / class methods — no SMTP, no HTTP yet.
   - Unit-testable with fixture `ParsedMail` objects.
   - **Enables:** both protocol adapters. Decoupling this from the adapters is what makes the system testable.

**3. HTTP API (depends on 2)**
   - Fastify app, routes for inbox CRUD and message listing.
   - Event bus + SSE endpoint.
   - Rate-limit middleware.
   - **Testable without real SMTP:** seed the DB via core functions, `curl` the endpoints.
   - **Enables:** frontend work to start in parallel with step 4.

**4. SMTP ingestion (depends on 2)**
   - `smtp-server` wired to core.
   - Streaming parser, attachment-to-disk.
   - **Testable locally** by pointing `telnet localhost 25` or `swaks` at it with fake MAIL FROM / RCPT TO. Does NOT require DNS to be live.
   - **Enables:** end-to-end internal testing on localhost.

**5. End-to-end testing on VPS (depends on 0, 3, 4)**
   - Deploy Docker Compose.
   - Send real mail from Gmail / a test account. Verify it lands. This is the first time you find out if your MX is actually reachable.
   - **Enables:** everything downstream.

**6. Reverse proxy + TLS (depends on 5 internal flow working)**
   - Caddyfile with auto-HTTPS.
   - Proxy rules for `/api/*`, `/stream/*`, static assets.
   - SSE passthrough verified (no buffering).

**7. Frontend (can start in parallel with 4, needs 3 deployed to finish)**
   - Static SPA, calls `/api/inbox`, opens `EventSource` to `/api/inbox/:id/stream`.
   - Copy-to-clipboard, mobile-friendly CSS.

**8. Expiry sweeper (depends on 1, 2)**
   - `setInterval` running inside the main process OR a separate small script triggered by system cron.
   - Can be built any time after step 2. Recommended to ship with step 5 so you don't accumulate garbage during dogfooding.

**9. Abuse mitigation (depends on 3, 4)**
   - IP-based rate limits at HTTP edge.
   - IP-based rate limits at SMTP edge.
   - Abuse counters persisted in SQLite.
   - Can ship slightly after public launch, but needed early because day-2 spam is guaranteed.

**Critical "easy to get wrong" call-outs for the roadmap:**

- **Port 25 reachability is an environmental gotcha, not a code gotcha.** No amount of code will fix a provider-blocked inbound :25. Verify with `nc -zv <vps-ip> 25` from an external network BEFORE writing SMTP code.
- **MX record must point to a hostname, not an IP.** `example.com. MX 10 1.2.3.4.` is invalid. Create `mx.example.com. A 1.2.3.4.` first, then `example.com. MX 10 mx.example.com.`.
- **MX record must NOT have a trailing-dot mismatch.** Half the "why isn't my mail arriving" threads are FQDN typos.
- **Idle TCP timeouts everywhere.** Default socket timeouts kill long-running SSE streams and slow senders. Set explicit timeouts on `smtp-server` (60s socket, 30s close) and write SSE heartbeats every 15s.
- **Attachment sizing.** Advertise `SIZE` in SMTP `EHLO` response (`smtp-server` does this from its `size` option). External MTAs will not send messages larger than advertised, which is a cheap pre-ingest filter. Set it to 10 MB for a small VPS; bump if users complain about real missed mail.
- **SSE through reverse proxy.** Caddy's `flush_interval` must be negative for SSE; nginx needs `proxy_buffering off; proxy_cache off;` on the SSE location. Forget this and SSE appears broken for no visible reason.
- **ON DELETE CASCADE is not enough.** It cleans the DB rows but NOT the on-disk attachment files. Orphan file reaper is mandatory.
- **Don't put the Node process on port 443 directly.** Run Caddy (or nginx) in front. Node binds loopback only.
- **Single-process means one crash = full outage.** Run under `systemd` with `Restart=always` or use Docker's `restart: unless-stopped`. `pm2` works too but adds a dependency.

## Sources

- [GitHub — elbunuelo/tempmail (reference implementation, Flask + Postfix + Docker)](https://github.com/elbunuelo/tempmail)
- [GitHub — synox/disposable-mailbox (PHP + IMAP catch-all reference, shows the anti-pattern)](https://github.com/synox/disposable-mailbox)
- [GitHub — mjl-/mox (modern full-featured Go mail server, overkill reference)](https://github.com/mjl-/mox)
- [Nodemailer — smtp-server module documentation](https://nodemailer.com/extras/smtp-server)
- [Nodemailer — MailParser / simpleParser documentation](https://nodemailer.com/extras/mailparser)
- [Haraka — Node.js SMTP server](https://haraka.github.io/)
- [Caddy — reverse_proxy directive (flush_interval, WebSocket/SSE support)](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [SSE vs WebSocket vs Long Polling — 2025 comparison](https://dev.to/haraf/server-sent-events-sse-vs-websockets-vs-long-polling-whats-best-in-2025-5ep8)
- [Port 25 blocking by provider — diagnosis and fixes](https://www.captaindns.com/en/blog/port-25-blocked-diagnosis-solutions)
- [Hetzner port 25 policy (inbound allowed by default)](https://j11g.com/2022/01/03/bypassing-hetzner-mail-port-block-port-25-465/)
- [Neilzone — self-hosted disposable email with AHEM](https://neilzone.co.uk/2020/12/self-hosted-disposable-email-addresses-with-ahem/)
- [Forward Email — self-hosted mail server setup guide](https://forwardemail.net/en/self-hosted)
- [SQLite vs PostgreSQL for small services on a single VPS](https://medium.com/the-software-journal/postgresql-vs-sqlite-when-you-should-choose-the-wrong-database-70860f36bfad)

---
*Architecture research for: self-hosted public tempmail on a single small VPS*
*Researched: 2026-04-18*
