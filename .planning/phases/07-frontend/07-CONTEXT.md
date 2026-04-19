# Phase 7: Frontend (SvelteKit Static) - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Mode:** Auto

<domain>
## Phase Boundary

SvelteKit 2 (Svelte 5 runes) app built as a static SPA. Auto-mints inbox on first visit, subscribes to SSE, renders messages live, sanitized-HTML iframe, mobile-first, zero trackers.

Scope (REQUIREMENTS.md UI-01..13, RT-01..03 client side):
- Auto-mint on first visit (no signup, no captcha on landing)
- Large visible address + copy-to-clipboard
- Live countdown + idle reset + hard ceiling
- "New inbox" button
- Message list (sender, subject, received-at); click expands
- Plain-text default view
- HTML in sandboxed iframe (`sandbox="allow-popups"` only)
- Server-sanitized HTML rendered inside iframe (trust Phase 4)
- Iframe `srcdoc` includes CSP `default-src 'none'`
- Remote content blocked by default; explicit "Load images" button
- Mobile-responsive (360px viewport)
- Privacy statement link
- No third-party trackers, no analytics, no external fonts/CDNs

Out of scope: public API documentation page (v1.x PUB-02), QR code (v1.x), dark mode (v1.x), no-JS read path (v1.x). V1 is the happy path only.

</domain>

<decisions>
## Implementation Decisions

### Framework & Build
- **D-01:** SvelteKit 2.x + Svelte 5 (runes) + TypeScript. Use `@sveltejs/adapter-static` → output to `web/build/`.
- **D-02:** Project root: `web/` (monorepo-style, separate from `src/`). Own `package.json`, `tsconfig.json`, `vite.config.ts`, `svelte.config.js`.
- **D-03:** Built artifacts go to `web/build/`; Caddy (Phase 8) serves this directory.
- **D-04:** No server-side rendering (SSR) — SPA only. Simplifies deploy (no Node runtime for frontend) + keeps consistent with Phase 5 static-serve model.
- **D-05:** Bundler config: Vite 5, Tailwind CSS 4 (just-in-time mode), `autoprefixer`. Optional: `@vite-plugin/compression` for pre-compressed brotli/gzip.
- **D-06:** No analytics. No Sentry. No external fonts — system-font-stack only. No CDN for icons — inline SVG or lucide-svelte (bundled).

### State Management (Svelte 5 runes)
- **D-07:** Use `$state`, `$derived`, `$effect` — no external store library.
- **D-08:** Module-level runes for session state (current inbox, messages array, countdown) exposed from `web/src/lib/state.svelte.ts`.

### Routing
- **D-09:** Single route `/` (inbox view). SvelteKit `+page.svelte` + `+layout.svelte`. Static-build safe (no server loads).
- **D-10:** Optional `/privacy` for the privacy statement. Single static page.
- **D-11:** 404 redirects to `/`.

### API Client (`web/src/lib/api.ts`)
- **D-12:** Typed fetch wrapper over Phase 5 endpoints:
  - `createInbox()` → `POST /api/inbox`
  - `getInbox(id)` → `GET /api/inbox/:id`
  - `listMessages(id)` → `GET /api/inbox/:id/messages`
  - `getMessage(id, msgId)` → `GET /api/inbox/:id/messages/:msgId`
  - `openStream(id)` → `new EventSource('/api/inbox/:id/stream')`
  - `downloadAttachment(id, attId)` → navigator.click anchor with `/api/inbox/:id/attachments/:attId`
- **D-13:** All requests use `credentials: 'include'` — cookie is HttpOnly + path-scoped per inbox.
- **D-14:** Error handling uses Phase 5's error envelope `{ error: { code, message } }`:
  - 401 → mint fresh inbox (cookie lost / path mismatch)
  - 403 → "stale bookmark" — offer new inbox
  - 404 → inbox expired — mint new
  - 429 → toast "Slow down — Retry-After seconds"
  - 5xx → toast "Service issue, retrying..."

