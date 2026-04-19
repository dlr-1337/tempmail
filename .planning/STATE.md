---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in-progress
last_updated: "2026-04-18T11:30:00.000Z"
progress:
  total_phases: 9
  completed_phases: 1
  total_plans: 0
  completed_plans: 9
---

# Project State: Tempmail

**Last updated:** 2026-04-18 (Phase 3 complete — 03-04 composition root landed)

## Project Reference

**Core Value:** Visit → get inbox → receive email — in under 3 seconds, with zero signup.

**What This Is:** Public, anonymous, self-hosted, receive-only disposable email. One Node 22 process running the MX (smtp-server), HTTP API (Fastify), in-process event bus (EventEmitter), and sweeper; SQLite (WAL) + disk-sharded attachments; Caddy reverse proxy; SvelteKit static frontend; Docker Compose deploy. Single VPS, $0 recurring beyond VPS + domain.

**Current Focus:** Phase 3 complete. All four plans (03-01 event bus, 03-02 inboxes, 03-03 messages, 03-04 composition root) landed on `gsd/phase-02-storage-layer`. `src/core/` now exposes `createCore(deps)` as the single Phase 4/5/6 entry point; D-03 boundary is programmatically enforced by a source-grep invariant. Phase 4 (SMTP) and Phase 5 (HTTP + SSE) are unblocked and can proceed in parallel.

## Current Position

**Phase:** 3 (core domain logic) — complete
**Plan:** 03-04 (composition root) complete — last plan in Phase 3
**Status:** Phase 3 closed; ready to launch Phase 4 ∥ Phase 5
**Progress:** `███░░░░░░ 3 / 9 phases` (Phase 1 pending operator input; Phases 2 & 3 complete)

## Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| Phases total | 9 | granularity=deep |
| Requirements mapped | 76 / 76 | 100% |
| Launch-blockers in v1 | All | per PITFALLS.md |
| Parallel windows | 2 | Phase 4∥5, Phase 5∥7 |
| Phases completed | 1 | Phase 3 complete (4/4 plans); Phase 2 already complete prior |
| Plans completed in Phase 3 | 4 / 4 | 03-01 event bus, 03-02 inboxes, 03-03 messages, 03-04 composition root |
| Tests passing (cumulative) | 100 | 90 pre-03-04 + 10 new in 03-04 (4 invariant + 6 composition) |
| Plan 03-02 duration | ~20 min | createInbox + expireInbox + 9 cases |
| Plan 03-03 duration | ~20 min | ingestMessage + listMessages + 24 cases |
| Plan 03-04 duration | ~15 min | composition root + D-03 invariant + end-to-end + 10 cases |

## Accumulated Context

### Key Decisions (locked by research)

- **Stack:** Node 22 LTS + smtp-server + mailparser + Fastify 5 + better-sqlite3 12 (WAL) + Caddy 2.11 + SvelteKit 2 (adapter-static) + Docker Compose v2. All four research streams converged on this independently.
- **One-process model:** SMTP listener and HTTP server share the same Node process and the same `EventEmitter` instance. No Redis, no broker, no cross-process IPC.
- **Attachments on disk, metadata in DB:** SHA-256-keyed, sharded into `/data/attachments/<aa>/<bb>/<sha256>`. Never as SQLite BLOBs.
- **Catch-all DISABLED at SMTP:** `onRcptTo` rejects unknown recipients with 550. Amplification vector blocked at the cheapest layer.
- **Replay-on-subscribe SSE:** Persistent store is source of truth; pub/sub is only a nudge. Messages stored before subscribe are always replayed.
- **Address entropy ≥64 bits + separate view-token in HttpOnly cookie:** Address is for senders; view-token is for reads. Never put view-token in URL.
- **SPF `-all`, DMARC `p=reject`, no DKIM selector:** Receive-only posture. Explicitly disavow sending.
- **Retention: 10 min idle, 1 hr hard ceiling:** All research streams agree. Locked unless operator overrides.
- **Domain is a first-class column from day one:** v1 ships one domain; data model supports rotation without migration.

### Plan 03-03 Decisions (messages)

- **D-11 emit-after-commit locked into implementation:** the repo's synchronous `withTransaction` returns only after COMMIT; `bus.emit` is textually (and therefore execution-order) AFTER the insert return. A subscriber that re-queries via the repos in its listener is guaranteed to see the new row — proved by test 1.
- **D-15 wrong-token → forbidden:** `listMessages` reuses the standalone `verifyViewToken` from plan 03-02 — single source of truth, no re-implementation drift. Wrong token returns `forbidden`, NEVER `not_found`, to prevent enumeration.
- **AttachmentView locked to {id, filename, contentType, size}:** no `sha256`, no `storage_path`, no body strings — enforced by a string-serialization test that asserts those substrings do not appear anywhere in the response JSON. Bodies are returned by the single-message endpoint (Phase 5 API-04), not by the list view.
- **Envelope parser is stricter than RFC 5321:** no quoted local-parts, no source routes — core layer can afford strictness because the SMTP adapter (Phase 4) is already filtering. Malformed envelope → `invalid_envelope` result, no throw.
- **Defensive attachment reject (D-14):** regex `^[0-9a-f]{64}$` + non-empty path, enforced before DB contact and before bus emit. Uppercase hex, wrong-length, non-hex chars, and empty paths all trip the `invalid_attachment` branch.

