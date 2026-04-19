import type { Db } from '../client.js';
import { type AbuseRepo, createAbuseRepo } from './abuse-repo.js';
import { type AttachmentRepo, createAttachmentRepo } from './attachment-repo.js';
import { type InboxRepo, createInboxRepo } from './inbox-repo.js';
import { type MessageRepo, createMessageRepo } from './message-repo.js';

/**
 * Aggregate of all four repositories, wired to a single `Db` handle.
 *
 * Usage:
 *   const db = openDb('./data/tempmail.db');
 *   const repos = createRepos(db);
 *   const inbox = repos.inboxes.createInbox({...});
 *
 * Every repo caches its prepared statements on first call and reuses them
 * for the lifetime of the `Db` handle (D-19, D-21).
 */
export interface Repos {
  inboxes: InboxRepo;
  messages: MessageRepo;
  attachments: AttachmentRepo;
  abuse: AbuseRepo;
}

export function createRepos(db: Db): Repos {
  return {
    inboxes: createInboxRepo(db),
    messages: createMessageRepo(db),
    attachments: createAttachmentRepo(db),
    abuse: createAbuseRepo(db),
  };
}

// Re-export the per-repo types so callers can write
//   `function handle(repos: Repos) { ... }`
// or
//   `function save(r: InboxRepo, input: NewInbox) { ... }`
// without a deeper import path.
export type { InboxRepo, NewInbox } from './inbox-repo.js';
export type {
  MessageRepo,
  NewMessage,
  NewAttachment,
  InsertResult,
} from './message-repo.js';
export type { AttachmentRepo } from './attachment-repo.js';
export type { AbuseRepo } from './abuse-repo.js';
