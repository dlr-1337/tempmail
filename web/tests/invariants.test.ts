import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(__dirname, '..');
const SRC_DIR = join(WEB_ROOT, 'src');
const APP_HTML = join(WEB_ROOT, 'src', 'app.html');

const CHECKED_EXTENSIONS = ['.ts', '.js', '.svelte', '.html', '.css'];

const FORBIDDEN_NEEDLES = [
  'googletagmanager',
  'google-analytics',
  'plausible.io',
  'fathom',
  'mixpanel',
  'segment.com',
  'segment.io',
  'sentry.io',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

function walk(dir: string, out: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (name === 'node_modules' || name === '.svelte-kit' || name === 'build' || name === 'dist') {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (CHECKED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      // Exclude the invariant test file itself (it lists the needles by name).
      if (full.endsWith('invariants.test.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

describe('invariants — no trackers, no CDNs', () => {
  it('no forbidden tracker/CDN strings anywhere under web/src', () => {
    const files = walk(SRC_DIR);
    const offences: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf8').toLowerCase();
      for (const needle of FORBIDDEN_NEEDLES) {
        if (content.includes(needle)) {
          offences.push(`${relative(WEB_ROOT, f)} contains "${needle}"`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('app.html has no external <script> or <link> tags', () => {
    const html = readFileSync(APP_HTML, 'utf8');
    expect(html).not.toMatch(/<script[^>]+src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<script[^>]+src\s*=\s*["']\/\//);
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']\/\//);
  });

  it('app.html has no inline <script> with external src patterns', () => {
    const html = readFileSync(APP_HTML, 'utf8');
    expect(html).not.toMatch(/<iframe[^>]+src\s*=\s*["']https?:/i);
  });
});
