---
phase: 5
plan: 6
status: ready
type: execute
wave: 5
depends_on: [05-03, 05-04, 05-05]
requirements: [API-10]
files_modified:
  - src/http/plugins/rate-limit.ts
  - tests/http/rate-limit.test.ts
autonomous: true
tags: [rate-limit, abuse, 429]
must_haves:
  truths:
    - "Rate-limited responses return 429 with Retry-After and {error:{code:'rate_limited'}} envelope"
    - "core.recordAbuse called on 429 with ipPrefix + bucket"
    - "Tests prove 429 triggers after exceeding per-route caps"
---

# Plan 05-06: Rate-limit hook — 429 envelope + abuse counter integration

## Goal

Wire `core.recordAbuse` to the rate-limit `onExceeded` hook and return a consistent 429 envelope.

## Must-have checklist

- [ ] 429 body matches `{ error: { code: 'rate_limited', message: string } }`
- [ ] `Retry-After` header present on 429
- [ ] `core.recordAbuse({ ipPrefix, bucket })` called once per 429
- [ ] Test: burst N+1 requests → last is 429 with envelope + header
- [ ] Test: abuse counter incremented (spy on core.recordAbuse)

## Tasks

<task type="auto">
  <name>Task 1: Rate-limit plugin — 429 envelope + recordAbuse hook</name>
  <files>src/http/plugins/rate-limit.ts</files>
  <action>

  Rewrite `src/http/plugins/rate-limit.ts`:

  ```typescript
  /**
   * @fastify/rate-limit registration (D-18, D-19, D-20).
   *
   * - Keyed by request.ip (trustProxy on behind Caddy)
   * - errorResponseBuilder → {error:{code:'rate_limited', message}} + Retry-After
   * - onExceeded → core.recordAbuse({ ipPrefix, bucket }) for the abuse table
   *
   * Bucket is derived from the request's URL path prefix (mint, read, stream,
   * attach). ipPrefix is /24 for v4 and /64 for v6 — privacy-respecting and
   * sufficient for rate-limit aggregation.
   */

  import rateLimit from '@fastify/rate-limit';
  import type { FastifyInstance, FastifyRequest } from 'fastify';
  import type { CoreApi } from '../../core/index.js';

  export interface RateLimitDeps {
    core: CoreApi;
  }

  export function bucketForPath(method: string, path: string): string {
    if (method === 'POST' && path === '/api/inbox') return 'mint';
    if (/\/stream$/.test(path)) return 'stream';
    if (/\/attachments\//.test(path)) return 'attach';
    if (/\/messages(\/|$)/.test(path)) return 'read';
    if (/\/api\/inbox\/[^/]+$/.test(path)) return 'meta';
    return 'other';
  }

  /**
   * IP prefix aggregator for abuse counters. Collapses IPv4 to /24 and IPv6 to /64.
   * Accepts raw string (what Fastify gives us on request.ip); never throws.
   */
  export function ipToPrefix(ip: string): string {
    if (!ip) return '0.0.0.0/24';
    if (ip.includes(':')) {
      // IPv6 — take the first 4 hextets (/64).
      const parts = ip.split(':');
      // Preserve '::' abbreviation concerns by padding; simple approach:
      const head = parts.slice(0, 4).join(':');
      return `${head}/64`;
    }
    const octets = ip.split('.');
    if (octets.length < 3) return `${ip}/24`;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  export async function registerRateLimit(app: FastifyInstance, deps: RateLimitDeps): Promise<void> {
    await app.register(rateLimit, {
      global: false,
      max: 120,
      timeWindow: '1 minute',
      errorResponseBuilder: (req, context) => ({
        error: {
          code: 'rate_limited',
          message: `too many requests (retry after ${context.after})`,
        },
      }),
      onExceeded: (req: FastifyRequest) => {
        const bucket = bucketForPath(req.method, req.url.split('?')[0] ?? req.url);
        const ipPrefix = ipToPrefix(req.ip ?? '');
        deps.core.recordAbuse({ ipPrefix, bucket });
      },
    });
  }
  ```

  Update `src/http/server.ts` to pass `core` to `registerRateLimit`:

  ```typescript
  await registerRateLimit(app, { core: deps.core });
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npx vitest run tests/http</automated>
  </verify>
  <done>Compiles; prior tests still green.</done>
  <commit>feat(http): rate-limit envelope and abuse counter hook</commit>
</task>

<task type="auto">
  <name>Task 2: Tests — 429 envelope + recordAbuse called</name>
  <files>tests/http/rate-limit.test.ts</files>
  <action>

  Create `tests/http/rate-limit.test.ts`:

  ```typescript
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { bucketForPath, ipToPrefix } from '../../src/http/plugins/rate-limit.js';
  import { buildTestRig, type TestRig } from './support.js';

  describe('ipToPrefix', () => {
    it('IPv4 → /24', () => {
      expect(ipToPrefix('203.0.113.45')).toBe('203.0.113.0/24');
    });
    it('IPv6 → /64', () => {
      expect(ipToPrefix('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234:5678/64');
    });
    it('empty → 0.0.0.0/24 fallback', () => {
      expect(ipToPrefix('')).toBe('0.0.0.0/24');
    });
  });

  describe('bucketForPath', () => {
    it.each([
      ['POST', '/api/inbox', 'mint'],
      ['GET', '/api/inbox/abc12345678901234567890', 'meta'],
      ['GET', '/api/inbox/abc/messages', 'read'],
      ['GET', '/api/inbox/abc/messages/def', 'read'],
      ['GET', '/api/inbox/abc/stream', 'stream'],
      ['GET', '/api/inbox/abc/attachments/xyz', 'attach'],
      ['GET', '/healthz', 'other'],
    ])('%s %s → %s', (m, p, expected) => {
      expect(bucketForPath(m, p)).toBe(expected);
    });
  });

  describe('rate limit 429 envelope + recordAbuse', () => {
    let rig: TestRig;
    beforeEach(async () => {
      rig = await buildTestRig();
    });
    afterEach(async () => {
      await rig.close();
    });

    it('mint 6th request in 1 minute returns 429 with envelope + Retry-After', async () => {
      // Spy on recordAbuse to prove it's called.
      let calls = 0;
      const origRecord = rig.core.recordAbuse;
      rig.core.recordAbuse = (input) => {
        calls += 1;
        return origRecord(input);
      };

      // 5 OK, 6th should 429 (mint is 5/min per IP).
      for (let i = 0; i < 5; i += 1) {
        const r = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
        expect(r.statusCode).toBe(201);
      }
      const blocked = await rig.app.inject({ method: 'POST', url: '/api/inbox' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeTruthy();
      const body = blocked.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('rate_limited');
      expect(calls).toBe(1);
    });
  });
  ```

  </action>
  <verify>
    <automated>npx vitest run tests/http/rate-limit.test.ts</automated>
  </verify>
  <done>All 11+ tests pass. Full suite still green.</done>
  <commit>test(http): rate-limit 429 envelope and abuse counter integration</commit>
</task>

## Verification

```bash
npm run typecheck && npm run check && npm test
```

## Success Criteria

- 429 body carries `{error:{code:'rate_limited',message}}`.
- `Retry-After` header present.
- `recordAbuse` called exactly once per 429.
- Full Phase 5 test suite green; test count 150+ cumulative.