### Plan 03-04 Decisions (composition root)

- **One `createBus()` per `createCore()` locked in** — asserted at the api level by composition test 2 (`a.bus !== b.bus` across two cores sharing repos+store). Phase 5's SSE handler gets exactly the process-wide bus the SMTP adapter emits into — no split-brain subscribers.
- **Broader D-03 invariant regex (deviation Rule 2):** specifier-anchored (`['"]better-sqlite3['"]`, `['"]node:fs(?:\/promises)?['"]`) rather than the plan's `from\s+...` / `require\s*\(...\)` pair. The plan's original regex missed bare side-effect imports like `import 'better-sqlite3';` — which was exactly the offender the plan's own `<done>` step used for manual verification. Broader anchor catches every import form (from / bare / dynamic `import()` / CommonJS `require`) with zero false positives in `src/core/`.
- **Deps pass-through without defaulting at the composition layer** — `now`/`id` defaults flow to the inner factories (`now ?? nowMs`, `id ?? newId`). Tests override any dep end-to-end; production leaves them unset.
- **D-03 now enforced at both levels:** Phase 2's runtime spy invariant (prepared-statement-invariant.test.ts) + Phase 3 plan 04's source-grep invariant (no-direct-db.test.ts). A refactor that sneaks `better-sqlite3` or `node:fs` into `src/core/` fails red at test time with a file path in the assertion message.

### Current Todos

- [ ] Collect operator input for Phase 1 (see Open Questions below) — still outstanding, blocks Phase 1 deployment work only.
- [ ] Launch Phase 4 (SMTP adapter) and Phase 5 (HTTP + SSE) in parallel — both depend only on Phase 3 outputs, which are now frozen.

### Known Blockers

- **None** at planning level — all phases are fully planned.
- **Phase 1 execution blockers:** see Open Questions (domain, VPS provider/specs, `abuse@` destination).

## Open Questions Blocking Execution

Source: PROJECT.md Key Decisions + research/SUMMARY.md "Open Questions Pending Operator Input". These block **Phase 1 execution only** — downstream phases can be planned (and Phase 2 + Phase 3 can be partially built against a placeholder `.env.DOMAIN`) without them.

| # | Question | Blocks | Default if unanswered |
|---|----------|--------|-----------------------|
| 1 | **Domain name** — what domain will the service run on? | Phase 1 (DNS records), Phase 8 (Caddyfile, TLS cert), Phase 9 (send tests) | None — must be answered before Phase 1 ships |
| 2 | **VPS provider identity** (Hetzner, OVH, DigitalOcean, …) | Phase 1 (AUP review, port-25 verification, fallback provider) | None — must be answered; second provider pre-vetted as fallback per INFRA-08 |
| 3 | **VPS specs confirmation** (RAM, vCPU) | Phase 8 (Docker vs systemd fork — if <1 GB RAM, ship systemd units by default) | Assume 1–2 GB RAM / 1 vCPU per PROJECT.md |
| 4 | **`abuse@<domain>` destination mailbox** — where should abuse complaints route? | Phase 1 (INFRA-06 — must be a real inbox the operator reads within hours; cannot be the tempmail service itself) | None — must be answered |
| 5 | **Attachment policy fork** — accept with 10 MB cap (default) vs reject at SMTP | Phase 4 (SMTP size config) | Accept with 10 MB per-message cap, 25 MB per-inbox cap |
| 6 | **Runtime fork: Bun vs Node 22** | Phase 3+ | Node 22 (default; Bun revisit after v1) |
| 7 | **Frontend fork: SvelteKit vs HTMX** | Phase 7 | SvelteKit (default) |

## Session Continuity

**Last session:** 2026-04-18T11:30Z — Completed 03-04-PLAN-composition-root.md. Phase 3 closed. No blockers.

**Next session entry point:** Plan Phase 4 (SMTP adapter) and Phase 5 (HTTP + SSE) — both depend only on Phase 3 outputs and can execute in parallel on separate worktrees. Entry points for both: `import { createCore } from 'src/core/index.js'` at process startup, then call `ingestMessage` (Phase 4), `createInbox` / `listMessages` / `bus.on('message', ...)` (Phase 5). Phase 6 (sweeper) waits on Phase 4 + Phase 5 landing first so the operational guarantees align with the HTTP rate limits and SMTP temp-fails.

**To resume from scratch:** read `.planning/ROADMAP.md` (phase structure + success criteria), `.planning/REQUIREMENTS.md` (traceability table), then this file for current position.

**Artifacts written by roadmapper:**

- `.planning/ROADMAP.md` — nine phases, 76/76 requirements mapped
- `.planning/STATE.md` — this file
- `.planning/REQUIREMENTS.md` — traceability section updated with phase mappings

---
*State initialized: 2026-04-18 at roadmap creation*
