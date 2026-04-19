---
phase: 7
plan: 3
status: ready
type: execute
wave: 2
depends_on: [07-01]
requirements: [UI-01, UI-03]
files_modified:
  - web/src/lib/state.svelte.ts
  - web/src/lib/storage.ts
  - web/src/lib/time.ts
autonomous: true
tags: [state, runes, countdown]
must_haves:
  truths:
    - "Svelte 5 runes: $state, $derived used; no writable() stores"
    - "localStorage persists only lastInboxId + lastInboxAddress + lastInboxExpiresAt"
    - "No view-token persisted anywhere (cookie only, HttpOnly)"
    - "Countdown timer ticks every 1000ms via $effect"
    - "reviveOrMint() → GET existing id; on 404/403/401 → POST new"
---

# Plan 07-03: State runes + first-visit flow

## Goal

A single `state.svelte.ts` module exposes reactive session state (current inbox, messages, countdown, toast, loading) plus imperative helpers (`reviveOrMint`, `mintNewInbox`, `refreshMessages`, `appendLiveMessage`). Built on Svelte 5 runes.

## Must-have checklist

- [ ] `state.svelte.ts` exports reactive values via module-level `$state` rebranded as functions (Svelte 5 idiom)
- [ ] `reviveOrMint()` tries `getInbox(lastInboxId)` then falls back to `createInbox()`
- [ ] `mintNewInbox()` exposed for "New inbox" button
- [ ] Countdown: `remainingMs = expiresAt - now`, derived into `mm:ss`
- [ ] At `remainingMs <= 60_000` unseen → emit toast "Inbox expires soon"
- [ ] At `remainingMs <= 0` → auto-`mintNewInbox()`
- [ ] localStorage keys namespaced `tempmail:lastInboxId` etc
- [ ] localStorage helpers guard for SSR safety / private-mode failures

## Tasks

<task type="auto">
  <name>Task 1: storage.ts + time.ts</name>
  <files>web/src/lib/storage.ts, web/src/lib/time.ts</files>
  <action>
  `storage.ts`: `readLastInbox()`, `writeLastInbox({id,address,expiresAt})`, `clearLastInbox()` — try/catch window.localStorage.
  `time.ts`: `formatMmSs(ms)`, `formatRelative(iso)`.
  </action>
  <verify>
    <automated>cd web && npx tsc --noEmit</automated>
  </verify>
  <done>Both modules compile.</done>
  <commit>feat(07): storage + time helpers</commit>
</task>

<task type="auto">
  <name>Task 2: state.svelte.ts runes module</name>
  <files>web/src/lib/state.svelte.ts</files>
  <action>
  Module-level `$state` for: currentInbox, messages (array, sorted ASC), loading, toast. `$derived` for countdown. Export functions: `initSession()`, `reviveOrMint()`, `mintNewInbox()`, `refreshMessages()`, `appendLiveMessage(msg)`, `bumpExpiry()`, `pushToast(type,message)`, `dismissToast()`.
  </action>
  <verify>
    <automated>cd web && npx svelte-check --fail-on-warnings</automated>
  </verify>
  <done>Svelte-check clean.</done>
  <commit>feat(07): session state runes + revive-or-mint flow</commit>
</task>

<task type="auto">
  <name>Task 3: Unit tests for storage + time</name>
  <files>web/src/lib/storage.test.ts, web/src/lib/time.test.ts</files>
  <action>
  Vitest: `formatMmSs(90_000) === '01:30'`, `formatRelative` produces "just now" / "5s ago". Storage write/read roundtrip with mocked localStorage.
  </action>
  <verify>
    <automated>cd web && npm test -- --run</automated>
  </verify>
  <done>Tests pass.</done>
  <commit>test(07): storage + time unit coverage</commit>
</task>

## Verification

```bash
cd web
npm run check
npm test -- --run
```

## Success Criteria

- Runes compile clean
- Countdown formats correctly
- No view-token in localStorage (grep fails to find it)
