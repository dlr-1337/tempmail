# Tempmail

## What This Is

Public, anonymous disposable email service — anyone visits the site, gets a temporary inbox, receives emails, and can throw it away. Self-hosted on the user's own VPS and domain. No accounts, no tracking, no friction.

## Core Value

**Visit → get inbox → receive email — in under 3 seconds, with zero signup.**

If everything else fails, this single flow must work reliably and feel instant.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] User receives a temporary inbox address on first visit (no signup)
- [ ] User can receive real emails sent to that address from any external sender
- [ ] User sees incoming emails in real time without manual refresh
- [ ] User can read full email content (text + HTML body, sender, subject, attachments)
- [ ] User can manually request a new disposable address
- [ ] User can copy address to clipboard with one action
- [ ] Inboxes auto-expire after a configurable retention window (default: ~10 min after last activity)
- [ ] Service handles legitimate inbound mail (SPF/DKIM/MX correctly configured for the user's domain)
- [ ] Basic anti-abuse: per-IP rate limiting on address creation and message ingestion
- [ ] Mobile-friendly responsive UI
- [ ] Self-hostable in a single command on the user's VPS (Docker Compose or single binary)

### Out of Scope

- **User accounts / persistent inboxes** — defeats the "disposable" core value
- **Sending email from the inbox** — out of scope for v1; tempmail = receive-only
- **Custom user-chosen addresses** — random by default keeps it simple and avoids namespace collisions
- **Catch-all forwarding to a real inbox** — different product (alias service)
- **Spam filtering / virus scanning** — users opt into receiving anything by definition
- **Paid features / billing** — explicit personal-project goal: free to run, free to use
- **Multi-domain support in v1** — one domain at a time keeps MX setup trivial
- **Apps (mobile/desktop)** — web only

## Context

- Personal project, built primarily on local machine then deployed to existing VPS.
- User already owns the domain that will receive mail (specific domain name TBD — captured in Key Decisions).
- Constraint: stack must be runnable for free indefinitely on a single small VPS — no managed services, no SaaS dependencies.
- Public-facing from day one (not internal/staged), so abuse-resistance is a first-class concern even in v1.
- Comparable products (reference, not models): 10minutemail, mail.tm, temp-mail.org, Mailinator, mailsac.
- Tempmail = high-abuse vector by nature (people use it to bypass real signups). Operator burden grows with traffic — features should minimize ops, not maximize engagement.

## Constraints

- **Tech stack**: Free / OSS only — no paid SaaS, no managed databases, no cloud relays
- **Hosting**: Single VPS owned by user — assume modest specs (~1–2 GB RAM, 1 vCPU baseline)
- **Domain**: User-owned domain with full DNS control (MX records required)
- **Operator burden**: Solo maintainer — pick boring, well-documented tools; minimize moving parts
- **Privacy**: No user accounts means no personal data collection — keep it that way (no analytics SDKs, no telemetry)
- **Cost**: $0 monthly recurring beyond VPS + domain renewal

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stack delegated to GSD planner | User explicitly said "você escolhe a melhor stack possível" — researcher/roadmapper agents pick based on free-tier + single-VPS constraints | — Pending |
| Receive-only (no outbound SMTP) | Avoids being a spam relay; aligns with disposable-inbox semantics | — Pending |
| Random addresses (no custom names) | Simpler UX, no collision logic, less gameable | — Pending |
| Domain name | User has a domain but did not share it during init — capture before deploy phase | — Pending |
| VPS specs | Not specified — assume modest tier (1–2 GB RAM); revisit if planner picks heavy stack | — Pending |
| Default retention | ~10 minutes idle, hard cap (e.g. 1 hour) — match user expectations of disposable mail | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-18 after initialization*
