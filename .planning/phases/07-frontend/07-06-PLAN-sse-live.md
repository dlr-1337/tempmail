---
phase: 7
plan: 6
status: ready
type: execute
wave: 4
depends_on: [07-04]
requirements: [RT-01, RT-02, RT-03]
files_modified:
  - web/src/lib/sse.ts
  - web/src/lib/state.svelte.ts
autonomous: true
tags: [sse, realtime, eventsource]
must_haves:
  truths:
    - "subscribeInboxStream(inboxId) opens EventSource to /api/inbox/:id/stream"
    - "Incoming 'message' events are parsed and appended to state.messages via state.appendLiveMessage"
    - "EventSource auto-reconnect with Last-Event-ID (browser native) — no manual reconnect code"
    - "Stream lifecycle tied to mount: new stream per current inbox; disposed on mint-new or unmount"
    - "New message triggers bumpExpiry() (refetches expiresAt)"
---

# Plan 07-06: SSE subscription and live updates

## Goal

Subscribe to the Phase 5 SSE stream the moment we have an inbox id. Let the browser handle reconnect + Last-Event-ID. Messages arriving via SSE flow into the reactive state and update the list in real time.

## Must-have checklist

- [ ] `sse.ts` exports `subscribeInboxStream(inboxId, handlers)` returning `{ close() }`
- [ ] Handlers: `onMessage(FullMessageView)`, `onError(Error)`, `onOpen()`
- [ ] State integration: when new message arrives, `appendLiveMessage()` + `bumpExpiry()`
- [ ] Stream torn down + re-opened when inbox id changes (mint-new)
- [ ] No manual reconnect — EventSource does it
- [ ] Graceful when cookie path mismatch (SSE fails → toast "connection lost, refreshing…" → refreshMessages())

## Tasks

<task type="auto">
  <name>Task 1: sse.ts wrapper</name>
  <files>web/src/lib/sse.ts</files>
  <action>
  Export `subscribeInboxStream(inboxId, { onMessage, onOpen, onError })`. Opens `EventSource(${API_BASE}/inbox/${inboxId}/stream, { withCredentials: true })`. Listens to `'message'` event, parses JSON → `onMessage(view)`. Returns `{ close }`. Heartbeat comments (lines starting with `:`) ignored automatically.
  </action>
  <verify>
    <automated>cd web && npx tsc --noEmit</automated>
  </verify>
  <done>Wrapper compiles.</done>
  <commit>feat(07): sse event-source wrapper</commit>
</task>

<task type="auto">
  <name>Task 2: state integration — startStream()/stopStream()</name>
  <files>web/src/lib/state.svelte.ts</files>
  <action>
  Add private `streamHandle` + `startStream(inboxId)` + `stopStream()`. Called from `initSession()` after reviveOrMint succeeds, and re-called after `mintNewInbox()`.
  </action>
  <verify>
    <automated>cd web && npm run check</automated>
  </verify>
  <done>Integration compiles.</done>
  <commit>feat(07): session auto-subscribes to live sse stream</commit>
</task>

<task type="auto">
  <name>Task 3: Unit test for sse.ts</name>
  <files>web/src/lib/sse.test.ts</files>
  <action>
  Mock `globalThis.EventSource`; verify `subscribeInboxStream` attaches listener, parses JSON, calls onMessage with parsed object, `close()` closes the source.
  </action>
  <verify>
    <automated>cd web && npm test -- --run sse</automated>
  </verify>
  <done>Tests pass.</done>
  <commit>test(07): sse wrapper event handling</commit>
</task>

## Verification

```bash
cd web
npm run check
npm test -- --run
```

## Success Criteria

- SSE wrapper unit-tested with mocked EventSource
- Messages arriving via stream show up live in MessageList
- mint-new properly closes old stream and opens new one
