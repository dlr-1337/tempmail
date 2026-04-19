# Pre-deploy checklist

Tick every box **before** running `docker compose up -d` on a production VPS.
Missing items here don't just make first-deploy fail — they make *partial*
deployment that accepts mail but can't reply to abuse complaints, which is
worse.

---

## Infrastructure

- [ ] **Domain acquired + DNS control confirmed.** You can log into the
      registrar or DNS provider and edit A / AAAA / MX / TXT records.
- [ ] **VPS provisioned.** 1 GB RAM + 10 GB disk minimum. 25 GB recommended.
- [ ] **VPS :25 / :80 / :443 reachable from the public Internet.** Test from
      a different network: `nc -zv <vps-ip> 25`, `:80`, `:443`. **If :25 is
      blocked, STOP** — file a support ticket or move providers before you
      build.
- [ ] **VPS AUP explicitly permits disposable-mail.** Many budget providers
      ban it (check the ToS for "bulk mail", "disposable", "privacy
      services"). Getting null-routed mid-deploy is avoidable.
- [ ] **`abuse@<domain>` mailbox ready at an EXTERNAL provider.** Not at
      tempmail itself. Confirm you can receive mail there.

## DNS

- [ ] A record → VPS IPv4, **TTL 300**.
- [ ] AAAA record → VPS IPv6 (optional but improves deliverability).
- [ ] MX record → `10 <domain>.`, **TTL 1800**. Keep low forever.
- [ ] PTR / reverse DNS → `<domain>`. Set at your VPS provider's control panel.
- [ ] SPF TXT → `v=spf1 mx -all`.
- [ ] DMARC TXT at `_dmarc.<domain>` → `v=DMARC1; p=reject; rua=mailto:abuse@<domain>`.

## Secrets

- [ ] `PII_LOG_SALT` generated: `openssl rand -hex 32`.
- [ ] `COOKIE_SECRET` generated: `openssl rand -hex 32`.
- [ ] Both stored in a password manager (you'll need them to reconstruct
      `.env` if the VPS dies).
- [ ] `.env` filled from `.env.example`. Every `CHANGE_ME_*` replaced.

## Operational readiness

- [ ] You have SSH key access to the VPS (not password).
- [ ] You have `sudo` on the VPS.
- [ ] `docker` + `docker compose` installed on the VPS and you've run a
      `hello-world` container to confirm the daemon is up.
- [ ] You have `swaks` (or a comparable SMTP test client) installed on a
      machine outside the VPS for smoke-testing.
- [ ] You have a monitoring plan. At minimum: a cron job on a separate host
      that curls `https://<domain>/healthz` and pages you on 5xx.
- [ ] **Backup strategy acknowledged.** v1 has NO automated backup. If the
      VPS disk dies, inbox state is gone. Either accept this (it's
      disposable mail; minor impact) or set up periodic `sqlite .backup`
      + rsync-to-offsite yourself. Documented as a v2 feature.

## Abuse response preparedness

- [ ] You have a plan for who answers `abuse@<domain>` within 48h.
- [ ] You've read the abuse-response section of `ops/DEPLOY.md`.
- [ ] You know how to enable the admin endpoint and expire a reported inbox
      (`ADMIN_ENABLED=true` + `docker compose exec app curl ...`).
- [ ] Your privacy page (served at `/privacy`) is accurate: "email retained
      max 60 minutes, no logs tying inbox IDs to IPs".

## Final dry run

- [ ] Run the local smoke test first: follow [DEV.md](./DEV.md), send a test
      message via `swaks --server 127.0.0.1:2525`, verify it lands in the UI.
- [ ] Only after the local stack works end-to-end: proceed to DEPLOY.md.

---

If every box is ticked, you're ready. If any is unticked, resolve it first.
No deploys on partial setup.
