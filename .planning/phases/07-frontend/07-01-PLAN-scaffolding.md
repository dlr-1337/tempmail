---
phase: 7
plan: 1
status: ready
type: execute
wave: 1
depends_on: []
requirements: [UI-13]
files_modified:
  - web/package.json
  - web/package-lock.json
  - web/svelte.config.js
  - web/vite.config.ts
  - web/tsconfig.json
  - web/postcss.config.js
  - web/tailwind.config.ts
  - web/src/app.html
  - web/src/app.css
  - web/src/app.d.ts
  - web/.gitignore
  - web/.npmrc
autonomous: true
tags: [scaffolding, sveltekit, tailwind, svelte5]
must_haves:
  truths:
    - "web/ directory self-contained (own package.json; no edits to root package.json)"
    - "SvelteKit 2 + Svelte 5 + TypeScript installed and resolvable"
    - "@sveltejs/adapter-static configured with prerender on + fallback"
    - "Tailwind CSS 4 + autoprefixer + postcss wired into Vite"
    - "lucide-svelte installed (bundled icons — no CDN)"
    - "cd web && npm run check passes (svelte-check 0)"
    - "cd web && npm run build produces web/build/"
    - "No external CDN / tracker references in web/src or web/static"
---

# Plan 07-01: Scaffolding — create web/ SvelteKit static SPA

## Goal

Create the `web/` module as a standalone SvelteKit 2 + Svelte 5 + TypeScript + Tailwind CSS 4 project that builds to a static SPA via `@sveltejs/adapter-static`. Nothing else in Phase 7 compiles without this.

## Must-have checklist

- [ ] `web/` is its own module (own `package.json`, `tsconfig.json`, `svelte.config.js`, `vite.config.ts`)
- [ ] Svelte 5 runes mode on (no Svelte 4 store patterns)
- [ ] `@sveltejs/adapter-static` → output `web/build/`
- [ ] Tailwind 4 JIT with mobile-first breakpoints (base = mobile, `md:`, `lg:`)
- [ ] System font stack only (no Google Fonts, no external fonts)
- [ ] `lucide-svelte` bundled (no CDN icons)
- [ ] `web/src/app.html` has zero external `<link>` / `<script>` tags
- [ ] Dev script (`npm run dev`), build (`npm run build`), check (`npm run check`), test (`npm test`) all wired

## Tasks

<task type="auto">
  <name>Task 1: Create web/ package.json with all deps</name>
  <files>web/package.json, web/package-lock.json, web/.npmrc, web/.gitignore</files>
  <action>
  Create `web/package.json` with SvelteKit 2, Svelte 5, TypeScript, adapter-static, Vite 5, Tailwind 4, autoprefixer, svelte-check, vitest, @testing-library/svelte, lucide-svelte. Install with `npm install`.
  </action>
  <verify>
    <automated>cd web && node -e "require('@sveltejs/kit/package.json'); require('svelte/package.json'); require('@sveltejs/adapter-static/package.json'); require('tailwindcss/package.json'); require('lucide-svelte/package.json'); console.log('ok')"</automated>
  </verify>
  <done>All packages resolvable.</done>
  <commit>chore(07): add web/ sveltekit scaffold package.json</commit>
</task>

<task type="auto">
  <name>Task 2: Write svelte.config.js + vite.config.ts + tsconfig.json</name>
  <files>web/svelte.config.js, web/vite.config.ts, web/tsconfig.json</files>
  <action>
  - `svelte.config.js`: use `vitePreprocess`, `adapter-static` with `fallback: 'index.html'` (SPA mode), `prerender: { handleMissingId: 'ignore' }`.
  - `vite.config.ts`: sveltekit plugin + tailwindcss vite plugin + dev proxy for `/api` → `http://127.0.0.1:8080`.
  - `tsconfig.json`: extends `.svelte-kit/tsconfig.json`, strict: true.
  </action>
  <verify>
    <automated>cd web && npx svelte-kit sync && npx tsc --noEmit</automated>
  </verify>
  <done>svelte-kit sync works; tsc clean.</done>
  <commit>feat(07): configure sveltekit adapter-static + vite + ts</commit>
</task>

<task type="auto">
  <name>Task 3: Tailwind 4 + postcss + global CSS</name>
  <files>web/postcss.config.js, web/tailwind.config.ts, web/src/app.css</files>
  <action>
  Configure Tailwind 4 via `@tailwindcss/vite` plugin. `src/app.css` imports `@import "tailwindcss"` + defines system-font stack + base resets. Content paths: `./src/**/*.{html,js,svelte,ts}`.
  </action>
  <verify>
    <automated>cd web && node -e "require('tailwindcss/package.json'); require('autoprefixer/package.json'); console.log('ok')"</automated>
  </verify>
  <done>Tailwind builds without error during svelte-check.</done>
  <commit>feat(07): wire tailwind css 4 with system-font stack</commit>
</task>

<task type="auto">
  <name>Task 4: Create app.html + app.d.ts shell</name>
  <files>web/src/app.html, web/src/app.d.ts</files>
  <action>
  `app.html`: minimal head with `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width,initial-scale=1">`, `<meta name="robots" content="noindex">`, `<title>tempmail</title>`, `<link rel="icon" href="data:,">`, `%sveltekit.head%`, `%sveltekit.body%`. NO external links. NO external scripts.
  `app.d.ts`: SvelteKit ambient types skeleton.
  </action>
  <verify>
    <automated>cd web && grep -rE 'googletagmanager|google-analytics|plausible|fathom|mixpanel|segment|https?://cdn' src/ static/ 2>/dev/null; test $? -eq 1</automated>
  </verify>
  <done>No tracker or CDN references anywhere under web/.</done>
  <commit>feat(07): app shell with no third-party references</commit>
</task>

<task type="auto">
  <name>Task 5: Build gate — empty route prerenders</name>
  <files>web/src/routes/+layout.ts, web/src/routes/+page.svelte</files>
  <action>
  Create a placeholder `+layout.ts` exporting `prerender = true, ssr = false` and a minimal `+page.svelte` with just `<h1>tempmail</h1>`. Ensures the build pipeline produces `web/build/index.html`.
  </action>
  <verify>
    <automated>cd web && npm run build && test -f build/index.html</automated>
  </verify>
  <done>`web/build/index.html` exists.</done>
  <commit>feat(07): placeholder route proves build pipeline</commit>
</task>

## Verification

```bash
cd web
npm run check
npm run build
test -f build/index.html
grep -rE 'googletagmanager|google-analytics|plausible|fathom|mixpanel|segment' src/ static/ 2>/dev/null && exit 1 || true
```

## Success Criteria

- `web/build/index.html` exists after build
- `npm run check` exits 0
- Zero external network references in `web/`
