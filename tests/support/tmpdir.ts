import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Allocates a per-test temp directory, runs `fn(dir)`, and cleans up
 * unconditionally (success or failure). Returns fn's result.
 *
 * Used by integration tests that need a real filesystem (PRAGMA + WAL behavior,
 * attachment store I/O). See D-34 and CONTEXT.md for rationale.
 */
export async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tempmail-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
