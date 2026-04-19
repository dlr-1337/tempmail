/**
 * Source-level invariants for the Phase 4 SMTP layer.
 *
 * These are cheap grep-style checks that enforce structural promises made in
 * CONTEXT.md — the file-level ESLint/Biome rules cannot easily express them,
 * so we stamp them in a unit test instead.
 *
 *   D-03 / boundary: SMTP never imports better-sqlite3 directly.
 *   D-29:            SMTP modules never import raw `pino` — all pino access
 *                    is funnelled through `src/smtp/log.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SMTP_DIR = resolve(__dirname, '..', '..', 'src', 'smtp');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('src/smtp/** source invariants', () => {
  const files = listTsFiles(SMTP_DIR);

  it('no file imports `better-sqlite3` directly (D-03)', () => {
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      expect(body, `${f} imports better-sqlite3`).not.toMatch(/from\s+['"]better-sqlite3['"]/);
      expect(body, `${f} imports better-sqlite3`).not.toMatch(/require\(['"]better-sqlite3['"]\)/);
    }
  });

  it('only `src/smtp/log.ts` imports `pino` (D-29)', () => {
    for (const f of files) {
      if (f.endsWith(`${'log.ts'}`)) continue; // the one allowed caller
      const body = readFileSync(f, 'utf8');
      expect(body, `${f} imports pino directly — must go through log.ts`).not.toMatch(
        /from\s+['"]pino['"]/,
      );
      expect(body, `${f} imports pino directly`).not.toMatch(/require\(['"]pino['"]\)/);
    }
  });
});
