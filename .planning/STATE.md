---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in-progress
last_updated: "2026-04-18T11:20:00.000Z"
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 0
  completed_plans: 8
---

# Project State: Tempmail

**Last updated:** 2026-04-18 (03-03 plan complete)

## Project Reference

**Core Value:** Visit → get inbox → receive email — in under 3 seconds, with zero signup.

**What This Is:** Public, anonymous, self-hosted, receive-only disposable email. One Node 22 process running the MX (smtp-server), HTTP API (Fastify), in-process event bus (EventEmitter), and sweeper; SQLite (WAL) + disk-sharded attachments; Caddy reverse proxy; SvelteKit static frontend; Docker Compose deploy. Single VPS, $0 recurring beyond VPS + domain.

**Current Focus:** Phase 3 (core domain logic) execution. Plans 03-01 (event bus), 03-02 (inboxes), and 03-03 (messages) complete on `gsd/phase-02-storage-layer`. Plan 03-04 (composition root) is planned and queued.

## Current Position

**Phase:** 3 (core domain logic) — in progress
**Plan:** 03-03 complete; 03-04 (composition root) is next
**Status:** Phase 3 mid-execution (3 of 4 plans done)
**Progress:** `██░░░░░░░ 2 / 9 phases` (Phase 3 at 3/4 plans)

## Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| Phases total | 9 | granularity=deep |
| Requirements mapped | 76 / 76 | 100% |
| Launch-blockers in v1 | All | per PITFALLS.md |
| Parallel windows | 2 | Phase 4∥5, Phase 5∥7 |
| Phases completed | 0 | Phase 3 at 3/4 plans (03-01, 03-02, 03-03) |
| Plans completed in Phase 3 | 3 / 4 | 03-01 event bus, 03-02 inboxes, 03-03 messages |
| Tests passing (cumulative) | 90 | 66 pre-03-03 + 24 new in 03-03 |
| Plan 03-02 duration | ~20 min | createInbox + expireInbox + 9 cases |
| Plan 03-03 duration | ~20 min | ingestMessage + listMessages + 24 cases |

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

### Current Todos

- [ ] Execute plan 03-04 (composition root — createCore(deps) wiring). Prereqs (03-01 bus, 03-02 inboxes + `verifyViewToken`, 03-03 messages) all landed.
- [ ] Collect operator input for Phase 1 (see Open Questions below) — still outstanding, blocks Phase 1 deployment work but not Phase 3 code.

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

**Last session:** 2026-04-18T11:20Z — Completed 03-03-PLAN-messages.md. No blockers.

**Next session entry point:** Execute plan 03-04 (composition root) — the last sequential plan in Phase 3. Prereqs (03-01 bus, 03-02 inboxes + standalone `verifyViewToken` export, 03-03 messages factory) are in place on `gsd/phase-02-storage-layer`. Afterward: Phase 4 (SMTP adapter) and Phase 5 (HTTP + SSE) can run in parallel.

**To resume from scratch:** read `.planning/ROADMAP.md` (phase structure + success criteria), `.planning/REQUIREMENTS.md` (traceability table), then this file for current position.

**Artifacts written by roadmapper:**

- `.planning/ROADMAP.md` — nine phases, 76/76 requirements mapped
- `.planning/STATE.md` — this file
- `.planning/REQUIREMENTS.md` — traceability section updated with phase mappings

---
*State initialized: 2026-04-18 at roadmap creation*
