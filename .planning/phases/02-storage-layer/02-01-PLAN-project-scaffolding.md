---
phase: 2
plan: 1
type: execute
wave: 1
status: ready
depends_on: []
files_modified:
  - package.json
  - package-lock.json
  - tsconfig.json
  - vitest.config.ts
  - biome.json
  - .gitignore
  - .node-version
  - src/index.ts
  - data/.gitkeep
autonomous: true
requirements: []
must_haves:
  truths:
    - "npm install completes successfully with all locked dependency versions"
    - "npm run check (Biome) runs with zero errors on an empty src/ tree"
    - "npm test (Vitest) runs and reports zero tests (green) on an empty test tree"
    - "npm run typecheck passes on the scaffolded TypeScript"
    - "better-sqlite3 native module builds/loads on the developer's OS (Windows dev → Linux deploy)"
  artifacts:
    - path: "package.json"
      provides: "Pinned dependency versions + npm scripts"
      contains: "better-sqlite3"
    - path: "tsconfig.json"
      provides: "Strict TypeScript configuration compatible with Node 22 + tsx"
      contains: "\"strict\": true"
    - path: "vitest.config.ts"
      provides: "Vitest test runner configuration"
    - path: "biome.json"
      provides: "Biome lint + format configuration"
    - path: ".gitignore"
      provides: "Ignores node_modules, data/*.db*, dist/, .env"
      contains: "node_modules"
    - path: "src/index.ts"
      provides: "Placeholder entrypoint so tsc/tsx have something to load"
  key_links:
    - from: "package.json"
      to: "better-sqlite3@^12"
      via: "dependencies"
      pattern: "better-sqlite3"
    - from: "tsconfig.json"
      to: "src/**/*.ts"
      via: "include"
      pattern: "src"
---

<objective>
Scaffold the tempmail Node.js + TypeScript project: `package.json` with pinned production + dev dependencies, strict `tsconfig.json`, Vitest config, Biome config, `.gitignore`, and the `src/` folder layout. After this plan, `npm install && npm run check && npm test && npm run typecheck` all succeed on an empty-but-wellformed tree.

Purpose: every subsequent plan in Phase 2 (schema, repos, attachment store, tests) needs a working build/test/lint toolchain. This plan creates it exactly once, with boring well-documented defaults per D-01..D-03 and D-33.
Output: A working Node 22 + TypeScript project at repo root that compiles, lints, and runs tests on an empty tree.
</objective>

<execution_context>
Greenfield project. No prior code. This plan sets the conventions subsequent phases follow.

Working directory for all commands: `C:/Users/otavi/OneDrive/Documentos/tempmail/` (repo root).

All paths in this plan are relative to the repo root unless otherwise noted.
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/phases/02-storage-layer/02-CONTEXT.md
@.planning/research/STACK.md
</context>

<locked_decisions>
- **D-01:** Node 22 LTS (target runtime; `.node-version` records it)
- **D-02:** `better-sqlite3@^12.x` — synchronous API driver
- **D-03:** TypeScript strict mode; `tsx` for dev
- **D-33:** Vitest for unit tests
- **D-35:** `nanoid` for IDs (picked here; ulid not installed)

Reject these decisions: no ESLint, no Prettier, no ts-node, no jest, no nodemon, no pm2. Biome replaces ESLint+Prettier (STACK.md). tsx replaces ts-node.
</locked_decisions>

## Goal

A functioning Node 22 + TypeScript project skeleton with pinned deps, strict compiler, Vitest + Biome tooling, and a `src/` folder layout that subsequent plans fill in — verifiable by running `npm install && npm run check && npm test && npm run typecheck` with all four succeeding.

## Must-have checklist

This plan does not directly deliver any STORE-XX requirement but is a hard prerequisite for all four:
- Enables STORE-01, STORE-02, STORE-03, STORE-04 (build/test toolchain for the code that satisfies them)

## Tasks

#### Task 1: Initialize `package.json`, `.gitignore`, `.node-version`, and `src/` layout

**Files:**
- `package.json`
- `.gitignore`
- `.node-version`
- `src/index.ts`
- `src/db/.gitkeep`
- `src/db/repos/.gitkeep`
- `src/db/migrations/.gitkeep`
- `src/attachments/.gitkeep`
- `src/util/.gitkeep`
- `tests/.gitkeep`
- `data/.gitkeep`

**Action:**

1. Create `package.json` at repo root with EXACT contents below. Pin every version with `^` as noted. `"type": "module"` is required — the project is ESM-only:

