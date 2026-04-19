import { describe, expect, it } from 'vitest';
import type { Repos } from '../../src/db/repos/index.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

function makeInbox(repos: Repos) {
  const exp = 9_999_999_999;
  return repos.inboxes.createInbox({
    local_part: 'x',
    domain: 'd.test',
    view_token_hash: 'h',
    expires_at: exp,
    hard_expires_at: exp,
  });
}

describe('messageRepo (STORE-04)', () => {
  it('insertMessageWithAttachments writes message + N attachments atomically', () => {
    const { repos } = openTestDbWithRepos();
    const inbox = makeInbox(repos);
    const result = repos.messages.insertMessageWithAttachments(
      {
        inbox_id: inbox.id,
        sender: 'a@b',
        subject: 's',
        text_body: 't',
        html_body_sanitized: null,
        size_bytes: 100,
        envelope_from: 'a@b',
        envelope_to: 'x@d.test',
        headers_json: '{}',
      },
      [
        {
          filename: 'a',
          content_type: 'text/plain',
          size_bytes: 1,
          sha256: 'a'.repeat(64),
          storage_path: 'aa/aa/...',
        },
        {
          filename: 'b',
          content_type: 'text/plain',
          size_bytes: 2,
          sha256: 'b'.repeat(64),
          storage_path: 'bb/bb/...',
        },
      ],
    );
    expect(result.messageId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.attachmentIds).toHaveLength(2);
    const atts = repos.attachments.listAttachmentsByMessage(result.messageId);
    expect(atts).toHaveLength(2);
  });

  it('insertMessageWithAttachments rolls back if inbox_id is invalid (FK)', () => {
    const { repos } = openTestDbWithRepos();
    expect(() =>
      repos.messages.insertMessageWithAttachments(
        {
          inbox_id: 'nonexistent-inbox',
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
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('listMessagesByInbox returns newest first', () => {
    const { repos } = openTestDbWithRepos();
    const inbox = makeInbox(repos);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = repos.messages.insertMessageWithAttachments(
        {
          inbox_id: inbox.id,
          sender: null,
          subject: `s${i}`,
          text_body: null,
          html_body_sanitized: null,
          size_bytes: 0,
          envelope_from: null,
          envelope_to: null,
          headers_json: null,
          received_at: 1000 + i,
        },
        [],
      );
      ids.push(r.messageId);
    }
    const rows = repos.messages.listMessagesByInbox(inbox.id, { limit: 10, offset: 0 });
    expect(rows.map((r) => r.subject)).toEqual(['s2', 's1', 's0']);
  });

  it('countMessagesByInbox returns accurate count', () => {
    const { repos } = openTestDbWithRepos();
    const inbox = makeInbox(repos);
    expect(repos.messages.countMessagesByInbox(inbox.id)).toBe(0);
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
  });
});
