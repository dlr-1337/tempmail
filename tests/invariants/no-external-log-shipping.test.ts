/**
 * ABUSE-04 / D-25 — no third-party log-shipping SDK imports or URLs.
 *
 * Cheap grep over every `.ts` file under `src/`. Fails if anyone adds a
 * dependency that would exfiltrate logs to an external service (datadog,
 * sentry, logtail, etc.). The test file allowlists itself.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..', '..', 'src');

const FORBIDDEN_IMPORTS = [
  'datadog',
  '@datadog',
  'sentry',
  '@sentry',
  'logtail',
  '@logtail',
  'loggly',
  'papertrail',
  'logstash',
  '@opentelemetry',
  'splunk-logging',
  'newrelic',
  'bugsnag',
  'winston-mongodb',
];

const FORBIDDEN_URL_PATTERNS = [
  'intake.logs.datadoghq',
  'sentry.io',
  'in.logs.betterstack',
  'logs.papertrailapp.com',
];

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

describe('ABUSE-04 — no external log-shipping SDKs', () => {
  const files = listTsFiles(SRC);

  it(`forbidden import substrings are absent from every src/**/*.ts file (${files.length} files)`, () => {
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        // Match `from 'x'` and `require('x')` and nothing inside comments.
        const importPattern = new RegExp(`from\\s+['"]${escapeRegex(forbidden)}(?:/[^'"]*)?['"]`);
        const requirePattern = new RegExp(
          `require\\(['"]${escapeRegex(forbidden)}(?:/[^'"]*)?['"]\\)`,
        );
        expect(
          importPattern.test(body),
          `${basename(file)} imports forbidden package '${forbidden}'`,
        ).toBe(false);
        expect(
          requirePattern.test(body),
          `${basename(file)} requires forbidden package '${forbidden}'`,
        ).toBe(false);
      }
    }
  });

  it('forbidden log-shipping URLs never appear in source (exfil hotlines)', () => {
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_URL_PATTERNS) {
        expect(
          body.includes(forbidden),
          `${basename(file)} embeds forbidden URL '${forbidden}'`,
        ).toBe(false);
      }
    }
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
}
