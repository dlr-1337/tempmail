# tempmail deploy runbook

**Audience:** the operator running a first-deploy or migration. Assumes you
have followed [PRE-DEPLOY-CHECKLIST.md](./PRE-DEPLOY-CHECKLIST.md) and have
shell on a VPS.

**Happy path: `docker compose up -d`.** Everything below is the context needed
for that to actually work.

---

## 1. Prerequisites

- A domain you control DNS for. Example: `tempmail.example.org`.
- A VPS with **inbound :25, :80, :443 reachable from the public Internet**.
  If your provider blocks :25 egress/ingress (DigitalOcean, some AWS regions,
  many residential ISPs), you cannot host disposable mail there. See
  `#troubleshooting` for how to confirm.
- 1 GB RAM minimum (512 MB works for idle, crashes on attachment storms).
- A non-root sudoer account + SSH key access.
- Docker Engine ≥ 24 + Compose v2. Or use the [systemd fallback](./systemd/README.md).
- An email address you check regularly, for `abuse@<domain>` AND for
  Let's Encrypt renewal warnings.

## 2. DNS pre-flight

Set these **before first boot**, not after — DNS propagation is the #1 reason
a first deploy looks dead:

| Record  | Value                                             | TTL   | Why                                    |
|---------|---------------------------------------------------|-------|----------------------------------------|
| A       | your VPS public IPv4                              | 300   | Web origin + MX target                 |
| AAAA    | your VPS IPv6 (optional but recommended)          | 300   |                                        |
| MX      | 10 `<domain>.`                                    | **1800** | Low so future IP moves are fast     |
| PTR     | `<domain>` (set at your VPS provider)             | —     | Many receivers reject mail without it  |
| TXT     | `v=spf1 mx -all`                                  | 3600  | Your IP is the only legit sender       |
| TXT (DMARC) | `v=DMARC1; p=reject; rua=mailto:abuse@<domain>`| 3600  | Tells receivers to drop spoofs         |

> **MX-TTL rule:** set MX to 1800s (30 min) **from day one**. Raising TTL
> only after a migration stretches your DNS-cutover window into hours. Keep
> it low forever.

Confirm with:

```bash
dig +short A tempmail.example.org
dig +short MX tempmail.example.org
dig +short -x <your-ip>          # PTR / reverse DNS
dig +short TXT tempmail.example.org
dig +short TXT _dmarc.tempmail.example.org
```

## 3. First deploy (Docker Compose path)

```bash
git clone https://github.com/YOUR-ORG/tempmail.git
cd tempmail
cp .env.example .env
# Required: DOMAIN, PII_LOG_SALT, COOKIE_SECRET, LETS_ENCRYPT_EMAIL.
# Generate the secrets with: openssl rand -hex 32
vim .env

docker compose up -d
docker compose logs -f caddy app   # watch cert issuance + startup
```

Expected log sequence (first ~60s):

1. `caddy` logs `obtaining certificate` for your domain.
2. `caddy` logs `certificate obtained successfully`.
3. `app` logs `tempmail.started` with `smtp_port`, `http_port`, `domain`.

If Caddy cannot issue a cert it will retry with backoff; see
`#troubleshooting` for common causes.

### Verify

```bash
curl -fsS https://$DOMAIN/healthz
# -> {"status":"ok","disk":{...}}   (or "degraded" if the disk is filling)

# SMTP reachability (outside the VPS):
swaks --to test@$DOMAIN --server $DOMAIN --tls-optional
# -> 250 2.0.0 Ok in the final response
```

Then in a browser: `https://<domain>` → you should see the SPA landing page
and be able to mint an inbox.

## 4. STARTTLS cert gotcha (important)

The cert Caddy mints is for the **web origin** (e.g. `tempmail.example.org`).
SMTP STARTTLS needs to present **the same hostname receivers expect in the
MX record**. For a single-host setup where MX points at `<domain>` directly,
the cert is correctly reused.

If you ever change the MX hostname to something different (e.g. `mx.<domain>`):

- You'll need a separate cert for that hostname.
- The simplest fix is to add `mx.<domain>` as an additional site block in the
  Caddyfile so Caddy issues a cert for it too, then point the app at that
  cert via `TLS_CERT_PATH`.

## 5. `abuse@<domain>` mailbox

**Do not** point `abuse@<domain>` at tempmail itself — the whole point is that
tempmail inboxes expire. Use an external provider (Fastmail, ProtonMail, Gmail,
your existing personal inbox) and add:

