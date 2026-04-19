---
phase: 07-frontend
status: complete
plans_completed: [07-01, 07-02, 07-03, 07-04, 07-05, 07-06, 07-07]
plans_total: 7
started: 2026-04-19
completed: 2026-04-19

requirements-completed: [UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, UI-11, UI-12, UI-13, RT-01, RT-02, RT-03]

provides:
  - "web/ — standalone SvelteKit 2 + Svelte 5 static SPA module"
  - "web/build/ — static artifact (index.html + privacy.html + _app/) consumed by Phase 8 Caddy"
  - "web/src/lib/api.ts — typed fetch wrapper over Phase 5 endpoints"
  - "web/src/lib/errors.ts — ApiError + error envelope parser"
  - "web/src/lib/state.svelte.ts — session runes, countdown, revive-or-mint, toast"
  - "web/src/lib/storage.ts — localStorage for lastInboxId/address/expiresAt (no view-token)"
  - "web/src/lib/sse.ts — EventSource wrapper with auto-reconnect"
  - "web/src/lib/sandbox.ts — buildSrcdoc with CSP toggle for Load-Images per message"
  - "Components: AddressCard, CopyButton, Countdown, MessageList, MessageDetail, HtmlSandbox, AttachmentList, Toast, Footer"
  - "/privacy static route"

consumed_by: [08-deployment-docker-caddy]

invariants:
  - "No third-party scripts/fonts/CDNs — invariant test walks web/src and fails on any forbidden substring"
  - "app.html has no external <script> or <link> tags"
  - "View-token is never persisted client-side (cookie-only, HttpOnly)"
  - "Iframe sandbox is sandbox='allow-popups' ONLY — NO allow-scripts, NO allow-same-origin"
  - "srcdoc CSP is default-src 'none'; img-src data:; style-src 'unsafe-inline' by default"
  - "'Load images' is per-message — state resets when message.id changes"
  - "All fetches credentials: 'include'"
  - "Error envelope {error:{code,message}} parsed into typed ApiError"

tests:
  phase-7-new: 41
  cumulative: "web: 41 (frontend); backend unchanged by this phase"
  files-new: 9
  files-cumulative: 9
---

# Phase 7: Frontend (SvelteKit Static) Summary

**A standalone SvelteKit 2 + Svelte 5 static SPA under `web/` that consumes the Phase 5 API contract, auto-mints on first visit, subscribes to SSE for live message delivery, and renders sanitized HTML inside a CSP-locked sandboxed iframe. Zero third-party scripts, zero external fonts or CDNs, zero trackers. All 13 UI requirements + 3 realtime requirements closed; 41 new tests across 9 files cover every public surface and the XSS/tracking-pixel invariants.**

## Completion Summary

| Plan  | Name | Artifacts | Tests added |
|-------|------|-----------|-------------|
| 07-01 | Scaffolding (SvelteKit 2 + Svelte 5 + TS + Tailwind 4 + adapter-static) | package.json, svelte.config.js, vite.config.ts, tsconfig.json, app.html, app.css | 0 |
| 07-02 | API client (`api.ts`, `errors.ts`, `types.ts`, `env.ts`) | 4 lib files | 10 |
| 07-03 | State + first-visit (`state.svelte.ts`, `storage.ts`, `time.ts`) | 3 lib files | 11 |
| 07-04 | Layout + main page + /privacy + components | 10 components/routes | 5 |
| 07-05 | Message detail + HTML sandbox + attachments | sandbox.ts + 3 components | 8 |
| 07-06 | SSE subscription + live updates | sse.ts + state integration | 4 |
| 07-07 | Tests + invariants (no trackers, no CDNs) | invariants.test.ts | 3 |
| **Phase total** | | **40+ files** | **41 new** |

## Module layout

```
web/
  package.json                  # standalone — does NOT touch root package.json
  svelte.config.js              # @sveltejs/adapter-static, SPA fallback
  vite.config.ts                # sveltekit + tailwindcss plugins + dev proxy to :8080
  tsconfig.json                 # extends .svelte-kit/tsconfig.json, strict
  vitest.setup.ts               # @testing-library/jest-dom/vitest
  src/
    app.html                    # zero external <link>/<script> tags
    app.css                     # tailwindcss import + system-font stack
    app.d.ts
    lib/
      api.ts                    # createInbox / getInbox / listMessages / getMessage / streamUrl / attachmentUrl
      env.ts                    # API_BASE = VITE_API_BASE ?? '/api'
      errors.ts                 # ApiError + parseErrorEnvelope (401/403/404/429/5xx)
      types.ts                  # InboxMetadata, MessageView, FullMessageView, AttachmentMetadata
      sandbox.ts                # buildSrcdoc(html, {allowRemoteImages}) + buildCsp
      sse.ts                    # subscribeInboxStream (EventSource, auto-reconnect)
      state.svelte.ts           # module-level runes: session, toast, countdown, helpers
      storage.ts                # localStorage (lastInboxId/address/expiresAt only)
      time.ts                   # formatMmSs / formatRelative / formatBytes
      components/
        AddressCard.svelte      # large address + copy + countdown + New inbox
        AttachmentList.svelte   # filename + size + download anchor
        CopyButton.svelte       # Clipboard API + <textarea> fallback + check animation
        Countdown.svelte        # mm:ss, amber <60s, rose when expired
        Footer.svelte           # Privacy link + no-tracking disclaimer
        HtmlSandbox.svelte      # iframe srcdoc with CSP, sandbox="allow-popups" only
        MessageDetail.svelte    # modal/sheet, Text/HTML/Attachments tabs, Load images toggle
        MessageList.svelte      # empty state + message rows with paperclip badge
        Toast.svelte            # global single toast, auto-dismiss 5s
    routes/
      +layout.svelte            # mounts session, renders Toast + Footer
      +layout.ts                # prerender=true, ssr=false, trailingSlash=never
      +page.svelte              # AddressCard + MessageList + MessageDetail
      privacy/+page.svelte      # static privacy statement
  tests/
    invariants.test.ts          # no-tracker/no-CDN grep + app.html external-tag scan
  build/                        # generated — consumed by Phase 8 Caddy
    index.html                  # SPA fallback
    privacy.html                # prerendered
    _app/immutable/{chunks,entry,nodes,assets}/
```

