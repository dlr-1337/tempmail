import { describe, expect, it } from 'vitest';
import { openTestDbWithRepos } from '../support/db-helper.js';

describe('FK CASCADE (D-09)', () => {
  it('deleting an inbox cascades to messages', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x',
      domain: 'd.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    repos.messages.insertMessageWithAttachments(
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
      [],
    );
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(1);

    repos.inboxes.deleteInbox(inbox.id);
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(0);
  });

  it('deleting an inbox cascades to attachments via messages', () => {
    const { repos } = openTestDbWithRepos();
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x',
      domain: 'd.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    repos.messages.insertMessageWithAttachments(
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
          sha256: 'f'.repeat(64),
          storage_path: 'ff/ff/...',
        },
      ],
    );
    expect(repos.attachments.listAllSha256s().has('f'.repeat(64))).toBe(true);

    repos.inboxes.deleteInbox(inbox.id);
    expect(repos.attachments.listAllSha256s().has('f'.repeat(64))).toBe(false);
  });

  it('deleting a message cascades only to its attachments, not siblings', () => {
    const { repos } = openTestDbWithRepos();
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
          size_bytes: 1,
          sha256: 'b'.repeat(64),
          storage_path: 'bb/bb/...',
        },
      ],
    );

    // deleteMessagesByInbox removes both messages; their attachments cascade.
    repos.messages.deleteMessagesByInbox(inbox.id);
    expect(repos.attachments.listAttachmentsByMessage(m1.messageId)).toHaveLength(0);
    expect(repos.attachments.listAttachmentsByMessage(m2.messageId)).toHaveLength(0);
  });
});
