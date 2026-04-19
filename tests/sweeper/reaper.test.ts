/**
 * Plan 06-03 tests — orphan attachment reaper.
 *
 *   - blob referenced by DB row is NOT deleted
 *   - unreferenced blob IS deleted
 *   - `.incoming/*` temp files are never touched
 *   - malformed filenames are skipped gracefully
 *   - maxPerRun bound is respected
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shardPath } from '../../src/attachments/paths.js';
import { type SweeperRig, buildSweeperRig } from './support.js';

async function writeBlob(rig: SweeperRig, body: string): Promise<string> {
  const r = Readable.from([Buffer.from(body)]);
  const res = await rig.attachmentStore.writeAttachment(r);
  return res.sha256;
}

describe('orphan reaper (06-03 / RETN-03)', () => {
  let rig: SweeperRig;

  beforeEach(() => {
    rig = buildSweeperRig();
  });

  afterEach(async () => {
    await rig.sweeper.stop();
    rig.close();
  });

  it('unreferenced blobs are deleted; referenced blobs survive', async () => {
    // Three blobs on disk.
    const shaKept1 = await writeBlob(rig, 'referenced-1');
    const shaKept2 = await writeBlob(rig, 'referenced-2');
    const shaOrphan = await writeBlob(rig, 'orphan-payload');

    // Ingest a message so two shas are referenced in the DB.
    const minted = rig.core.createInbox();
    const res = rig.core.ingestMessage({
      envelopeTo: minted.address,
      envelopeFrom: 'from@x.test',
      sender: 'from@x.test',
      subject: 's',
      textBody: 'hello',
      htmlBody: null,
      headers: {},
      sizeBytes: 100,
      attachments: [
        { filename: 'a.bin', contentType: 'application/octet-stream', size: 13, sha256: shaKept1, path: shardPath(shaKept1) },
        { filename: 'b.bin', contentType: 'application/octet-stream', size: 13, sha256: shaKept2, path: shardPath(shaKept2) },
      ],
    });
    expect(res.ok).toBe(true);

    const result = await rig.sweeper.runOnce('reaper');
    expect(result.reaper?.scanned).toBe(3);
    expect(result.reaper?.orphaned).toBe(1);
    expect(result.reaper?.unlinked).toBe(1);

    // Referenced blobs still readable.
    const s1 = await rig.attachmentStore.statBySha256(shaKept1);
    const s2 = await rig.attachmentStore.statBySha256(shaKept2);
    const s3 = await rig.attachmentStore.statBySha256(shaOrphan);
    expect(s1.exists).toBe(true);
    expect(s2.exists).toBe(true);
    expect(s3.exists).toBe(false);
  });

  it('`.incoming/*` temp files are never unlinked by the reaper', async () => {
    // Write at least one valid blob so the reaper walks the tree.
    const shaKept = await writeBlob(rig, 'real-data');
    // Reference it via an ingested message.
    const minted = rig.core.createInbox();
    rig.core.ingestMessage({
      envelopeTo: minted.address,
      envelopeFrom: 'from@x.test',
      sender: 'from@x.test',
      subject: 's',
      textBody: 't',
      htmlBody: null,
      headers: {},
      sizeBytes: 10,
      attachments: [
        { filename: 'k.bin', contentType: 'application/octet-stream', size: 9, sha256: shaKept, path: shardPath(shaKept) },
      ],
    });

    // Drop a fake in-flight temp file into .incoming.
    const incomingDir = join(rig.attachmentStore.rootDir, '.incoming');
    mkdirSync(incomingDir, { recursive: true });
    const tempPath = join(incomingDir, 'tmp-in-flight-upload');
    writeFileSync(tempPath, 'partial');

    await rig.sweeper.runOnce('reaper');

    // Still there.
    const body = await readFile(tempPath, 'utf8');
    expect(body).toBe('partial');
  });

  it('files whose basename is not a valid sha256 hex are skipped', async () => {
    // Build a legit blob so the walk enters the shard dirs.
    const sha = await writeBlob(rig, 'padding');
    // Drop a bogus file alongside the blob.
    const bogusDir = join(rig.attachmentStore.rootDir, sha.slice(0, 2), sha.slice(2, 4));
    mkdirSync(bogusDir, { recursive: true });
    const bogusPath = join(bogusDir, 'not-a-sha.tmp');
    writeFileSync(bogusPath, 'editor-swapfile');

    await rig.sweeper.runOnce('reaper');

    // The bogus filename is not attempted as a sha-unlink; still present.
    const body = await readFile(bogusPath, 'utf8');
    expect(body).toBe('editor-swapfile');
  });

  it('maxPerRun bound caps scan count', async () => {
    // Seed 5 blobs, then run with maxPerRun=2.
    for (let i = 0; i < 5; i += 1) await writeBlob(rig, `payload-${i}`);
    const small = buildSweeperRig({ config: { reaperMaxPerRun: 2 } });
    try {
      // Re-seed under the new rig's root dir.
      for (let i = 0; i < 5; i += 1) {
        const r = Readable.from([Buffer.from(`payload-${i}`)]);
        await small.attachmentStore.writeAttachment(r);
      }
      const result = await small.sweeper.runOnce('reaper');
      expect(result.reaper?.scanned).toBe(2);
    } finally {
      await small.sweeper.stop();
      small.close();
    }
  });

  it('emits a single aggregate log line with whitelisted fields', async () => {
    await writeBlob(rig, 'one');
    await rig.sweeper.runOnce('reaper');
    const line = rig.captured.find((e) => e.obj.event === 'sweeper.reaper.done');
    expect(line).toBeTruthy();
    const keys = Object.keys(line?.obj ?? {}).sort();
    expect(keys).toEqual(['duration_ms', 'event', 'orphaned', 'scanned', 'tick_id', 'unlinked']);
  });
});
