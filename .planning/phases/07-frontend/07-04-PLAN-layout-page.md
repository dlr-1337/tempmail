---
phase: 7
plan: 4
status: ready
type: execute
wave: 3
depends_on: [07-02, 07-03]
requirements: [UI-01, UI-02, UI-03, UI-04, UI-05, UI-11, UI-12]
files_modified:
  - web/src/routes/+layout.svelte
  - web/src/routes/+layout.ts
  - web/src/routes/+page.svelte
  - web/src/routes/privacy/+page.svelte
  - web/src/lib/components/AddressCard.svelte
  - web/src/lib/components/CopyButton.svelte
  - web/src/lib/components/Countdown.svelte
  - web/src/lib/components/MessageList.svelte
  - web/src/lib/components/Toast.svelte
  - web/src/lib/components/Footer.svelte
autonomous: true
tags: [layout, ui, components, mobile-first]
must_haves:
  truths:
    - "Mobile-first responsive — 360×640 viewport has no horizontal scroll"
    - "Tap targets ≥ 44×44 CSS px on all buttons"
    - "Address shown large + copy-to-clipboard button with checkmark animation"
    - "Countdown visible with mm:ss"
    - "'New inbox' button prominent"
    - "Message list: sender, subject, relative receivedAt, attachment badge"
    - "Empty state: 'Waiting for mail…' with address + copy button"
    - "Privacy link in footer on every page"
    - "/privacy static page with retention disclosure"
    - "System fonts only"
---

# Plan 07-04: Main layout + landing page

## Goal

Build the complete static landing experience: root layout, mobile-first responsive main page, component library (address card, copy button, countdown, message list, toast, footer), and `/privacy` page.

## Must-have checklist

- [ ] `+layout.svelte` mounts session on first load (calls `initSession()`)
- [ ] Header displays app name; footer has privacy link
- [ ] `AddressCard` shows large address + copy button
- [ ] `CopyButton` uses Clipboard API with `textarea` fallback
- [ ] `Countdown` shows mm:ss live
- [ ] "New inbox" button triggers `mintNewInbox()` with confirm
- [ ] `MessageList` empty state: "Waiting for mail…"
- [ ] Each message row: sender • subject • 5s ago • paperclip badge if attachments
- [ ] `Toast` component binds to `state.toast`
- [ ] `/privacy` page static, served statically

## Tasks

<task type="auto">
  <name>Task 1: Components (CopyButton, Countdown, Toast, Footer)</name>
  <files>web/src/lib/components/CopyButton.svelte, web/src/lib/components/Countdown.svelte, web/src/lib/components/Toast.svelte, web/src/lib/components/Footer.svelte</files>
  <action>
  - `CopyButton`: prop `text`. On click, `navigator.clipboard.writeText(text)` → show check for 1.5s. Fallback: hidden textarea + execCommand('copy').
  - `Countdown`: prop `expiresAt`. $effect ticks every 1000ms. Display mm:ss; red at <60s.
  - `Toast`: reads global toast; renders fixed-bottom on mobile, fixed-top-right on desktop.
  - `Footer`: nav with "Privacy" link + small disclaimer.
  </action>
  <verify>
    <automated>cd web && npx svelte-check --fail-on-warnings</automated>
  </verify>
  <done>All components type-check.</done>
  <commit>feat(07): copy button + countdown + toast + footer components</commit>
</task>

<task type="auto">
  <name>Task 2: AddressCard + MessageList</name>
  <files>web/src/lib/components/AddressCard.svelte, web/src/lib/components/MessageList.svelte</files>
  <action>
  - `AddressCard`: large monospace address (break-all on mobile), copy button, countdown, "New inbox" button.
  - `MessageList`: empty state ("Waiting for mail…" + tips). List of rows; rows emit `select(msg)` event; lucide `Paperclip` icon for attachments.
  </action>
  <verify>
    <automated>cd web && npx svelte-check --fail-on-warnings</automated>
  </verify>
  <done>Both components type-check.</done>
  <commit>feat(07): address card + message list components</commit>
</task>

<task type="auto">
  <name>Task 3: Root layout + main page + privacy page</name>
  <files>web/src/routes/+layout.svelte, web/src/routes/+layout.ts, web/src/routes/+page.svelte, web/src/routes/privacy/+page.svelte</files>
  <action>
  - `+layout.ts`: `export const prerender = true; export const ssr = false;`
  - `+layout.svelte`: on mount calls `initSession()`; renders `<slot>`, `<Toast>`, `<Footer>`.
  - `+page.svelte`: `<AddressCard>` + `<MessageList>`; `selected` message state; renders `<MessageDetail>` (built in 07-05) when selected.
  - `/privacy/+page.svelte`: static text — no accounts, no tracking, retention policy, abuse contact.
  </action>
  <verify>
    <automated>cd web && npm run check && npm run build && test -f build/index.html && test -f build/privacy.html</automated>
  </verify>
  <done>Build produces both pages.</done>
  <commit>feat(07): main layout + landing page + privacy route</commit>
</task>

<task type="auto">
  <name>Task 4: Unit tests — CopyButton + Countdown</name>
  <files>web/src/lib/components/CopyButton.test.ts, web/src/lib/components/Countdown.test.ts</files>
  <action>
  Vitest + @testing-library/svelte render tests. CopyButton: clicks trigger clipboard.writeText with the prop. Countdown: renders correct mm:ss from prop.
  </action>
  <verify>
    <automated>cd web && npm test -- --run</automated>
  </verify>
  <done>Tests pass.</done>
  <commit>test(07): copy button + countdown component tests</commit>
</task>

## Verification

```bash
cd web
npm run check
npm run build
npm test -- --run
```

## Success Criteria

- Build succeeds with prerendered `/` and `/privacy`
- No horizontal scroll at 360px (visual check)
- Every button ≥44px tap target (Tailwind `min-h-11 min-w-11`)
