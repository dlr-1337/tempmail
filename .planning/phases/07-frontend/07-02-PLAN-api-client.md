---
phase: 7
plan: 2
status: ready
type: execute
wave: 2
depends_on: [07-01]
requirements: [UI-01, UI-02, UI-05, UI-06]
files_modified:
  - web/src/lib/api.ts
  - web/src/lib/types.ts
  - web/src/lib/errors.ts
  - web/src/lib/env.ts
autonomous: true
tags: [api-client, fetch, types]
must_haves:
  truths:
    - "Typed wrapper for every Phase 5 endpoint (mint, get-inbox, list-messages, get-message, open-stream, download-attachment)"
    - "All requests use credentials: 'include'"
    - "Error envelope { error: { code, message } } parsed into typed ApiError"
    - "401/403/404/429/5xx classified and re-thrown for callers"
    - "VITE_API_BASE env honored (default '/api')"
    - "No external network references; fetch only hits the configured base"
---

# Plan 07-02: API client — typed fetch wrapper over Phase 5

## Goal

`web/src/lib/api.ts` exposes a small set of async functions that match the Phase 5 contract exactly, with typed responses, error-envelope parsing, and a single shared `ApiError` class carrying `code`, `message`, `status`, and optional `retryAfter`.

## Must-have checklist

- [ ] `createInbox()`: POST `/api/inbox` → `{ id, address, expiresAt, createdAt, messageCount }`
- [ ] `getInbox(id)`: GET metadata
- [ ] `listMessages(id)`: GET messages list (ASC)
- [ ] `getMessage(id, msgId)`: GET full message
- [ ] `openStream(id)`: returns `EventSource`
- [ ] `attachmentUrl(id, attId)`: returns absolute URL (no fetch; caller uses anchor)
- [ ] `ApiError` class with `code`, `message`, `status`, `retryAfter`
- [ ] All fetches use `credentials: 'include'`
- [ ] `VITE_API_BASE` honored; defaults to `/api`

## Tasks

<task type="auto">
  <name>Task 1: env + types</name>
  <files>web/src/lib/env.ts, web/src/lib/types.ts</files>
  <action>
  `env.ts` exports `API_BASE = import.meta.env.VITE_API_BASE ?? '/api'`.
  `types.ts` defines `InboxMetadata`, `MessageView`, `FullMessageView`, `AttachmentMetadata`, `ErrorEnvelope` mirroring Phase 5's types.
  </action>
  <verify>
    <automated>cd web && npx tsc --noEmit</automated>
  </verify>
  <done>Types compile.</done>
  <commit>feat(07): api types + env base url</commit>
</task>

<task type="auto">
  <name>Task 2: ApiError + errors.ts</name>
  <files>web/src/lib/errors.ts</files>
  <action>
  `ApiError extends Error { code: string; status: number; retryAfter?: number }`. Helper `parseErrorEnvelope(res: Response, body: unknown): ApiError`.
  </action>
  <verify>
    <automated>cd web && npx tsc --noEmit</automated>
  </verify>
  <done>Errors module compiles.</done>
  <commit>feat(07): ApiError class and envelope parser</commit>
</task>

<task type="auto">
  <name>Task 3: api.ts fetch wrapper</name>
  <files>web/src/lib/api.ts</files>
  <action>
  `request<T>(method, path, { body?, signal? })` → performs fetch with `credentials: 'include'`, `Accept: application/json`, handles error envelope, throws `ApiError` on non-2xx. Export `createInbox`, `getInbox`, `listMessages`, `getMessage`, `openStream`, `attachmentUrl`.
  </action>
  <verify>
    <automated>cd web && npx tsc --noEmit && npx svelte-check --fail-on-warnings</automated>
  </verify>
  <done>Module type-checks.</done>
  <commit>feat(07): typed api client for phase 5 endpoints</commit>
</task>

<task type="auto">
  <name>Task 4: Unit tests for ApiError + request parser</name>
  <files>web/src/lib/api.test.ts, web/src/lib/errors.test.ts</files>
  <action>
  Vitest covers: envelope parsing, 401/403/404/429 → correct `code`, Retry-After header → `retryAfter`.
  </action>
  <verify>
    <automated>cd web && npm test -- --run</automated>
  </verify>
  <done>All tests pass.</done>
  <commit>test(07): api client error envelope coverage</commit>
</task>

## Verification

```bash
cd web
npm run check
npm test -- --run
```

## Success Criteria

- Fetch wrapper typed end-to-end
- Error envelope parsed; 429 exposes `retryAfter`
- No direct fetch calls anywhere else in the codebase