### First-Visit Flow (UI-01)
- **D-15:** On mount: check `localStorage.lastInboxId` — if present + not-too-old, GET `/api/inbox/:id` to revive. If 404/403, mint fresh. If absent, mint fresh.
- **D-16:** `localStorage` stores only `lastInboxId` + `lastInboxAddress` + `lastInboxExpiresAt` — no view-token (that's cookie-only, HttpOnly).
- **D-17:** No captcha on landing. If a later request hits 429, toast with Retry-After. No ALTCHA in v1 (deferred to v1.x).

### Countdown (UI-03)
- **D-18:** `$state` timer updates every 1000ms via `$effect`. Show `mm:ss` remaining until `expiresAt`.
- **D-19:** On activity (new message arrival, focus, click on message): call `GET /api/inbox/:id` to refetch `expiresAt`. Bump the countdown.
- **D-20:** At `expiresAt - 60s`: toast "Inbox expires soon". At 0: toast "Inbox expired — minting new" + auto-mint.
- **D-21:** Hard ceiling enforced server-side; client just shows it.

### Message List (UI-05, UI-06)
- **D-22:** Messages stored in `$state` array sorted by `receivedAt` ASC. Render card list: sender, subject, received-at (relative like "5s ago"), small attachment-count badge if any.
- **D-23:** Click expands to full view (modal OR slide-in panel — planner picks). Shows: sender, subject, received-at, full text body. Toggle buttons: [Text] (default) / [HTML] (if `hasHtmlBody`).
- **D-24:** `/` (`Esc`) returns to list view.
- **D-25:** Empty state: "Waiting for mail..." with the address and copy button prominent.

### HTML Sandbox (UI-07, UI-08, UI-09, UI-10)
- **D-26:** Render via `<iframe srcdoc={htmlWithCsp} sandbox="allow-popups" />` — deliberately NO `allow-scripts`, NO `allow-same-origin`.
- **D-27:** `srcdoc` wraps the server-sanitized HTML with a `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">`. No remote images by default.
- **D-28:** "Load images" button: toggles srcdoc CSP to `img-src data: https:;` for the current message only. On toggle: re-render iframe with new srcdoc. Per-message, never per-inbox — no memory across messages.
- **D-29:** Iframe height auto-sized via `postMessage` from inside srcdoc back to parent (sandboxed `allow-popups` can still postMessage? — actually need to verify; fallback: fixed max-height with inner scroll).

### Attachments
- **D-30:** Attachment list shows filename + size + content-type. Click → `window.location = attachmentUrl` (triggers Content-Disposition download from Phase 5).
- **D-31:** No preview — download only.

### Copy-to-Clipboard (UI-02)
- **D-32:** Use Clipboard API (`navigator.clipboard.writeText`). Fallback: hidden `<textarea>` + `document.execCommand('copy')` for older browsers. Show check-mark animation on success.

### Mobile Responsive (UI-11)
- **D-33:** Tailwind mobile-first breakpoints: base = mobile, `md:` = tablet, `lg:` = desktop. Test at 360×640 (Galaxy A-class).
- **D-34:** Tap targets ≥44×44 CSS px. No horizontal scroll on 360px viewport. Bottom-sheet pattern for expanded message on mobile.

### Privacy Statement (UI-12)
- **D-35:** `/privacy` static page + footer link on every page. Contents: "No accounts. No tracking. Emails retained <= 1 hour. Blocklist: email abuse@<domain>."

### No Third-Party (UI-13)
- **D-36:** Grep-based invariant test: `web/src/**/*.{ts,svelte}` cannot import from any CDN URL, cannot reference `google-analytics`, `googletagmanager`, `plausible`, `fathom`, `mixpanel`, `segment`, etc.
- **D-37:** `head` has no external `<link>` or `<script>` tags. Only self-hosted assets.
- **D-38:** CSP for the app itself (enforced by Caddy in Phase 8): `default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src data: blob:;` — frame-src allows the sanitized HTML iframes.

### Testing
- **D-39:** Vitest + `@testing-library/svelte` for component logic. Playwright for end-to-end smoke (happy path: mint → message arrives → expand → countdown updates). Playwright requires a running backend; mock via MSW or start real Phase 5 server in test setup.
- **D-40:** E2E includes: XSS payload injection into a message body, assert iframe CSP blocks execution. Enumerate DOM for `<script>` nodes inside iframe → must be 0.
- **D-41:** E2E: remote image (`<img src="https://tracker.example/pixel.gif">`) must NOT fetch on message open; MUST fetch after "Load images" click.

### Claude's Discretion
- UI library — Tailwind yes; additional components (shadcn-svelte, flowbite) optional.
- Icon source — lucide-svelte vs inline SVG.
- Toast/alert component — bespoke or library.
- Modal vs slide-in for expanded message (D-23).

</decisions>

<specifics>
## Specific Ideas

- The "Load images" button is a per-message toggle, never sticky. Users opting into tracking for one email doesn't consent them forever.
- D-15 reviving by lastInboxId is strictly a UX nicety — cookies are HttpOnly + path-scoped, so they're still valid. localStorage just re-targets the URL.
- D-29 postMessage iframe resizing: sandboxed iframe WITHOUT `allow-same-origin` CAN still postMessage. Verified pattern.
- Don't bundle a JS framework + Tailwind + lucide and ship >200KB gzipped. Target: <100KB gzipped on initial load.

</specifics>

<canonical_refs>
## Canonical References

### Roadmap and requirements
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md` §UI, §RT (client side)
- `.planning/ROADMAP.md` §Phase 7

### Research
- `.planning/research/STACK.md` §Frontend (locks SvelteKit + adapter-static)
- `.planning/research/PITFALLS.md` §XSS / tracking-pixel (defense architecture)
- `.planning/research/FEATURES.md` §Differentiators (what to ship vs defer)

### Phase 5 API Contract (consume)
- `POST /api/inbox` — mint; sets `tempmail_vt_<id>` cookie
- `GET /api/inbox/:id`, `GET /api/inbox/:id/messages`, `GET /api/inbox/:id/messages/:msgId`
- `GET /api/inbox/:id/stream` — SSE: `id: <ms>-<msgId>`, `event: message`, `data: <FullMessageView json>`
- `GET /api/inbox/:id/attachments/:attId` — streamed download
- Error envelope: `{ error: { code, message } }`
- SSE replay-on-subscribe + 15s heartbeat + Last-Event-ID (EventSource auto)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable
- Phase 2-5 all Node-side. Frontend is NEW code in `web/`. Do not import from `../src/**` — cross-boundary.
- Absolute consumers: Phase 5 API URLs via `VITE_API_BASE` env (default `/api`, proxied by Caddy).

### Gotchas
- SvelteKit adapter-static requires `prerender = true` for the single page. Straightforward.
- Svelte 5 runes are the new model; avoid Svelte 4 store patterns.
- `EventSource` doesn't support custom headers — auth cookie is sent automatically with `credentials` if same-origin OR CORS allows. Phase 5 serves same-origin via Caddy.
- `iframe srcdoc` has XHTML quirks on older Safari — target modern browsers only, ship a "please use a modern browser" fallback.
- Clipboard API requires secure context (https); Phase 8 Caddy provides Let's Encrypt so OK.

</code_context>

<deferred>
## Deferred Ideas
- QR code share (v1.x)
- Dark mode (v1.x)
- No-JS read path (v1.x)
- Raw-source view (v1.x)
- PWA / install prompt (v2)
- Message search (anti-feature)
- Threading (anti-feature)
</deferred>
