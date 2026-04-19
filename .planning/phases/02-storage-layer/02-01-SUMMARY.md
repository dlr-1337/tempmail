---
phase: 2
plan: 1
subsystem: scaffolding
tags: [scaffolding, tooling, typescript, vitest, biome, better-sqlite3]
dependency_graph:
  requires: []
  provides: ["node-project", "typescript-toolchain", "vitest-runner", "biome-linter", "better-sqlite3-native"]
  affects: ["02-02", "02-03", "02-04", "02-05"]
tech_stack:
  added:
    - "better-sqlite3@12.9.0"
    - "nanoid@5.1.9"
    - "pino@9.14.0"
    - "@biomejs/biome@1.9.4"
    - "@types/better-sqlite3@7.6.13"
    - "@types/node@22.19.17"
    - "tsx@4.21.0"
    - "typescript@5.9.3"
    - "vitest@2.1.9"
  patterns:
    - "ESM-only Node 22 project (type: module, NodeNext resolution)"
    - "TypeScript strict + noUncheckedIndexedAccess + verbatimModuleSyntax"
    - "Biome single-tool lint+format (replaces ESLint + Prettier)"
    - "Vitest node-env unit tests, globals: false, explicit imports"
key_files:
  created:
    - path: "package.json"
      purpose: "Pinned deps + scripts (dev, build, typecheck, test, check)"
    - path: "package-lock.json"
      purpose: "Generated lockfile — freezes 107 transitive deps"
    - path: "tsconfig.json"
      purpose: "Strict IDE/typecheck config (noEmit=true)"
    - path: "tsconfig.build.json"
      purpose: "Build config for production compile to dist/ (noEmit=false)"
    - path: "vitest.config.ts"
      purpose: "Vitest runner config (node env, v8 coverage, threads pool)"
    - path: "biome.json"
      purpose: "Biome format+lint config — single-quote, trailing commas, semicolons"
    - path: ".gitignore"
      purpose: "Ignore node_modules, dist, data/*.db*, data/attachments, .env"
    - path: ".node-version"
      purpose: "Lock Node runtime to 22.22.0 for nvm/fnm/asdf"
    - path: "src/index.ts"
      purpose: "Placeholder ESM entrypoint"
    - path: "tests/smoke.test.ts"
      purpose: "Sentinel test so Vitest exits 0 (Vitest 2.x errors on zero tests)"
  modified: []
decisions:
  - "D-01..D-03, D-33, D-35 confirmed and materialized in package.json + tsconfig.json"
  - "Added .planning to biome.json files.ignore — GSD planning docs are not project code"
metrics:
  duration_minutes: ~4
  completed_date: "2026-04-18"
  tasks: 3
  files_created: 15
  files_modified: 0
---

# Phase 2 Plan 1: Project Scaffolding Summary

Scaffolded a Node 22 + TypeScript ESM project with pinned `better-sqlite3@12.9.0`, Vitest 2.1.9, and Biome 1.9.4 — the toolchain all subsequent Phase 2 plans (schema, repos, attachment store, tests) require.

## What Was Built

- ESM-only `package.json` with `"type": "module"`, `engines.node >=22 <23`, and exactly the dependency set locked in CONTEXT.md (D-01..D-03, D-33, D-35). No premature Phase 3+ deps installed.
- TypeScript strict config split across `tsconfig.json` (IDE/typecheck, `noEmit: true`) and `tsconfig.build.json` (emit to `dist/`). `noUncheckedIndexedAccess` + `verbatimModuleSyntax` enabled for the repo layer's safety.
- `vitest.config.ts` with `environment: 'node'`, `globals: false`, threads pool — so the SQLite `:memory:` tests in plan 05 can run in parallel.
- `biome.json` — lint + format enabled, `quoteStyle: single`, trailing commas, `noNonNullAssertion: error`, `noExplicitAny: error`. Replaces ESLint + Prettier per STACK.md.
- Folder skeleton: `src/{db,db/repos,db/migrations,attachments,util}`, `tests/`, `data/` — all tracked via `.gitkeep`.
- `tests/smoke.test.ts` sentinel so `npm test` exits 0 (Vitest 2.x returns non-zero on zero tests; plan anticipated this).
- `better-sqlite3` native binding verified on Windows (dev machine) — basic prepared-statement round-trip round-trips `42`.

## Locked Package Versions

Resolved from `package-lock.json`:

| Package | Declared | Installed |
| ---- | ---- | ---- |
| better-sqlite3 | ^12.9.0 | **12.9.0** |
| nanoid | ^5.0.0 | **5.1.9** |
| pino | ^9.0.0 | **9.14.0** |
| @biomejs/biome | ^1.9.0 | **1.9.4** |
| @types/better-sqlite3 | ^7.6.0 | **7.6.13** |
| @types/node | ^22.0.0 | **22.19.17** |
| tsx | ^4.0.0 | **4.21.0** |
| typescript | ^5.6.0 | **5.9.3** |
| vitest | ^2.0.0 | **2.1.9** |

Total: 107 packages installed (including transitive deps).

## Source Tree

