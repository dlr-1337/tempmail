---
phase: 08
plan: 08-07
title: Smoke test scripts (bash + PowerShell)
covers: D-21, D-22
---

# Goal

Script the local compose-stack smoke test so the operator runs one command and gets a pass/fail.

## Must-have checklist

- [ ] `ops/smoke-test.sh` (bash, for Linux dev / CI):
  - `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build`
  - Poll `http://localhost/healthz` (through Caddy) until 200 or 60s timeout
  - POST `/api/inbox` expects 200 + Set-Cookie
  - Send SMTP via `swaks` to `anything@tempmail.local` on port 2525 (if swaks present; skip with note if not)
  - GET `/api/inbox/:id/messages` expects >=1 message when swaks succeeded
  - `docker compose down`
  - exit 1 on any failure
- [ ] `ops/smoke-test.ps1` — Windows-friendly equivalent for dev
- [ ] Scripts use set -euo / $ErrorActionPreference = 'Stop'
- [ ] README pointer in DEV.md

## Tasks

1. `ops/smoke-test.sh`
2. `ops/smoke-test.ps1`

<automated>
bash -n ops/smoke-test.sh
</automated>

## Commit

`feat(08-07): local smoke-test scripts (bash + powershell)`
