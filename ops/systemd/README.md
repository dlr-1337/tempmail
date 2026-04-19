# systemd deploy (fallback for <1GB VPS)

This is the no-Docker path. Use it when a VPS has too little RAM to be
comfortable with Docker overhead, or when your host provider bans container
runtimes. For the happy path see [ops/DEPLOY.md](../DEPLOY.md).

Target: **Debian 12 / Ubuntu 24.04** with systemd and a sudoer account.

---

## 1. Install prerequisites

```bash
# Node 22 from NodeSource (Debian/Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy (stable repo)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 2. Create the tempmail user + filesystem layout

```bash
sudo useradd --system --home /opt/tempmail --shell /usr/sbin/nologin tempmail
sudo mkdir -p /opt/tempmail /var/lib/tempmail /etc/tempmail
sudo chown tempmail:tempmail /var/lib/tempmail
sudo chmod 750 /var/lib/tempmail
sudo chmod 750 /etc/tempmail
```

## 3. Build the app from source

```bash
sudo -u tempmail -H bash <<'EOF'
cd /opt/tempmail
git clone https://github.com/YOUR-ORG/tempmail.git .
npm ci
npm run build
cd web && npm ci && npm run build
EOF
```

The two build outputs you care about are:

- `/opt/tempmail/dist/main.js` — backend entry
- `/opt/tempmail/web/build/` — SPA static files (served by Caddy)

## 4. Configure environment

```bash
sudo cp /opt/tempmail/.env.example /etc/tempmail/env
sudo $EDITOR /etc/tempmail/env
sudo chown root:tempmail /etc/tempmail/env
sudo chmod 640 /etc/tempmail/env
```

**Required edits** (see `.env.example` for the full schema):

- `DOMAIN` — your real domain
- `PII_LOG_SALT` — `openssl rand -hex 32`
- `COOKIE_SECRET` — `openssl rand -hex 32`
- `DATA_DIR=/var/lib/tempmail`
- Leave `TLS_DEV_SELF_SIGNED=false` and point `TLS_CERT_PATH` / `TLS_KEY_PATH`
  at Caddy's issued cert (see `#5-tls-cert-sharing` below).

## 5. TLS cert sharing (STARTTLS ≠ HTTPS gotcha)

Caddy issues the TLS cert for the web origin. The SMTP server needs the same
cert to present on STARTTLS (the MX hostname equals the web origin in a
single-host deploy). Caddy's storage lives at
`/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<DOMAIN>/`.

The cleanest path:

```bash
# Run as root once, re-run inside a cron/systemd timer after renewal.
install -m 640 -o root -g tempmail \
  /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN/$DOMAIN.crt \
  /var/lib/tempmail/fullchain.pem
install -m 640 -o root -g tempmail \
  /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN/$DOMAIN.key \
  /var/lib/tempmail/privkey.pem
systemctl reload tempmail
```

Then set in `/etc/tempmail/env`:

```
TLS_CERT_PATH=/var/lib/tempmail/fullchain.pem
TLS_KEY_PATH=/var/lib/tempmail/privkey.pem
```

## 6. Install systemd units

```bash
sudo cp /opt/tempmail/ops/systemd/tempmail.service /etc/systemd/system/
# The caddy package already ships a unit. Our copy is reference-only.
sudo systemctl daemon-reload
```

## 7. Install Caddyfile

```bash
sudo cp /opt/tempmail/ops/Caddyfile /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile   # replace {$DOMAIN} + {$LETS_ENCRYPT_EMAIL}
                                    # with literal values, since there's no
                                    # compose env to substitute from
sudo systemctl reload caddy
```

Alternative: keep the env-var substitution by running Caddy with
`CADDY_DOMAIN=...` and using `EnvironmentFile=/etc/caddy/env`.

## 8. Start + enable

```bash
sudo systemctl enable --now tempmail caddy
sudo systemctl status tempmail caddy
journalctl -u tempmail -f
```

You should see the structured `tempmail.started` log line with the bound
SMTP + HTTP ports.

## 9. Smoke test

```bash
curl -fsS https://$DOMAIN/healthz
swaks --to anything@$DOMAIN --server $DOMAIN --tls-optional
```

## Deploying updates

```bash
sudo -u tempmail -H bash <<'EOF'
cd /opt/tempmail
git pull
npm ci
npm run build
cd web && npm ci && npm run build
EOF
sudo systemctl restart tempmail
```

(Caddy doesn't need to restart for app changes — only for Caddyfile changes.)
