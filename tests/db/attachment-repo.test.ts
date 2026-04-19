import { describe, expect, it } from 'vitest';
import type { Repos } from '../../src/db/repos/index.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

function seedInboxWithMessages(repos: Repos) {
  const exp = 9_999_999_999;
  const inbox = repos.inboxes.createInbox({
    local_part: 'x',
    domain: 'd.test',
    view_token_hash: 'h',
    expires_at: exp,
    hard_expires_at: exp,
  });
  const m1 = repos.messages.insertMessageWithAttachments(
    {
      inbox_id: inbox.id,
      sender: null,
      subject: null,
      text_body: null,
      html_body_sanitized: null,
      size_bytes: 0,
      envelope_from: null,
      envelope_to: null,
      headers_json: null,
    },
    [
      {
        filename: 'a',
        content_type: 'text/plain',
        size_bytes: 1,
        sha256: 'a'.repeat(64),
        storage_path: 'aa/aa/...',
      },
    ],
  );
  const m2 = repos.messages.insertMessageWithAttachments(
    {
      inbox_id: inbox.id,
      sender: null,
      subject: null,
      text_body: null,
      html_body_sanitized: null,
      size_bytes: 0,
      envelope_from: null,
      envelope_to: null,
      headers_json: null,
    },
    [
      {
        filename: 'b',
        content_type: 'text/plain',
        size_bytes: 2,
        sha256: 'b'.repeat(64),
        storage_path: 'bb/bb/...',
      },
      // Same sha as m1's attachment — dedup case
      {
        filename: 'a-dup',
        content_type: 'text/plain',
        size_bytes: 1,
        sha256: 'a'.repeat(64),
        storage_path: 'aa/aa/...',
      },
    ],
  );
  return { inbox, m1, m2 };
}

describe('attachmentRepo (STORE-04)', () => {
  it('findAttachmentById returns the row', () => {
    const { repos } = openTestDbWithRepos();
    const { m1 } = seedInboxWithMessages(repos);
    const attId = m1.attachmentIds[0];
    expect(attId).toBeDefined();
    if (!attId) return;
    const row = repos.attachments.findAttachmentById(attId);
    expect(row?.sha256).toBe('a'.repeat(64));
  });

  it('listAttachmentsByMessage returns all attachments for a message', () => {
    const { repos } = openTestDbWithRepos();
    const { m2 } = seedInboxWithMessages(repos);
    const atts = repos.attachments.listAttachmentsByMessage(m2.messageId);
    expect(atts).toHaveLength(2);
  });

  it('listAllSha256s returns a deduped Set across all messages', () => {
    const { repos } = openTestDbWithRepos();
    seedInboxWithMessages(repos);
    const shas = repos.attachments.listAllSha256s();
    expect(shas.size).toBe(2); // 'a'*64 appears twice but dedups in the Set
    expect(shas.has('a'.repeat(64))).toBe(true);
    expect(shas.has('b'.repeat(64))).toBe(true);
  });

  it("deleteAttachmentsByMessage removes only that message's attachments", () => {
    const { repos } = openTestDbWithRepos();
    const { m1, m2 } = seedInboxWithMessages(repos);
    expect(repos.attachments.deleteAttachmentsByMessage(m1.messageId)).toBe(1);
    expect(repos.attachments.listAttachmentsByMessage(m1.messageId)).toHaveLength(0);
    expect(repos.attachments.listAttachmentsByMessage(m2.messageId)).toHaveLength(2);
  });
});
