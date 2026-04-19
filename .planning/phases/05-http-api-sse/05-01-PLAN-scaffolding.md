---
phase: 5
plan: 1
status: ready
type: execute
wave: 1
depends_on: []
requirements: [API-01, API-02, API-03, API-04, API-05, API-08, API-10, API-11]
files_modified:
  - package.json
  - package-lock.json
autonomous: true
tags: [scaffolding, dependencies, http]
must_haves:
  truths:
    - "fastify@^5 installed and resolvable"
    - "@fastify/cookie, @fastify/helmet, @fastify/rate-limit, @fastify/sensible installed"
    - "zod + fastify-type-provider-zod installed (validation path picked)"
    - "undici installed as dev dep for SSE real-fetch tests"
    - "typecheck + biome clean"
---

# Plan 05-01: Scaffolding — install HTTP + SSE dependencies

## Goal

Install every runtime + dev dependency the rest of Phase 5 will consume. Runs first; nothing else in this phase compiles without this plan landing.

## Must-have checklist

- [ ] `fastify@^5` (D-01)
- [ ] `@fastify/cookie@^11` (view-token cookie, D-05)
- [ ] `@fastify/helmet@^13` (API-11, D-21)
- [ ] `@fastify/rate-limit@^10` (API-10, D-18)
- [ ] `@fastify/sensible@^6` (httpErrors helpers)
- [ ] `zod@^3` + `fastify-type-provider-zod@^4` (D-22 validation)
- [ ] `undici@^7` as devDep for real-fetch SSE tests (D-28). (Node 22 fetch works too, but undici gives us a deterministic readable-stream for body chunks — simpler test ergonomics.)
- [ ] `npm run typecheck` exits 0 (no sources import these deps yet; existence is enough)
- [ ] `npm run check` exits 0

## Tasks

<task type="auto">
  <name>Task 1: Install runtime HTTP dependencies</name>
  <files>package.json, package-lock.json</files>
  <action>

  ```bash
  npm install fastify@^5 @fastify/cookie@^11 @fastify/helmet@^13 @fastify/rate-limit@^10 @fastify/sensible@^6 zod@^3 fastify-type-provider-zod@^4
  ```

  Rationale:
  - Fastify v5 required (D-01); v5 targets Node 20+, we run Node 22 LTS.
  - `@fastify/cookie@^11` is the v5-compatible line.
  - `@fastify/helmet@^13` is v5-compatible.
  - `@fastify/rate-limit@^10` is v5-compatible.
  - `@fastify/sensible@^6` is v5-compatible.
  - `fastify-type-provider-zod@^4` pairs with Fastify v5 + Zod v3.

  </action>
  <verify>
    <automated>node -e "require('fastify'); require('@fastify/cookie'); require('@fastify/helmet'); require('@fastify/rate-limit'); require('@fastify/sensible'); require('zod'); require('fastify-type-provider-zod'); console.log('ok')"</automated>
  </verify>
  <done>All packages load without throwing.</done>
  <commit>chore(05): add fastify and http plugin deps</commit>
</task>

<task type="auto">
  <name>Task 2: Install undici as dev dep for SSE tests</name>
  <files>package.json, package-lock.json</files>
  <action>

  ```bash
  npm install --save-dev undici@^7
  ```

  Undici's `fetch` + its response body as an async iterable of Buffer chunks is the cleanest way to consume an SSE stream in tests. Node 22's built-in fetch works but the exposed stream shape is browser-flavored ReadableStream which is clunky in test assertions.

  </action>
  <verify>
    <automated>node -e "const u = require('undici'); if (typeof u.fetch !== 'function') throw new Error('no fetch'); console.log('ok')"</automated>
  </verify>
  <done>undici resolves; `undici.fetch` is a function.</done>
  <commit>chore(05): add undici dev dep for sse integration tests</commit>
</task>

<task type="auto">
  <name>Task 3: Full-suite gate — nothing regressed</name>
  <files>(none)</files>
  <action>

  ```bash
  npm run typecheck
  npm run check
  npm test
  ```

  </action>
  <verify>
    <automated>npm run typecheck && npm run check && npm test</automated>
  </verify>
  <done>All three exit 0. Test count still 100 (no new tests yet).</done>
</task>

## Verification

```bash
npm ls fastify @fastify/cookie @fastify/helmet @fastify/rate-limit @fastify/sensible zod fastify-type-provider-zod undici
npm run typecheck
npm run check
npm test
```

## Success Criteria

- All 7 runtime packages + 1 dev package installed.
- All three gates exit 0.
- No new source or test files required.
