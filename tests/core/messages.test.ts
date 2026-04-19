import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus.js';
import { type IngestInput, createMessages } from '../../src/core/messages.js';
import { openTestDbWithRepos } from '../support/db-helper.js';

/**
 * Test coverage for plan 03-03's message domain logic (CORE-03, CORE-04).
 *
 * Each case spins its own in-memory DB + a fresh bus — no shared state across
 * cases. An inbox is seeded directly via the inbox repo (bypassing the plan
 * 03-02 `createInboxes` factory) so these tests only exercise plan 03-03's
 * surface. The view-token is hand-hashed here so listMessages's view-token
 * gate can be exercised without importing `createInboxes`.
 */

const seedInbox = (
  repos: ReturnType<typeof openTestDbWithRepos>['repos'],
  overrides: { localPart?: string; domain?: string } = {},
) => {
  const viewToken = 'view-token-22-chars-ab';
  const view_token_hash = createHash('sha256').update(viewToken).digest('hex');
  const row = repos.inboxes.createInbox({
    local_part: overrides.localPart ?? 'user1',
    domain: overrides.domain ?? 'example.test',
    view_token_hash,
    expires_at: 9_999_999_999_999,
    hard_expires_at: 9_999_999_999_999,
  });
  return { row, viewToken };
};

const baseIngest = (envelopeTo: string, overrides: Partial<IngestInput> = {}): IngestInput => ({
  envelopeTo,
  envelopeFrom: 'sender@other.test',
  sender: 'Sender <sender@other.test>',
  subject: 'hi',
  textBody: 'body',
  htmlBody: null,
  headers: null,
  attachments: [],
  sizeBytes: 100,
  ...overrides,
});

const mkConfig = () => ({ domain: 'example.test', idleTtlMs: 600_000 });

