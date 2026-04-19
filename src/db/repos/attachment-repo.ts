import type { Db } from '../client.js';
import type { AttachmentRow } from '../types.js';

export interface AttachmentRepo {
  /** Returns one attachment row or undefined. Used by `GET /api/attachments/:id`. */
  findAttachmentById(id: string): AttachmentRow | undefined;

  /** All attachments for a message, in insertion order. */
  listAttachmentsByMessage(messageId: string): readonly AttachmentRow[];

  /**
   * Returns every sha256 currently referenced by the attachments table.
   * Used by the hourly orphan reaper (Phase 6): anything on disk whose sha256
   * is not in this set is dead weight.
   *
   * Returns a Set for O(1) membership test at the reaper's call site.
   */
  listAllSha256s(): ReadonlySet<string>;

  /** Deletes all attachment rows for a message. Returns rows deleted.
   *  Note: FK CASCADE from messages already does this when a message is deleted;
   *  this method exists for callers that delete a message but want to know
   *  which attachment sha256s were orphaned so they can unlink on disk. */
  deleteAttachmentsByMessage(messageId: string): number;
}

export function createAttachmentRepo(db: Db): AttachmentRepo {
  const findByIdStmt = db.prepare<[string], AttachmentRow>(`
    SELECT id, message_id, filename, content_type, size_bytes, sha256, storage_path
    FROM attachments WHERE id = ?
  `);

  const listByMessageStmt = db.prepare<[string], AttachmentRow>(`
    SELECT id, message_id, filename, content_type, size_bytes, sha256, storage_path
    FROM attachments WHERE message_id = ?
    ORDER BY id ASC
  `);

  const listShaStmt = db.prepare<[], { sha256: string }>('SELECT DISTINCT sha256 FROM attachments');

  const deleteByMessageStmt = db.prepare<[string]>('DELETE FROM attachments WHERE message_id = ?');

  return {
    findAttachmentById(id) {
      return findByIdStmt.get(id);
    },
    listAttachmentsByMessage(messageId) {
      return listByMessageStmt.all(messageId);
    },
    listAllSha256s() {
      const rows = listShaStmt.all();
      const set = new Set<string>();
      for (const r of rows) set.add(r.sha256);
      return set;
    },
    deleteAttachmentsByMessage(messageId) {
      return deleteByMessageStmt.run(messageId).changes;
    },
  };
}