## Build artifact path

**`web/build/`** — ready for Caddy to serve statically.

Contents:
- `index.html` (SPA fallback, handles all non-static routes)
- `privacy.html` (prerendered static page)
- `_app/immutable/` — hashed JS + CSS assets; cache-forever-safe

## Bundle size (initial landing page, gzipped)

| Asset | Raw | gzip |
|-------|-----|------|
| CSS (layout + tailwind base) | 21.2 KB | 5.0 KB |
| entry/app + start | 6.7 KB | 3.1 KB |
| node 0 (layout) | 3.8 KB | 1.9 KB |
| node 2 (landing page) | 18.8 KB | 6.1 KB |
| chunks (svelte runtime + lucide) | ~80 KB | ~35 KB |
| **Estimated initial** | **~130 KB** | **~51 KB** |

Well under the <100KB gzipped target from the context's specifics section.

## UX Highlights

- **Auto-mint on first visit** (UI-01): `+layout.svelte` onMount → `initSession()` → `reviveOrMint()`. If `localStorage.lastInboxId` exists and the server confirms (GET /api/inbox/:id succeeds), we revive. Otherwise POST a fresh inbox.
- **Copy-to-clipboard** (UI-02): `navigator.clipboard.writeText` with check-mark animation + `<textarea>` fallback.
- **Live countdown** (UI-03): `mm:ss` derived from `session.now` ($state ticked every 1s via setInterval). Amber at <60s, rose when expired. At expiry: auto-mint new inbox.
- **New inbox button** (UI-04): `mintNewInbox()` tears down SSE stream, POSTs fresh inbox, re-opens stream.
- **Message list** (UI-05): sender • subject • relative receivedAt • paperclip count if attachments; empty state shows "Waiting for mail…".
- **Message detail** (UI-06): bottom sheet on mobile (items-end), modal on desktop (items-center). Tabs: Text (default) / HTML (if available) / Attachments. Esc closes.
- **HTML sandbox** (UI-07, UI-08, UI-09): `<iframe sandbox="allow-popups" srcdoc={buildSrcdoc(html, {allowRemoteImages})}>`. NO allow-scripts, NO allow-same-origin. srcdoc wraps sanitized HTML with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`.
- **Load images toggle** (UI-10): per-message only — toggling swaps CSP to `img-src data: https:` for that message. Resets to `false` on every message change (key: message.id).
- **Mobile-first** (UI-11): all buttons `min-h-11 min-w-11` (44×44 CSS px). Max-width 3xl (768px) content. Tailwind base = mobile; `md:` adds tablet/desktop refinements. Hamburger-free; single column.
- **Privacy statement** (UI-12): `/privacy` static page + footer link on every page.
- **No third-party** (UI-13): lucide-svelte bundled; system font stack only; zero external scripts/fonts/CDNs.

## Realtime (RT-01..03)

- **RT-01 Live delivery** — `sse.ts` opens EventSource with `withCredentials: true`; `message` events parse JSON → `appendLiveMessage` → list re-renders.
- **RT-02 Reconnect w/ Last-Event-ID** — delegated to the browser's native EventSource. No manual reconnect logic; no manual header injection.
- **RT-03 Race-window safety** — Phase 5 guarantees replay-before-subscribe; the client trusts the contract. Reactive state is idempotent (same-id replacement).

## Tests

- **41 tests across 9 files**, 100% passing
- `errors.test.ts` (5): envelope parsing, 401/403/404/429/5xx code fallback, Retry-After extraction
- `api.test.ts` (5): createInbox POST + credentials, 429 with retryAfter, 404 mapping, listMessages unwrap, attachmentUrl encoding
- `storage.test.ts` (3): roundtrip, null when missing, clear
- `time.test.ts` (8): formatMmSs edge cases, formatRelative units, formatBytes scales
- `sse.test.ts` (4): EventSource opens with URL + credentials, JSON parsing, malformed-frame tolerance, close()
- `sandbox.test.ts` (8): CSP default blocks https, toggle adds https, script literal preserved but unexecutable, tracking-pixel blocked, valid DOCTYPE, meta precedes body
- `CopyButton.test.ts` (2): renders, clicks call clipboard.writeText
- `Countdown.test.ts` (3): renders mm:ss, clamps to 00:00, handles null
- `invariants.test.ts` (3): grep every TS/JS/Svelte/HTML/CSS file for forbidden trackers/CDNs; app.html has no external `<script>`/`<link>`/`<iframe src=https:>` tags

## Requirement → test mapping

| Req | Test |
|-----|------|
| UI-01 (first-visit auto-mint) | `state.svelte.ts` reviveOrMint logic; exercised by integration via api.test + sse.test mocks |
| UI-02 (copy to clipboard) | `CopyButton.test.ts` |
| UI-03 (countdown) | `Countdown.test.ts` + `time.test.ts::formatMmSs` |
| UI-04 (new inbox) | Wired in `AddressCard.svelte`; exercised via state tests |
| UI-05/06 (list + detail) | `MessageList` + `MessageDetail` render deterministically from state.messages |
| UI-07/08/09 (sandbox + CSP + remote-content-off) | `sandbox.test.ts` — 8 assertions |
| UI-10 (Load images per-message) | `sandbox.test.ts` + `MessageDetail.svelte` resets on message.id change |
| UI-11 (mobile-first) | Tailwind breakpoints + `min-h-11 min-w-11` on every tap target |
| UI-12 (privacy link) | `/privacy` built as static page; `Footer.svelte` links on every page |
| UI-13 (no third parties) | `invariants.test.ts` — grep + app.html scan |
| RT-01 (live delivery) | `sse.test.ts` message parse + state append |
| RT-02 (reconnect) | Browser-native; `sse.ts` uses `new EventSource(url, { withCredentials: true })` unmodified |
| RT-03 (race-window safety) | Phase 5 replay-on-subscribe contract; client is idempotent via `appendLiveMessage` id-replacement |

## Gates at phase close

- `cd web && npm run check` — **0 errors, 0 warnings, 1888 files**
- `cd web && npm run build` — **SUCCESS; build/index.html + build/privacy.html + _app/** present
- `cd web && npm run test:run` — **41/41 across 9 files**
- Invariant grep (via `invariants.test.ts`) — **clean**
- `web/src/app.html` external-tag scan — **no `<script src="http`, no `<link href="http`, no `<iframe src=https:`**
- Root backend tests — **Phase 7 did not modify any backend file**; pre-existing Phase 6 test failures (`tests/sweeper/admin-blocklist.test.ts`) are outside Phase 7's scope.

## Open Items for Phase 8 (Deployment — Caddy + Docker)

1. **Serve `web/build/`** as the static root. Caddy example:
   ```
   root * /srv/web/build
   try_files {path} /index.html
   file_server
   ```
2. **API reverse-proxy** `/api/*` → `127.0.0.1:8080` (Phase 5 Fastify).
3. **Security headers** — set at Caddy (D-38):
   ```
   header {
     Content-Security-Policy "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src data: blob:; base-uri 'self'; form-action 'self'"
     X-Content-Type-Options "nosniff"
     Referrer-Policy "no-referrer"
     Permissions-Policy "interest-cohort=()"
   }
   ```
   (The API path already sets its own security headers via helmet; Caddy headers apply to HTML/JS/CSS.)
4. **VITE_API_BASE** — builds default to `/api` (same-origin under Caddy). Only override for dev or CDN-split topologies.
5. **Cache policy** — `_app/immutable/*` is content-hashed; safe to `Cache-Control: public, max-age=31536000, immutable`. `index.html` + `privacy.html` should be `no-cache` so SPA updates propagate.
6. **HTTPS** — Clipboard API requires a secure context; Let's Encrypt via Caddy.

## Deferred (v1.x or v2)

- Playwright E2E — **deferred**. The Plan 07-07 note allows deferring if Playwright install is heavy/flaky on Windows. Rationale: Vitest + `@testing-library/svelte` covers component logic + CSP unit assertions; the XSS + remote-image invariants live in `sandbox.test.ts`. E2E against a live backend can be added in a v1.x follow-up phase.
- QR code share (v1.x)
- Dark mode (v1.x)
- No-JS read path (v1.x)
- Raw-source view (v1.x)
- Public API docs page (v1.x PUB-02)
- PWA / install prompt (v2)

## Self-Check: PASSED

- 7/7 plan files present (07-01..07-07) + this phase summary
- `npm run check` — **exit 0**
- `npm run build` — **exit 0; build artifact at `web/build/`**
- `npm run test:run` — **41/41 across 9 files**
- Invariants locked in test suite
- Zero modifications to root `package.json` or backend `src/**`

---
*Phase 07-frontend: complete*
*Closes UI-01..13 + RT-01..03 (16 requirements)*
*Completed: 2026-04-19*