```json
{
  "name": "tempmail",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Self-hosted public disposable email service",
  "license": "MIT",
  "engines": {
    "node": ">=22.0.0 <23"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node --enable-source-maps dist/index.js",
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "biome check .",
    "check:fix": "biome check --write ."
  },
  "dependencies": {
    "better-sqlite3": "^12.9.0",
    "nanoid": "^5.0.0",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

Notes:
  - `@types/better-sqlite3` is intentionally `^7.x` (it tracks the DefinitelyTyped package; `better-sqlite3` itself is `^12`). This is correct; do not "fix" it.
  - Only Phase 2 runtime deps are listed. Phase 3+ will add `fastify`, `smtp-server`, `mailparser` in their own plans. Do not pre-install them.

2. Create `.node-version` (used by asdf / nvm / fnm) with exactly:

```
22.22.0
```

(No trailing newline enforcement needed; a single newline at end of file is fine.)

3. Create `.gitignore` at repo root with exactly:

```
# Dependencies
node_modules/

# Build output
dist/
*.tsbuildinfo

# Test output
coverage/

# Runtime data (SQLite DB + WAL + SHM + attachments)
data/*.db
data/*.db-wal
data/*.db-shm
data/attachments/

# Env
.env
.env.local

# Editor / OS
.DS_Store
.vscode/
.idea/
*.log
```

4. Create the `src/` folder structure. Use placeholder `.gitkeep` files in every subdirectory so git tracks them:
  - `src/db/.gitkeep` (empty file)
  - `src/db/repos/.gitkeep` (empty file)
  - `src/db/migrations/.gitkeep` (empty file)
  - `src/attachments/.gitkeep` (empty file)
  - `src/util/.gitkeep` (empty file)
  - `tests/.gitkeep` (empty file)
  - `data/.gitkeep` (empty file — this directory holds the SQLite DB and attachment tree at runtime; it exists in git so first run doesn't fail on `mkdir`)

5. Create `src/index.ts` with a one-line placeholder so `tsx` / `tsc` have a valid entrypoint:

```typescript
// Entry point. Phase 3 wires SMTP + HTTP servers here.
// Phase 2 only produces the storage layer; this file intentionally stays minimal.
export {};
```

**Verify:**

```xml
<verify>
  <automated>test -f package.json && test -f .gitignore && test -f .node-version && test -f src/index.ts && test -d src/db && test -d src/db/repos && test -d src/db/migrations && test -d src/attachments && test -d src/util && test -d tests && test -d data</automated>
</verify>
```

**Done:**
- `package.json` exists with `"type": "module"`, scripts, and exact pinned dependency versions above.
- `.gitignore` ignores `node_modules/`, `dist/`, `data/*.db*`, `data/attachments/`, `.env`.
- `src/` contains `index.ts` + empty subdirectories `db/`, `db/repos/`, `db/migrations/`, `attachments/`, `util/`.
- `tests/` and `data/` directories exist (both tracked via `.gitkeep`).

**Commit message:** `chore(scaffold): initialize package.json, gitignore, and src layout`

---

#### Task 2: Configure TypeScript (`tsconfig.json` + `tsconfig.build.json`), Vitest, and Biome

**Files:**
- `tsconfig.json`
- `tsconfig.build.json`
- `vitest.config.ts`
- `biome.json`

**Action:**

1. Create `tsconfig.json` at repo root with EXACT contents. This is the IDE / `tsc --noEmit` / `tsx` config. Strict mode per D-03:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": false,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist", "data"]
}
```

Rationale (do not change without checking STACK.md):
  - `module: NodeNext` + `moduleResolution: NodeNext` is required for ESM + `"type": "module"` in `package.json`.
  - `noUncheckedIndexedAccess: true` — catches `arr[0]` possibly-undefined bugs early. Critical for the repo layer that will do `.get()` lookups.
  - `verbatimModuleSyntax: true` — requires explicit `import type { X }` for type-only imports. Keeps bundler / tree-shake story clean.
  - `noEmit: true` in root config — typecheck only. Build uses the separate config below.

2. Create `tsconfig.build.json` at repo root. This is for `npm run build` (production compile to `dist/`). It extends the root config and turns emit on:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "data", "tests", "vitest.config.ts"]
}
```

3. Create `vitest.config.ts` at repo root with EXACT contents (Vitest per D-33):

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
  },
});
```

Notes:
  - `globals: false` — tests must `import { describe, it, expect } from 'vitest'` explicitly (matches our `verbatimModuleSyntax` rule).
  - `environment: 'node'` — no JSDOM; we're testing a backend.
  - `pool: 'threads'` with `singleThread: false` — Vitest can parallelize because each test that needs a DB will use `:memory:` per D-33.

4. Create `biome.json` at repo root with EXACT contents. Biome replaces ESLint+Prettier per STACK.md:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": true,
    "ignore": ["node_modules", "dist", "data", "coverage", "*.tsbuildinfo"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      },
      "style": {
        "useConst": "error",
        "useTemplate": "error",
        "noNonNullAssertion": "error"
      },
      "suspicious": {
        "noExplicitAny": "error",
        "noConsoleLog": "warn"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all",
      "semicolons": "always",
      "arrowParentheses": "always"
    }
  },
  "json": {
    "formatter": {
      "enabled": true
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

Notes:
  - `noNonNullAssertion: error` — no `!` operator allowed. Forces proper null handling, which matters when dealing with `stmt.get()` that can return `undefined`.
  - `noConsoleLog: warn` — we use `pino` for real logging; `console.log` only in placeholder/dev code.
  - `noExplicitAny: error` — forces `unknown` + narrowing for untyped inputs.

**Verify:**

```xml
<verify>
  <automated>test -f tsconfig.json && test -f tsconfig.build.json && test -f vitest.config.ts && test -f biome.json && node -e "JSON.parse(require('fs').readFileSync('tsconfig.json','utf8'))" && node -e "JSON.parse(require('fs').readFileSync('tsconfig.build.json','utf8'))" && node -e "JSON.parse(require('fs').readFileSync('biome.json','utf8'))"</automated>
</verify>
```

**Done:**
- `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `biome.json` all exist at repo root.
- All JSON configs parse as valid JSON.
- `tsconfig.json` has `"strict": true` and `"module": "NodeNext"`.

**Commit message:** `chore(tooling): add tsconfig, vitest, and biome configuration`

---

#### Task 3: Install dependencies and verify the toolchain runs end-to-end

**Files:**
- `package-lock.json` (generated by npm)
- `node_modules/` (generated, not committed)

**Action:**

1. From the repo root, run `npm install`. This must succeed and produce `package-lock.json` + `node_modules/` including a working `better-sqlite3` native binding. On Windows (dev machine) the native prebuilt should download automatically — if it fails, the error message is actionable (needs Python / MSBuild). Do NOT add `"better-sqlite3": "file:..."` workarounds; prebuilts are available for Node 22 on Windows/macOS/Linux.

2. Run `npm run typecheck` — must pass with zero errors (only `src/index.ts` placeholder + no tests yet).

3. Run `npm run check` — Biome must pass with zero errors. If it fails on `src/index.ts`, adjust only the placeholder comment formatting to match Biome's format (re-run `npm run check:fix` once, then re-commit the fixed file).

4. Run `npm test` — Vitest must run and report "No test files found" gracefully with exit code 0 (Vitest 2.x returns 0 when no tests are present; confirm with `echo $?` on bash or `echo %ERRORLEVEL%` on cmd). If Vitest 2.x returns non-zero on no tests, add a minimal sentinel test at `tests/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('toolchain smoke test', () => {
  it('runs at all', () => {
    expect(1 + 1).toBe(2);
  });
});
```

5. Do a native-module sanity check that will catch OS-specific issues now, not later. Run:

```
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('CREATE TABLE t(x INTEGER)'); db.prepare('INSERT INTO t(x) VALUES(?)').run(42); const row = db.prepare('SELECT x FROM t').get(); console.log('ok:', row.x); db.close();"
```

Expected output: `ok: 42`. This confirms better-sqlite3's native binding loaded and basic prepared-statement round-trip works on this OS. Document in the commit that this was verified on the current OS; the Docker image (Phase 8) will re-verify on linux/musl at build time.

**Verify:**

```xml
<verify>
  <automated>npm install && npm run typecheck && npm run check && npm test && node -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE TABLE t(x INTEGER)');db.prepare('INSERT INTO t(x) VALUES(?)').run(42);const r=db.prepare('SELECT x FROM t').get();if(r.x!==42)process.exit(1);db.close();console.log('native ok');"</automated>
</verify>
```

**Done:**
- `npm install` succeeds and `package-lock.json` is generated.
- `npm run typecheck` exits 0.
- `npm run check` exits 0.
- `npm test` exits 0.
- The better-sqlite3 native smoke check prints `ok: 42` (or `native ok`) — confirming the driver works on the current machine.

**Commit message:** `chore(deps): install pinned dependencies and verify toolchain`

---

## Verification

Run all four toolchain commands sequentially from the repo root. All must exit 0:

```bash
npm install
npm run typecheck
npm run check
npm test
```

Plus the better-sqlite3 native smoke check (task 3, step 5).

If any of these fail, do NOT proceed to plan 02. Fix the scaffolding first — subsequent plans assume this environment works.

## Success criteria

- `package.json` has `"type": "module"`, `"engines.node": ">=22.0.0 <23"`, and the exact dependency set above.
- `tsconfig.json` has `strict: true`, `module: NodeNext`, `noUncheckedIndexedAccess: true`.
- `vitest.config.ts` uses `environment: 'node'`, `globals: false`.
- `biome.json` has lint + format enabled with `quoteStyle: single`, `semicolons: always`.
- `.gitignore` ignores `node_modules/`, `dist/`, `data/*.db*`, `data/attachments/`, `.env`.
- Toolchain (install / typecheck / lint / test / native sqlite) all succeed on the developer's machine.

## Output

After completion, create `.planning/phases/02-storage-layer/02-01-SUMMARY.md` listing: locked package versions (from `package-lock.json` — read the resolved versions of `better-sqlite3`, `vitest`, `typescript`, `@biomejs/biome`), the `src/` folder tree, and any OS-specific gotchas encountered during `npm install` (especially Windows MSBuild prompts or Alpine musl issues, if any).
