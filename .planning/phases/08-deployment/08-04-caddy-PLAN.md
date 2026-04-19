---
phase: 08
plan: 08-04
title: Caddyfile prod + Caddyfile.local
covers: DEPLOY-02, DEPLOY-03, DEPLOY-04, D-10, D-11
---

# Goal

Caddy terminates TLS (Let's Encrypt in prod, self-signed `tls internal` locally), reverse-proxies `/api/*` with SSE-safe flushing, serves SPA from `/srv/web` with fallback, and ships strict security headers.

## Must-have checklist

- [ ] `ops/Caddyfile` (prod) — matches D-10 block verbatim
- [ ] `/api/*` reverse_proxy with `flush_interval -1` + `read_timeout 0s` / `write_timeout 0s`
- [ ] `/healthz` reverse_proxy app:8080 (public monitor optional)
- [ ] `/admin/*` NOT routed (design: admin is loopback-only, never via Caddy)
- [ ] SPA root `/srv/web`, `try_files {path} /index.html`, `file_server`
- [ ] Security headers: HSTS, X-Content-Type-Options, Referrer-Policy, COOP, CORP, CSP, `-Server`
- [ ] Cache rules: `/_app/immutable/*` → 1y immutable; `/*.html` → no-cache
- [ ] `ops/Caddyfile.local` — same but:
  - site block `tempmail.local` with `tls internal`
  - no LE email
- [ ] Both pass `caddy validate --config <file>` (documented; only if caddy present)

## Tasks

1. Write `ops/Caddyfile`.
2. Write `ops/Caddyfile.local`.

<automated>
command -v caddy && caddy validate --config ops/Caddyfile || echo "caddy cli absent; syntax-only review"
</automated>

## Commit

`feat(08-04): Caddyfile prod + local with SSE + CSP headers`
