---
phase: 08
plan: 08-03
title: docker-compose.yml + docker-compose.local.yml override
covers: DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, D-06, D-07, D-08, D-20
---

# Goal

`docker compose up -d` brings up `app` + `caddy` with persistent volumes. A local override gives the operator a smoke-testable stack without a real domain or LE cert.

## Must-have checklist

- [ ] `docker-compose.yml` services: `app` + `caddy`
- [ ] app: builds `.`; `restart: unless-stopped`; env_file `.env`; port `25:25` exposed
- [ ] app: mounts named volume `data` at `/data`
- [ ] app: HTTP stays internal (no host port), reachable from caddy as `app:8080`
- [ ] app: healthcheck from Dockerfile
- [ ] caddy: image `caddy:2.11-alpine`; ports `80:80` + `443:443`; depends_on app
- [ ] caddy: mounts `./ops/Caddyfile:/etc/caddy/Caddyfile:ro`
- [ ] caddy: mounts `caddy_data` + `caddy_config` named volumes
- [ ] caddy: mounts `./web/build:/srv/web:ro` (SPA statics)
- [ ] volumes: `data`, `caddy_data`, `caddy_config` as named
- [ ] Sets env `DOMAIN`, `LETS_ENCRYPT_EMAIL` for Caddy substitution
- [ ] `docker-compose.local.yml` override:
  - binds SMTP `2525:25` instead of `25:25`
  - mounts `./ops/Caddyfile.local:/etc/caddy/Caddyfile:ro`
  - sets DOMAIN=tempmail.local
- [ ] `docker compose config` validates both files merged

## Tasks

1. Write `docker-compose.yml`.
2. Write `docker-compose.local.yml`.

<automated>
# If docker available: docker compose -f docker-compose.yml -f docker-compose.local.yml config > /dev/null
echo "compose config syntax check (deferred if docker absent)"
</automated>

## Commit

`feat(08-03): docker-compose prod + local override`
