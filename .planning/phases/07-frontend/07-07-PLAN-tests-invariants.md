---
phase: 7
plan: 7
status: ready
type: execute
wave: 5
depends_on: [07-05, 07-06]
requirements: [UI-07, UI-08, UI-09, UI-10, UI-13]
files_modified:
  - web/src/lib/sandbox.test.ts
  - web/tests/invariants.test.ts
  - web/README.md (optional — skipped per guidance)
autonomous: true
tags: [tests, invariants, xss, tracking-defense]
must_haves:
  truths:
    - "XSS injection test — script tags inside srcdoc do NOT execute (CSP default-src 'none')"
    - "Remote image invariant — default CSP blocks https:; after Load-images opt-in, CSP allows https:"
    - "Grep invariant — no tracker/CDN strings anywhere in web/src"
    - "app.html has no external <link>/<script>/<img> tags"
    - "Vitest green; svelte-check 0; build green"
    - "E2E Playwright — deferred if not installed on Windows; smoke documented in phase summary"
---

# Plan 07-07: Tests + invariants

## Goal

Lock the XSS-defense, tracking-defense, and third-party-absence invariants into automated tests. Playwright E2E is optional — skip it if Playwright install is flaky on Windows and document as deferred.

## Must-have checklist

- [ ] XSS assertion: `buildSrcdoc` with a `<script>` payload still emits CSP `default-src 'none'`
- [ ] Remote-image block assertion: CSP withholds `https:` by default; toggle adds it
- [ ] Grep invariant test walks `web/src/**/*.{ts,svelte,html,css}` asserting none of: `googletagmanager`, `google-analytics`, `plausible.io`, `fathom`, `mixpanel`, `segment.com`, `sentry.io`, `cdn.jsdelivr`, `cdnjs.cloudflare`, `unpkg.com`
- [ ] `web/src/app.html` asserted to contain no `<script src="http` or `<link href="http` or `<link rel="stylesheet" href="//`
- [ ] Final gate: `npm run check && npm run build && npm test` all exit 0

## Tasks

<task type="auto">
  <name>Task 1: Expand sandbox.test.ts for XSS + remote-image cases</name>
  <files>web/src/lib/sandbox.test.ts</files>
  <action>
  Cases:
  1. `buildSrcdoc('<script>alert(1)</script>', { allowRemoteImages: false })` contains both the script literal AND the CSP meta tag.
  2. Default CSP `img-src` is `data:` (no `https:`).
  3. With `allowRemoteImages: true`, CSP `img-src` includes `https:`.
  4. No `style-src 'none'` (we allow inline styles per D-27).
  </action>
  <verify>
    <automated>cd web && npm test -- --run sandbox</automated>
  </verify>
  <done>All four sandbox cases pass.</done>
  <commit>test(07): xss + tracking-pixel sandbox assertions</commit>
</task>

<task type="auto">
  <name>Task 2: Invariant test — no trackers, no CDNs</name>
  <files>web/tests/invariants.test.ts</files>
  <action>
  Vitest walks `web/src` + `web/static` + `web/src/app.html` (recursive), reads every `.ts|.svelte|.html|.css|.js`, asserts none match any of the forbidden substrings. Runs as part of `npm test`.
  </action>
  <verify>
    <automated>cd web && npm test -- --run invariants</automated>
  </verify>
  <done>Invariant test passes.</done>
  <commit>test(07): grep invariant — no trackers, no cdns</commit>
</task>

<task type="auto">
  <name>Task 3: Final gate — all tests + build</name>
  <files>(none)</files>
  <action>
  Run full suite end-to-end.
  </action>
  <verify>
    <automated>cd web && npm run check && npm run build && npm test -- --run</automated>
  </verify>
  <done>Exit 0 on all three.</done>
</task>

## Verification

```bash
cd web
npm run check
npm run build
npm test -- --run
```

## Success Criteria

- All vitest suites green
- Invariants locked in CI
- Build artifact clean
- Playwright deferred with rationale if install fails