```
tempmail/
├── .node-version          22.22.0
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── biome.json
├── data/                  (runtime SQLite + attachments land here — tracked via .gitkeep)
├── src/
│   ├── index.ts           (placeholder — Phase 3 wires servers here)
│   ├── attachments/       (empty — plan 02-04 fills)
│   ├── db/
│   │   ├── migrations/    (empty — plan 02-02 fills with schema.sql)
│   │   └── repos/         (empty — plan 02-03 fills with inboxRepo, messageRepo, ...)
│   └── util/              (empty)
└── tests/
    └── smoke.test.ts      (sentinel — delete or keep; plan 02-05 replaces)
```

## Commands That Pass

Run from repo root:

```bash
npm install           # exits 0 (engine warning about Node 24 on dev machine is expected — target is Node 22 LTS)
npm run typecheck     # exits 0 — tsc --noEmit
npm run check         # exits 0 — biome check .
npm test              # exits 0 — 1 passed (sentinel)
```

Plus the native smoke check:

```bash
node -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE TABLE t(x INTEGER)');db.prepare('INSERT INTO t(x) VALUES(?)').run(42);const r=db.prepare('SELECT x FROM t').get();if(r.x!==42)process.exit(1);db.close();console.log('native ok');"
# prints: native ok
```

## Commits

| Task | Commit | Files |
| ---- | ---- | ---- |
| 1. Init package.json, gitignore, src layout | `53406f2` | package.json, .gitignore, .node-version, src/index.ts, src/{db,db/repos,db/migrations,attachments,util}/.gitkeep, tests/.gitkeep, data/.gitkeep |
| 2. Add tsconfig, vitest, biome | `b18c43a` | tsconfig.json, tsconfig.build.json, vitest.config.ts, biome.json |
| 3. Install deps + verify toolchain | `e89e18c` | package-lock.json, tests/smoke.test.ts, biome.json (ignore .planning/) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] `biome check .` tripped on `.planning/config.json`**
- **Found during:** Task 3, first `npm run check` run.
- **Issue:** Biome's recursive scan hit GSD's own `.planning/config.json` which is missing a trailing newline, causing the check to fail.
- **Fix:** Added `".planning"` to `biome.json` `files.ignore`. `.planning/` is GSD orchestration state, not project source — not code the linter should judge.
- **Files modified:** `biome.json` (line 10)
- **Commit:** `e89e18c` (bundled with Task 3 since the fix was discovered while running Task 3's verify step)

**2. [Rule 3 — Blocking] `vitest run` exits non-zero on empty test tree**
- **Found during:** Task 3, first `npm test` run.
- **Issue:** Vitest 2.1.9 prints "No test files found, exiting with code 1". The plan's Done criteria requires `npm test` to exit 0.
- **Fix:** Added the sentinel test at `tests/smoke.test.ts` — exactly the fallback the plan's Task 3, step 4 instructs to add if this happens.
- **Files modified:** `tests/smoke.test.ts` (created)
- **Commit:** `e89e18c`

**3. [Rule 1 — Bug] Sentinel test tripped Biome's organizeImports rule**
- **Found during:** Task 3, re-run of `npm run check` after adding smoke test.
- **Issue:** `import { describe, it, expect } from 'vitest'` is not alphabetized; Biome's `organizeImports` rule flagged it as an error.
- **Fix:** Re-ordered imports to `{ describe, expect, it }` so Biome is happy.
- **Files modified:** `tests/smoke.test.ts`
- **Commit:** `e89e18c`

### Environment Note (not a deviation — documented for downstream plans)

- Developer machine runs Node `v24.14.1`. `package.json` declares `engines.node >=22 <23`. npm emits an `EBADENGINE` **warning** (non-strict by default) but the install succeeds and all toolchain commands pass. The Docker image (Phase 8) will pin Node 22 LTS per D-01; this mismatch does not affect correctness on the dev machine since better-sqlite3 prebuilts exist for Node 24 as well.
- No Windows MSBuild prompts occurred — better-sqlite3 prebuilt binaries loaded cleanly.
- WAL files, Linux/musl verification, and PRAGMA behavior are out of scope for this plan (covered in 02-02 and 02-05).

## Known Stubs

None. `src/index.ts` is a deliberate placeholder documented in the file itself; it is not a stub rendered to any UI.

## Self-Check: PASSED

All files created exist:
- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `biome.json`, `.gitignore`, `.node-version`, `src/index.ts`, `tests/smoke.test.ts` — all verified present.
- Subdirectories `src/db/`, `src/db/repos/`, `src/db/migrations/`, `src/attachments/`, `src/util/`, `tests/`, `data/` — all verified present.

All commits exist in `git log`:
- `53406f2` — chore(scaffold): initialize package.json, gitignore, and src layout
- `b18c43a` — chore(tooling): add tsconfig, vitest, and biome configuration
- `e89e18c` — chore(deps): install pinned dependencies and verify toolchain

Toolchain verification (run end-to-end one final time): `npm install` (ok), `npm run typecheck` (ok, exit 0), `npm run check` (ok, exit 0), `npm test` (ok, 1 passed), native sqlite (ok: 42).