describe('createMessages.ingestMessage', () => {
  it('writes message and emits AFTER commit (listener sees row via repo)', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row } = seedInbox(repos);

    // When the listener fires, the DB must already contain the new message
    // row — this is the CORE-03 / D-11 guarantee (emit happens strictly AFTER
    // commit). If emit fires mid-transaction, the count would be 0 here.
    let seenCountAtEmit = -1;
    bus.on('message', () => {
      seenCountAtEmit = repos.messages.countMessagesByInbox(row.id);
    });

    const result = messages.ingestMessage(baseIngest('user1@example.test'));
    expect(result.ok).toBe(true);
    expect(seenCountAtEmit).toBe(1);
  });

  it('writes message + attachment atomically', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row } = seedInbox(repos);

    const result = messages.ingestMessage(
      baseIngest('user1@example.test', {
        attachments: [
          {
            filename: 'a.txt',
            contentType: 'text/plain',
            size: 5,
            sha256: 'a'.repeat(64),
            path: 'aa/aa/attach-storage-path',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repos.messages.countMessagesByInbox(row.id)).toBe(1);
    expect(repos.attachments.listAttachmentsByMessage(result.messageId).length).toBe(1);
  });

  it('emits the event exactly once on successful ingest', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    seedInbox(repos);

    const listener = vi.fn();
    bus.on('message', listener);

    const result = messages.ingestMessage(baseIngest('user1@example.test'));
    expect(result.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns unknown_recipient for an address with no inbox (no DB write, no event)', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row } = seedInbox(repos);

    const listener = vi.fn();
    bus.on('message', listener);

    const r = messages.ingestMessage(baseIngest('nobody@example.test'));
    expect(r).toEqual({ ok: false, reason: 'unknown_recipient' });
    expect(listener).not.toHaveBeenCalled();
    expect(repos.messages.countMessagesByInbox(row.id)).toBe(0);
  });

  it.each(['no-at', 'a@b@c.test', '@example.test', 'user@'])(
    'returns invalid_envelope for malformed envelope %s',
    (envelope) => {
      const { repos } = openTestDbWithRepos();
      const bus = createBus();
      const messages = createMessages({ repos, bus, config: mkConfig() });
      const { row } = seedInbox(repos);

      const listener = vi.fn();
      bus.on('message', listener);

      const r = messages.ingestMessage(baseIngest(envelope));
      expect(r).toEqual({ ok: false, reason: 'invalid_envelope' });
      expect(listener).not.toHaveBeenCalled();
      expect(repos.messages.countMessagesByInbox(row.id)).toBe(0);
    },
  );

  it.each([
    { sha256: '', path: 'aa/aa/x' },
    { sha256: 'A'.repeat(64), path: 'aa/aa/x' }, // uppercase hex is invalid per D-14
    { sha256: 'a'.repeat(63), path: 'aa/aa/x' }, // wrong length
    { sha256: 'a'.repeat(65), path: 'aa/aa/x' }, // wrong length (too long)
    { sha256: `${'a'.repeat(63)}z`, path: 'aa/aa/x' }, // invalid hex char
    { sha256: 'a'.repeat(64), path: '' }, // empty path
  ])('returns invalid_attachment for malformed descriptor %#', (bad) => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row } = seedInbox(repos);

    const listener = vi.fn();
    bus.on('message', listener);

    const r = messages.ingestMessage(
      baseIngest('user1@example.test', {
        attachments: [
          {
            filename: 'x',
            contentType: 'application/octet-stream',
            size: 1,
            sha256: bad.sha256,
            path: bad.path,
          },
        ],
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'invalid_attachment' });
    // D-14: defensive reject leaves DB untouched and emits no event.
    expect(listener).not.toHaveBeenCalled();
    expect(repos.messages.countMessagesByInbox(row.id)).toBe(0);
  });

  it('isolates a throwing listener; DB still has the row and caller sees ok:true', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row } = seedInbox(repos);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    bus.on('message', thrower);

    const r = messages.ingestMessage(baseIngest('user1@example.test'));
    expect(r.ok).toBe(true);
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(repos.messages.countMessagesByInbox(row.id)).toBe(1);
    errSpy.mockRestore();
  });

  it('bumps last_activity_at via updateLastActivity(id, receivedAt + idleTtlMs)', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({
      repos,
      bus,
      config: mkConfig(),
      now: () => 1_700_000_000_000,
    });
    const { row } = seedInbox(repos);

    const spy = vi.spyOn(repos.inboxes, 'updateLastActivity');
    messages.ingestMessage(baseIngest('user1@example.test'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(row.id, 1_700_000_000_000 + 600_000);
  });

  it('serializes headers to JSON and stores html verbatim (D-13)', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    seedInbox(repos);

    // D-13: core stores htmlBody verbatim. The SMTP adapter sanitizes BEFORE
    // calling ingest; from this layer's perspective, the string is trusted
    // and must land in the DB untouched.
    const r = messages.ingestMessage(
      baseIngest('user1@example.test', {
        headers: { 'X-Test': 'abc' },
        htmlBody: '<p>raw-not-sanitized-by-core</p>',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const msg = repos.messages.findMessageById(r.messageId);
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(JSON.parse(msg.headers_json ?? 'null')).toEqual({ 'X-Test': 'abc' });
    expect(msg.html_body_sanitized).toBe('<p>raw-not-sanitized-by-core</p>');
  });

  it('emits the event with the correct inboxId, messageId, and receivedAt', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({
      repos,
      bus,
      config: mkConfig(),
      now: () => 1_700_000_000_000,
    });
    const { row } = seedInbox(repos);

    const listener = vi.fn();
    bus.on('message', listener);

    const r = messages.ingestMessage(baseIngest('user1@example.test'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(listener).toHaveBeenCalledWith({
      inboxId: row.id,
      messageId: r.messageId,
      receivedAt: 1_700_000_000_000,
    });
  });
});

describe('createMessages.listMessages', () => {
  it('returns messages in ASC order by receivedAt (D-15 chronological)', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    let t = 0;
    const schedule = [300, 100, 200];
    const now = () => {
      const v = schedule[t];
      t += 1;
      if (v === undefined) throw new Error('now() called too many times');
      return v;
    };
    const messages = createMessages({ repos, bus, config: mkConfig(), now });
    const { row, viewToken } = seedInbox(repos);

    messages.ingestMessage(baseIngest('user1@example.test', { subject: 'first' }));
    messages.ingestMessage(baseIngest('user1@example.test', { subject: 'second' }));
    messages.ingestMessage(baseIngest('user1@example.test', { subject: 'third' }));

    const r = messages.listMessages({ inboxId: row.id, viewToken });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The repo returns DESC; listMessages reverses it. Subjects pin the
    // mapping from call-order to receivedAt-order: `first` was ingested
    // at t=300, `second` at t=100, `third` at t=200.
    expect(r.messages.map((m) => m.receivedAt)).toEqual([100, 200, 300]);
    expect(r.messages.map((m) => m.subject)).toEqual(['second', 'third', 'first']);
  });

  it('returns not_found for an unknown inbox id', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const r = messages.listMessages({ inboxId: 'nope', viewToken: 'anything' });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns forbidden (NEVER not_found) for wrong view-token on an existing inbox', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row } = seedInbox(repos);
    // D-15: wrong-token branch must NOT leak cardinality via `not_found`.
    const r = messages.listMessages({ inboxId: row.id, viewToken: 'wrong-token-value!' });
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('MessageView contains only public metadata (no sha256, no storage_path, no bodies)', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row, viewToken } = seedInbox(repos);

    messages.ingestMessage(
      baseIngest('user1@example.test', {
        textBody: 'secret-body',
        htmlBody: '<b>secret</b>',
        attachments: [
          {
            filename: 'x.txt',
            contentType: 'text/plain',
            size: 1,
            sha256: 'a'.repeat(64),
            path: `aa/aa/${'a'.repeat(64)}`,
          },
        ],
      }),
    );

    const r = messages.listMessages({ inboxId: row.id, viewToken });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [m] = r.messages;
    expect(m).toBeDefined();
    if (!m) return;

    // String-level paranoia: the entire serialized response must not
    // contain any of the internal-only fields. This catches both shape
    // leaks (`sha256` key on AttachmentView) and substring leaks (the
    // body text accidentally included somewhere).
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('secret</b>');
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('storage_path');
    expect(serialized).not.toContain('storagePath');

    expect(m.hasTextBody).toBe(true);
    expect(m.hasHtmlBody).toBe(true);

    const [a] = m.attachments;
    expect(a).toBeDefined();
    if (!a) return;
    // Shape must be EXACTLY {id, filename, contentType, size} — nothing
    // else. Alphabetized for a stable comparison.
    expect(Object.keys(a).sort()).toEqual(['contentType', 'filename', 'id', 'size']);
  });

  it('returns ok with empty array for a valid inbox with zero messages', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({ repos, bus, config: mkConfig() });
    const { row, viewToken } = seedInbox(repos);
    const r = messages.listMessages({ inboxId: row.id, viewToken });
    expect(r).toEqual({ ok: true, messages: [] });
  });

  it('correct view-token on an inbox with messages returns ok:true with mapped views', () => {
    const { repos } = openTestDbWithRepos();
    const bus = createBus();
    const messages = createMessages({
      repos,
      bus,
      config: mkConfig(),
      now: () => 1_700_000_000_000,
    });
    const { row, viewToken } = seedInbox(repos);

    messages.ingestMessage(
      baseIngest('user1@example.test', { subject: 'subj', sender: 'foo@bar.test', sizeBytes: 42 }),
    );

    const r = messages.listMessages({ inboxId: row.id, viewToken });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.messages).toHaveLength(1);
    const [m] = r.messages;
    expect(m).toBeDefined();
    if (!m) return;
    expect(m.subject).toBe('subj');
    expect(m.sender).toBe('foo@bar.test');
    expect(m.receivedAt).toBe(1_700_000_000_000);
    expect(m.sizeBytes).toBe(42);
    expect(m.hasTextBody).toBe(true);
    expect(m.hasHtmlBody).toBe(false);
    expect(m.attachments).toEqual([]);
  });
});
