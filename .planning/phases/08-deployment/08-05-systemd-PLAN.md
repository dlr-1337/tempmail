---
phase: 08
plan: 08-05
title: systemd units (fallback for <1GB VPS)
covers: DEPLOY-05, D-12, D-13, D-14
---

# Goal

Provide a no-Docker deploy path — raw systemd units + a README walking the operator through manual setup.

## Must-have checklist

- [ ] `ops/systemd/tempmail.service` — per D-12
- [ ] Uses `AmbientCapabilities=CAP_NET_BIND_SERVICE` so non-root can bind :25
- [ ] Hardening: `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=/var/lib/tempmail`
- [ ] `ops/systemd/caddy.service` — upstream Caddy unit reference or `apt install caddy` doc
- [ ] `ops/systemd/README.md` — step-by-step manual deploy (Debian/Ubuntu)
  - install Node 22 + Caddy
  - create tempmail user + `/opt/tempmail` + `/var/lib/tempmail`
  - clone, npm ci (prod + web), build
  - install /etc/tempmail/env from .env.example
  - systemctl enable --now

## Tasks

1. `ops/systemd/tempmail.service`
2. `ops/systemd/caddy.service` (or reference to upstream)
3. `ops/systemd/README.md`

<automated>
# systemd-analyze verify is Linux-only; document as manual on Linux host
test -f ops/systemd/tempmail.service
</automated>

## Commit

`feat(08-05): systemd units + ops/systemd README for <1GB VPS`
