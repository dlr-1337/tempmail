/**
 * D-03 boundary invariant: no file under `src/core/` imports a database driver,
 * the node:fs filesystem API, or calls `db.prepare(` / `db.exec(` directly.
 *
 * This is a source-grep test — it complements Phase 2's runtime spy-based
 * prepared-statement invariant. If a future refactor sneaks `better-sqlite3`
 * or `node:fs` into `src/core/`, one of these four cases fails and names the
 * offending file so the fix is obvious.
 *
 * This test itself lives under `tests/core/` — NOT under `src/core/` — so it
 * is not subject to the invariant it enforces (it needs `node:fs` to walk the
 * directory).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve the repo's src/core/ directory relative to this test file.
const here = fileURLToPath(new URL('.', import.meta.url));
const CORE_DIR = join(here, '..', '..', 'src', 'core');

const listCoreTsFiles = (): readonly string[] => {
  const entries = readdirSync(CORE_DIR, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.ts')) continue;
    // `parentPath` is stable on Node 22; fall back to CORE_DIR for older typings.
    const dir = (e as { parentPath?: string }).parentPath ?? CORE_DIR;
    files.push(join(dir, e.name));
  }
  return files;
};

const findOffenders = (
  files: readonly string[],
  predicate: (src: string) => boolean,
): readonly string[] => {
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (predicate(src)) bad.push(f);
  }
  return bad;
};

describe('D-03 invariant: src/core/ does not touch the DB or filesystem directly', () => {
  const files = listCoreTsFiles();

  it('src/core/ has at least one .ts file (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no file imports better-sqlite3', () => {
    // Covers `import x from 'better-sqlite3'`, `import 'better-sqlite3'`
    // (side-effect), `import('better-sqlite3')` (dynamic), and
    // `require('better-sqlite3')`. The `['"]better-sqlite3['"]` anchor is
    // sufficient because the package name is unambiguous and does not appear
    // in any other legitimate context under `src/core/`.
    const bad = findOffenders(files, (src) => /['"]better-sqlite3['"]/.test(src));
    expect(bad, `offenders: ${bad.join(', ')}`).toEqual([]);
  });

  it('no file imports node:fs (or node:fs/promises)', () => {
    // Same reasoning: the specifier `node:fs` (with optional `/promises`) is
    // unambiguous and only legitimate in a filesystem import. Covers bare
    // `import 'node:fs'`, `from 'node:fs'`, dynamic `import('node:fs')`, and
    // `require('node:fs')`.
    const bad = findOffenders(files, (src) => /['"]node:fs(?:\/promises)?['"]/.test(src));
    expect(bad, `offenders: ${bad.join(', ')}`).toEqual([]);
  });

  it('no file calls db.prepare( or db.exec(', () => {
    const bad = findOffenders(files, (src) => /\bdb\.(prepare|exec)\s*\(/.test(src));
    expect(bad, `offenders: ${bad.join(', ')}`).toEqual([]);
  });
});
