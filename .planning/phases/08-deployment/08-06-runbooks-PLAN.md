---
phase: 08
plan: 08-06
title: Operator runbooks (DEPLOY.md, PRE-DEPLOY-CHECKLIST.md, DEV.md)
covers: DEPLOY-07, D-17, D-18, D-19
---

# Goal

Three markdown docs in `ops/` that let a human operator deploy + maintain the system without reading source.

## Must-have checklist

- [ ] `ops/DEPLOY.md`:
  - Prerequisites (domain + DNS control, VPS with :25/:80/:443 open, 1GB+ RAM)
  - Pre-flight DNS: MX=A, PTR/FCrDNS, SPF `-all`, DMARC `p=reject`, MX TTL 1800s pre-set
  - First deploy: clone → fill `.env` → `docker compose up -d` → watch cert issuance → curl /healthz
  - SMTP smoke: `swaks --to abc@<domain> --server <domain>`
  - `abuse@<domain>` mailbox setup (external provider recommended)
  - Migration runbook: MX TTL lowering, new VPS stand-up, A-record flip, decommission
  - Abuse response playbook
  - Troubleshooting: port 25 blocked, cert challenge fails, disk full
  - STARTTLS cert domain ≠ web origin gotcha documented
- [ ] `ops/PRE-DEPLOY-CHECKLIST.md`:
  - [ ] Domain + DNS configured
  - [ ] VPS :25 / :80 / :443 verified externally reachable
  - [ ] VPS AUP permits disposable-mail (or second provider vetted)
  - [ ] `abuse@` mailbox ready at external provider
  - [ ] `PII_LOG_SALT` generated (openssl rand -hex 32)
  - [ ] `COOKIE_SECRET` generated
  - [ ] `.env` filled from `.env.example`
  - [ ] Backups plan acknowledged (v1 is single VPS, no backup — document risk)
- [ ] `ops/DEV.md`:
  - `127.0.0.1 tempmail.local` hosts entry
  - `docker compose -f docker-compose.yml -f docker-compose.local.yml up`
  - `swaks --server 127.0.0.1:2525 --to anything@tempmail.local`
  - Browser → `https://tempmail.local` (self-signed warning)
  - Windows: run `ops/smoke-test.ps1` alt path

## Tasks

1. `ops/DEPLOY.md`
2. `ops/PRE-DEPLOY-CHECKLIST.md`
3. `ops/DEV.md`

<automated>
test -f ops/DEPLOY.md && test -f ops/PRE-DEPLOY-CHECKLIST.md && test -f ops/DEV.md
</automated>

## Commit

`docs(08-06): operator runbooks (DEPLOY, PRE-DEPLOY-CHECKLIST, DEV)`
