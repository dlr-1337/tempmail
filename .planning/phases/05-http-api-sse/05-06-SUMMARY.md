---
plan: 05-06
status: complete
requirements: [API-10]
commits: [6a1bff2, 9dd8bdb, a5085c7]
tests_added: 11
---

# Plan 05-06 — Rate-limit 429 envelope + abuse counter hook

## Files

- `src/http/plugins/rate-limit.ts` — `errorResponseBuilder` returns canonical envelope + `onExceeded` records abuse.
- `src/http/server.ts` — centralized `setErrorHandler` passes 429 through with the envelope.

## Behavior

- 429 body: `{ error: { code: 'rate_limited', message: 'too many requests (retry after <N>)' } }`.
- 429 carries `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers (set by the plugin).
- `core.recordAbuse({ ipPrefix, bucket })` called once per 429 — keyed by URL bucket (`mint | read | stream | attach | meta | other`) and IP prefix (/24 v4, /64 v6).
- `bucketForPath(method, path)` + `ipToPrefix(ip)` exported for test parity.

## Tests (11)

- `tests/http/rate-limit.test.ts`:
  - `ipToPrefix`: IPv4 /24, IPv6 /64, empty fallback (3 cases).
  - `bucketForPath`: 7 method/path pairs.
  - Mint 5/min: 5 OK then 429 — envelope + `Retry-After` + `recordAbuse` called once (1 case).

## Gates

- `npm run typecheck` — 0
- `npx biome check src/http tests/http` — clean
- `npx vitest run tests/http/rate-limit.test.ts` — 11/11
- Full suite — **189/189** across 33 files (150 Phase 2+3+5 tests + 39 Phase 4 tests).
