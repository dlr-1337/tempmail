---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
last_updated: "2026-04-19T14:13:15.097Z"
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 0
  completed_plans: 7
---

# Project State: Tempmail

**Last updated:** 2026-04-18 (03-02 plan complete)

## Project Reference

**Core Value:** Visit → get inbox → receive email — in under 3 seconds, with zero signup.

**What This Is:** Public, anonymous, self-hosted, receive-only disposable email. One Node 22 process running the MX (smtp-server), HTTP API (Fastify), in-process event bus (EventEmitter), and sweeper; SQLite (WAL) + disk-sharded attachments; Caddy reverse proxy; SvelteKit static frontend; Docker Compose deploy. Single VPS, $0 recurring beyond VPS + domain.

**Current Focus:** Phase 3 (core domain logic) execution. Plans 03-01 (event bus) and 03-02 (inboxes) complete on `gsd/phase-02-storage-layer`. Plans 03-03 (messages) and 03-04 (composition root) are planned and queued.

## Current Position

**Phase:** 3 (core domain logic) — in progress
**Plan:** 03-02 complete; 03-03 (messages) is next
**Status:** Phase 3 mid-execution (2 of 4 plans done)
**Progress:** `██░░░░░░░ 2 / 9 phases` (Phase 3 at 2/4 plans)

## Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| Phases total | 9 | granularity=deep |
| Requirements mapped | 76 / 76 | 100% |
| Launch-blockers in v1 | All | per PITFALLS.md |
| Parallel windows | 2 | Phase 4∥5, Phase 5∥7 |
| Phases completed | 0 | Phase 3 at 2/4 plans (03-01, 03-02) |
| Plans completed in Phase 3 | 2 / 4 | 03-01 event bus, 03-02 inboxes |
| Tests passing (cumulative) | 66 | 57 pre-03-02 + 9 new in 03-02 |
| Plan 03-02 duration | ~20 min | createInbox + expireInbox + 9 cases |

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

### Current Todos

- [ ] Execute plan 03-03 (messages — ingestMessage + listMessages, bus emit after commit).
- [ ] Execute plan 03-04 (composition root — createCore(deps) wiring).
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

**Next session entry point:** Execute plan 03-03 (messages) — the next sequential plan in Phase 3. Prereqs (03-01 bus, 03-02 inboxes + standalone `verifyViewToken` export) are in place on `gsd/phase-02-storage-layer`. Afterward: plan 03-04 (composition root).

**To resume from scratch:** read `.planning/ROADMAP.md` (phase structure + success criteria), `.planning/REQUIREMENTS.md` (traceability table), then this file for current position.

**Artifacts written by roadmapper:**

- `.planning/ROADMAP.md` — nine phases, 76/76 requirements mapped
- `.planning/STATE.md` — this file
- `.planning/REQUIREMENTS.md` — traceability section updated with phase mappings

---
*State initialized: 2026-04-18 at roadmap creation*
