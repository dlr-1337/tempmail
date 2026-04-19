/**
 * Public barrel for the attachment store.
 *
 * External callers (SMTP ingestion, HTTP attachment-download, orphan reaper)
 * import from `./attachments` and never reach into `./store` or `./paths`
 * directly. Keeps the module boundary sharp: everything a caller needs is
 * listed here.
 */

export { isValidSha256Hex, shardPath } from './paths.js';
export {
  type AttachmentStore,
  type StatResult,
  type WriteResult,
  createAttachmentStore,
} from './store.js';
