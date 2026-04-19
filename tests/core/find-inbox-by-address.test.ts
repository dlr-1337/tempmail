/**
 * Coverage for `core.findInboxByAddress(localPart, domain)` — the D-15 /
 * Phase 4 Core extension consumed by the SMTP onRcptTo handler.
 *
 * Invariants:
 *   - Returns a neutral `InboxAddressView` for an existing inbox.
 *   - Returns `null` (never throws) for unknown addresses.
 *   - Domain mismatch → null (wrong-domain probe should be 550, not accept).
 */

import { describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../src/attachments/index.js';
import { type CoreConfig, createCore } from '../../src/core/index.js';
import { openTestDbWithRepos } from '../support/db-helper.js';
import { withTmpDir } from '../support/tmpdir.js';

const baseConfig = (): CoreConfig => ({
  domain: 'tempmail.local',
  idleTtlMs: 10 * 60 * 1_000,
  hardTtlMs: 60 * 60 * 1_000,
});

describe('core.findInboxByAddress', () => {
  it('returns the neutral view for an existing inbox', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: baseConfig() });
      const minted = core.createInbox();

      const [localPart, domain] = minted.address.split('@');
      if (!localPart || !domain) throw new Error('invariant: minted address malformed');

      const view = core.findInboxByAddress(localPart, domain);
      expect(view).not.toBeNull();
      expect(view?.id).toBe(minted.inboxId);
      expect(view?.localPart).toBe(localPart);
      expect(view?.domain).toBe(domain);
      // No view_token_hash or timestamps leak into the SMTP layer.
      expect(view).not.toHaveProperty('view_token_hash');
      expect(view).not.toHaveProperty('expires_at');
    });
  });

  it('returns null for an unknown local-part', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: baseConfig() });
      core.createInbox(); // a row exists, but not the one we'll query

      const view = core.findInboxByAddress('no-such-local-part', 'tempmail.local');
      expect(view).toBeNull();
    });
  });

  it('returns null for a domain mismatch even when the local-part exists', async () => {
    await withTmpDir(async (dir) => {
      const { db, repos } = openTestDbWithRepos();
      const attachmentStore = createAttachmentStore(dir);
      const core = createCore({ db, repos, attachmentStore, config: baseConfig() });
      const minted = core.createInbox();
      const [localPart] = minted.address.split('@');
      if (!localPart) throw new Error('invariant');

      const view = core.findInboxByAddress(localPart, 'other.example');
      expect(view).toBeNull();
    });
  });
});
