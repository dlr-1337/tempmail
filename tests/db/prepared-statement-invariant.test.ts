import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { createRepos } from '../../src/db/repos/index.js';

describe('D-21: all repo SQL goes through prepared statements', () => {
  it('repos never call db.exec() during normal operations', () => {
    const db = openDb(':memory:');
    const execSpy = vi.spyOn(db, 'exec');
    const repos = createRepos(db);

    // Exercise every repo method that performs SQL
    const exp = 9_999_999_999;
    const inbox = repos.inboxes.createInbox({
      local_part: 'x',
      domain: 'd.test',
      view_token_hash: 'h',
      expires_at: exp,
      hard_expires_at: exp,
    });
    repos.inboxes.findInboxById(inbox.id);
    repos.inboxes.findInboxByLocalPart('x', 'd.test');
    repos.inboxes.updateLastActivity(inbox.id, exp);
    repos.inboxes.listExpired(exp, 10);

    const { messageId } = repos.messages.insertMessageWithAttachments(
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
          content_type: null,
          size_bytes: 1,
          sha256: 'a'.repeat(64),
          storage_path: 'p',
        },
      ],
    );
    repos.messages.findMessageById(messageId);
    repos.messages.listMessagesByInbox(inbox.id, { limit: 10, offset: 0 });
    repos.messages.countMessagesByInbox(inbox.id);

    repos.attachments.findAttachmentById('nope');
    repos.attachments.listAttachmentsByMessage(messageId);
    repos.attachments.listAllSha256s();

    repos.abuse.incrementCounter('a', 'b', 0);
    repos.abuse.getCounter('a', 'b', 0);
    repos.abuse.pruneOldCounters(10);

    repos.inboxes.deleteInbox(inbox.id);

    // The only legitimate exec() calls happen during openDb() (migrations,
    // before the spy was attached). After createRepos, no repo method should
    // call exec directly.
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('repos cache prepared statements (repeated calls do not re-prepare)', () => {
    const db = openDb(':memory:');
    // Repos prepare their statements once during createRepos(). Wrap prepare
    // AFTER createRepos so we observe per-call behavior only.
    const repos = createRepos(db);
    const prepareSpy = vi.spyOn(db, 'prepare');

    const exp = 9_999_999_999;
    for (let i = 0; i < 10; i += 1) {
      repos.inboxes.createInbox({
        local_part: `lp${i}`,
        domain: 'd.test',
        view_token_hash: 'h',
        expires_at: exp,
        hard_expires_at: exp,
      });
    }
    // 10 createInbox calls should not re-prepare the INSERT (it's cached).
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});