- DNS: MX only points at tempmail. `abuse@` lives at a different MX? Then
  you need a **second domain** for personal mail, OR put `abuse@` on the SAME
  MX but forward it upstream via a catch-all rule that ignores `abuse@`.
  Simpler: register `abuse-tempmail@<your-main-provider>` and list THAT
  address in DMARC + WHOIS + the privacy page.

Concrete minimum: DMARC `rua=mailto:abuse@<domain>` should reach a human
within 24h. Test by sending mail to yourself via the DMARC RUF reporter path.

## 6. Migration runbook (move to new IP / VPS)

Most migrations fail because DNS is cached. The safe sequence:

1. **T-1d**: lower MX + A TTL to 60s via your DNS provider. Wait >1× the
   OLD TTL (so caches expire).
2. **T-0**: stand up the new VPS, deploy via this runbook but DO NOT flip DNS.
   Verify internally: `curl --resolve $DOMAIN:443:<new-ip> https://$DOMAIN/healthz`.
3. Flip the A record to the new IP. Leave MX alone (it points at the A record
   by name, not IP).
4. Watch logs on BOTH VPSes for ~10 min. You'll see last stragglers on the old
   IP while caches drain.
5. Once the old VPS has received zero SMTP for 30 min, `docker compose down`
   and decommission.
6. Restore MX + A TTL to 1800s.

## 7. Abuse response playbook

You **will** get complaints. Be ready:

- **Spam/phishing sent from tempmail**: tempmail is receive-only by design;
  this should be impossible unless your Caddy/firewall is misconfigured.
  Investigate first. Then respond to the reporter with the finding.
- **Tempmail used as a recipient to circumvent verification**: nothing you
  can do at the protocol layer. Site operators can add your IPs / domain to
  their local blocklist; that's their right. Document in your privacy page
  that this service exists for legitimate privacy use cases.
- **DMCA / cease-and-desist**: preserve logs from
  `docker compose logs app > /tmp/abuse-$(date +%s).log`, respond within 48h,
  and expire the offending inbox via the loopback admin endpoint:
  ```bash
  ssh operator@host
  docker compose exec app curl -X POST http://127.0.0.1:8080/admin/blocklist \
    -H 'content-type: application/json' \
    -d '{"inboxId":"<id-from-logs>"}'
  ```
  (Admin is disabled by default — set `ADMIN_ENABLED=true` in `.env` and
  `docker compose up -d` to enable. Never expose through Caddy.)

## 8. Troubleshooting

### `docker compose logs caddy` shows ACME challenge failing

- **:80 not reachable from the public Internet**. HTTP-01 challenge needs
  inbound :80 even though your real traffic is on :443. Check firewall rules.
- **DNS A record not propagated**. `dig +trace $DOMAIN` from an external
  resolver.
- **Rate-limit from Let's Encrypt** (if you've been retrying often): wait
  1h, then use the staging directory for further experiments:
  ```
  # docker-compose.override.yml
  services:
    caddy:
      environment:
        ACME_CA: https://acme-staging-v02.api.letsencrypt.org/directory
  ```

### `app` won't start, logs `Invalid environment configuration`

The zod schema is telling you exactly which var is wrong. Fix `.env` and
`docker compose up -d`. No need to rebuild the image.

### SMTP connect works from inside the VPS but external sends get `connection refused`

Your provider blocks outbound/inbound :25. Confirm with:

```bash
# From a DIFFERENT network:
nc -zv $DOMAIN 25
```

If blocked, you have two choices: file a support ticket with proof this is
a legitimate mail service, or move providers. Disposable-mail AUP compliance
is a PRE-DEPLOY checklist item — don't buy the VPS before confirming.

### Disk filling (`healthz` returns `status:degraded`, SMTP starts returning 452)

The sweeper's orphan reaper runs hourly; if you've just had an attachment
storm you'll see 452s for up to an hour. Manual reaper tick:

```bash
docker compose exec app node -e \
  "import('./dist/sweeper/index.js').then(m=>console.log('(use the admin tools when Phase 8+ adds CLI)'))"
```

For v1 the safe manual option is: `docker compose down`, snapshot the `data`
volume, re-create with more disk, restart.

### Caddy logs `permission denied: /srv/web`

Bind mount `./web/build:/srv/web:ro` expects the build to exist. Run
`cd web && npm ci && npm run build` on the host first, then `docker compose
up -d caddy`.
