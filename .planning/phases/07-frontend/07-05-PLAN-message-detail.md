---
phase: 7
plan: 5
status: ready
type: execute
wave: 4
depends_on: [07-04]
requirements: [UI-06, UI-07, UI-08, UI-09, UI-10]
files_modified:
  - web/src/lib/components/MessageDetail.svelte
  - web/src/lib/components/HtmlSandbox.svelte
  - web/src/lib/components/AttachmentList.svelte
  - web/src/lib/sandbox.ts
autonomous: true
tags: [ui, sandbox, iframe, csp, xss-defense]
must_haves:
  truths:
    - "Iframe rendered with sandbox='allow-popups' — NO allow-scripts, NO allow-same-origin"
    - "srcdoc wraps sanitized HTML with <meta http-equiv='Content-Security-Policy' content='default-src \"none\"; img-src data:; style-src \"unsafe-inline\";'>"
    - "'Load images' toggle changes CSP to img-src data: https:; per-message only (never sticky across messages)"
    - "Text view is the DEFAULT; HTML tab appears only when hasHtmlBody"
    - "Attachment list: filename + size + content-type; click navigates to URL (browser downloads via Content-Disposition)"
    - "Esc or back button closes the detail view"
---

# Plan 07-05: Message detail + HTML sandbox + attachments

## Goal

Clicking a message in the list opens the detail view (bottom-sheet on mobile, side panel on desktop). Renders plain text by default; optional HTML tab shows server-sanitized HTML inside a sandboxed iframe with CSP-locked srcdoc. Remote content blocked by default; per-message "Load images" toggle.

## Must-have checklist

- [ ] `sandbox.ts` pure function: `buildSrcdoc(sanitizedHtml, { allowRemoteImages })` → string
- [ ] The CSP inside srcdoc is the authoritative gate (blocks `<script>`, XHR, fonts, etc.)
- [ ] Iframe `sandbox="allow-popups"` only
- [ ] Iframe max-height with inner scroll (D-29 fallback); height auto-resize attempted via postMessage
- [ ] Tabs: Text (default) / HTML (if available) / Attachments
- [ ] "Load images" button on HTML tab — toggles remote-image permission per message
- [ ] "Load images" state resets when user switches to another message
- [ ] Attachment rows: name, size (human-readable), type, download link

## Tasks

<task type="auto">
  <name>Task 1: sandbox.ts — buildSrcdoc pure function</name>
  <files>web/src/lib/sandbox.ts</files>
  <action>
  Export `buildSrcdoc(html: string, opts: { allowRemoteImages: boolean }): string`.
  - Prepend `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{font-family:system-ui;margin:8px;color:#111} img{max-width:100%}</style></head><body>`, append `</body></html>`.
  - CSP: `allowRemoteImages ? "default-src 'none'; img-src data: https:; style-src 'unsafe-inline';" : "default-src 'none'; img-src data:; style-src 'unsafe-inline';"`
  </action>
  <verify>
    <automated>cd web && npx tsc --noEmit</automated>
  </verify>
  <done>Module compiles.</done>
  <commit>feat(07): sandbox srcdoc builder with CSP toggle</commit>
</task>

<task type="auto">
  <name>Task 2: sandbox.ts unit tests</name>
  <files>web/src/lib/sandbox.test.ts</files>
  <action>
  Vitest: default CSP blocks https images. With `allowRemoteImages`, CSP string contains `img-src data: https:`. XSS strings like `<script>alert(1)</script>` remain in srcdoc (we don't sanitize here — Phase 4 does) but CSP blocks execution.
  </action>
  <verify>
    <automated>cd web && npm test -- --run sandbox</automated>
  </verify>
  <done>All sandbox tests pass.</done>
  <commit>test(07): sandbox CSP toggle coverage</commit>
</task>

<task type="auto">
  <name>Task 3: HtmlSandbox + AttachmentList + MessageDetail</name>
  <files>web/src/lib/components/HtmlSandbox.svelte, web/src/lib/components/AttachmentList.svelte, web/src/lib/components/MessageDetail.svelte</files>
  <action>
  - `HtmlSandbox`: props `html`, `allowImages`. Renders `<iframe srcdoc={buildSrcdoc(html, {allowRemoteImages: allowImages})} sandbox="allow-popups" class="w-full min-h-[240px] max-h-[70vh] border-0" title="Email content" referrerpolicy="no-referrer">`.
  - `AttachmentList`: rows with lucide `Paperclip`, filename, `formatBytes(size)`, download anchor.
  - `MessageDetail`: tabs (Text default / HTML / Attachments); "Back" button; Esc key closes; "Load images" toggle resets when `message.id` changes.
  </action>
  <verify>
    <automated>cd web && npm run check</automated>
  </verify>
  <done>svelte-check clean.</done>
  <commit>feat(07): message detail with sandboxed html + attachments</commit>
</task>

<task type="auto">
  <name>Task 4: Wire MessageDetail into +page.svelte</name>
  <files>web/src/routes/+page.svelte</files>
  <action>
  Add `selected = $state<FullMessageView | null>(null)`. On list select: `getMessage(inbox.id, msg.id)` → set selected. Show MessageDetail when selected != null.
  </action>
  <verify>
    <automated>cd web && npm run build</automated>
  </verify>
  <done>Build succeeds; page renders detail panel wired.</done>
  <commit>feat(07): wire message detail into landing page</commit>
</task>

## Verification

```bash
cd web
npm run check
npm run build
npm test -- --run
```

## Success Criteria

- Iframe emits CSP meta tag — no scripts execute
- Remote image blocked by default — only fetched after button click
- Attachments download (Content-Disposition path)
