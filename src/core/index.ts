/**
 * Phase 3 composition root.
 *
 * Exports `createCore(deps)` — the single factory external adapters (Phase 4
 * SMTP, Phase 5 HTTP/SSE, Phase 6 sweeper) call at process startup to wire the
 * bus + inboxes + messages modules into one object. Exactly one bus is
 * instantiated per call; the returned `core.bus` is the object the SSE handler
 * subscribes to.
 *
 * No direct `better-sqlite3`, no `node:fs`, no `db.prepare`/`db.exec` here —
 * enforced by `tests/core/no-direct-db.test.ts` (D-03).
 */

import type { AttachmentStore } from '../attachments/index.js';
import type { Db } from '../db/client.js';
import type { Repos } from '../db/repos/index.js';
import { type Bus, createBus } from './bus.js';
import { type InboxesApi, createInboxes } from './inboxes.js';
import { type MessagesApi, createMessages } from './messages.js';

export interface CoreConfig {
  /** Single domain for v1 (multi-domain is deferred per CONTEXT.md). */
  domain: string;
  /** Sliding idle TTL in ms (RETN-01 default: 10 * 60 * 1_000 in prod). */
  idleTtlMs: number;
  /** Absolute hard ceiling in ms (RETN-01 default: 60 * 60 * 1_000 in prod). */
  hardTtlMs: number;
}

export interface CoreDeps {
  db: Db;
  repos: Repos;
  attachmentStore: AttachmentStore;
  config: CoreConfig;
  /** Injectable clock for determinism in tests. Defaults to `nowMs` downstream. */
  now?: () => number;
  /** Injectable id generator for determinism in tests. Defaults to `newId` downstream. */
  id?: () => string;
}

export interface CoreApi {
  /** Shared bus exposed so SSE (Phase 5) can subscribe to 'message' events. */
  readonly bus: Bus;
  createInbox: InboxesApi['createInbox'];
  expireInbox: InboxesApi['expireInbox'];
  ingestMessage: MessagesApi['ingestMessage'];
  listMessages: MessagesApi['listMessages'];
}

/**
 * Wires bus + inboxes + messages into one object.
 *
 * Exactly one bus is created per call; the returned `core.bus` is the object
 * Phase 5's SSE handler will subscribe to. Production callers construct `core`
 * exactly once at startup and share it between the SMTP and HTTP adapters.
 * Tests may construct one per test for isolation.
 */
export function createCore(deps: CoreDeps): CoreApi {
  const bus = createBus();
  const inboxes = createInboxes({
    db: deps.db,
    repos: deps.repos,
    attachmentStore: deps.attachmentStore,
    config: {
      domain: deps.config.domain,
      idleTtlMs: deps.config.idleTtlMs,
      hardTtlMs: deps.config.hardTtlMs,
    },
    now: deps.now,
    id: deps.id,
  });
  const messages = createMessages({
    repos: deps.repos,
    bus,
    config: {
      domain: deps.config.domain,
      idleTtlMs: deps.config.idleTtlMs,
    },
    now: deps.now,
  });

  return {
    bus,
    createInbox: inboxes.createInbox,
    expireInbox: inboxes.expireInbox,
    ingestMessage: messages.ingestMessage,
    listMessages: messages.listMessages,
  };
}

// Re-exports so callers only need to import from 'src/core/index.js'.
export type { Bus, BusEvents, MessageEvent } from './bus.js';
export type { CreateInboxResult, ExpireInboxResult, InboxesApi } from './inboxes.js';
export type {
  AttachmentView,
  IngestAttachmentInput,
  IngestInput,
  IngestResult,
  ListMessagesInput,
  ListMessagesResult,
  MessageView,
  MessagesApi,
} from './messages.js';
