# Pitfalls Research

**Domain:** Self-hosted public disposable email (tempmail) service — inbound-only SMTP, anonymous/ephemeral inboxes, single VPS, solo operator
**Researched:** 2026-04-18
**Confidence:** HIGH (well-documented operator category; failure modes are consistent across Mailinator/temp-mail/mail.tm writeups, Postfix/Haraka operator notes, and DNSBL operator policies)

> **Scope note:** This document is **specific to disposable-mail / inbound-SMTP**. Generic advice (XSS, SQL injection, TLS hygiene, backup strategy) is deliberately omitted. Everything here is either unique to the tempmail category, unique to running an MX, or a common trap that specifically bites operators in this class.

---

## Critical Pitfalls

### Pitfall 1: Your domain gets listed on DBLs specifically *because* it's a disposable provider

**What goes wrong:**
Within days to weeks of the service going public and attracting users, your domain appears on Spamhaus DBL, UCEPROTECT domain lists, and the many "block disposable email" lists that sites like prospeo.io, kickbox, abstractapi, and trustfull aggregate. Third parties then refuse to accept mail *from* your domain in any context you might later want (e.g., if you ever enable sending, password reset from a related personal domain on the same DNS zone, etc.), and more immediately: the sites your users are trying to sign up at start rejecting `@yourdomain.tld` at the form layer, making the service useless to users.

This is **not a bug, not a misconfiguration** — it is the expected equilibrium. Every well-known tempmail domain lives on these lists. The mistake operators make is either (a) thinking they've done something wrong and burning time trying to delist (won't work; the listing reason is "provides disposable inboxes," which is a factual description), or (b) fighting the listing by obfuscating that you are a tempmail provider — which gets you on *worse* lists (shadow/stealth provider designations).

**Why it happens:**
DBLs like the curated disposable-domain lists exist for the explicit purpose of letting downstream sites refuse signups from tempmail domains. Operators conflate "my domain is blocklisted" (bad for outbound senders) with "my domain is on a disposable-providers list" (irrelevant for a receive-only service, but does cause signup-form rejection at the services users are trying to use tempmail for in the first place).

**How to avoid:**
- **Accept the listing as a first-class constraint of the product**, not a bug. Plan for it in the roadmap.
- Design the service so a domain becoming blocked at a target site is a **user-visible, routine event**: make it trivial to rotate to a secondary domain, or support a small pool of domains from day one (even with the "one domain in v1" constraint — leave the data model open for N).
- **Do NOT apply for Spamhaus delisting** as a disposable provider; submissions from disposable-provider domains get flagged and can spread the listing to related infrastructure (IP, adjacent domains on same NS, etc.).
- **Do NOT combine the tempmail domain with a personal/professional domain on the same DNS zone, same NS, or same MX hostname.** Keep it operationally isolated so a reputation hit is contained.
- **Do NOT publish SPF/DKIM "pass" for the domain as if you were sending** — a tempmail domain that appears to be sending from a tainted IP is worse than one that plainly doesn't send. See Pitfall 10.
- If a hosting provider or upstream reacts to the listing by threatening the VPS, that's a separate problem (Pitfall 4) — don't try to solve it by fighting the DBL.

**Warning signs:**
- Users start reporting "the service I'm trying to sign up for says 'disposable emails not allowed.'" (Happens fast — within first week of any real traffic.)
- `host -t TXT yourdomain.tld.dbl.spamhaus.org` returns a listing code.
- Increase in inbound `RCPT TO` rejections from spam-trap probing domains (indicator you're also on sender lists, which you shouldn't be as receive-only — investigate).

**Phase to address:**
Phase: **Domain & DNS setup** (initial), and **Abuse/Operations** phase (ongoing). Data model must treat "domain" as a first-class rotatable entity even if v1 ships with one.

---

### Pitfall 2: Confusing outbound-port-25 blocks with inbound-port-25 requirements

**What goes wrong:**
Operator picks a cheap VPS, discovers `telnet smtp.gmail.com 25` from the VPS is blocked (very common on DigitalOcean, Google Cloud, AWS EC2, and many budget providers), panics, and either (a) switches to a more expensive provider unnecessarily, (b) tries to use a relay service (defeating the self-host constraint), or (c) concludes "I can't run a mail server on this VPS." All three are wrong for a **receive-only** tempmail.

Alternatively, the operator assumes inbound port 25 is also blocked because outbound is, doesn't test, and builds the whole stack before discovering the VPS provider also blocks inbound 25 on the specific plan — which *is* a real problem (Hetzner has done this at times on cheapest tiers; some providers silently drop inbound 25 until you open a ticket).

**Why it happens:**
The port-25 conversation online is dominated by *outbound* concerns (spam relay prevention). Receive-only operators read those threads, apply the advice to themselves, and draw wrong conclusions. Provider TOS pages similarly are written with outbound senders in mind.

**How to avoid:**
- **Explicitly verify inbound port 25 is open** before committing to a VPS. From any external host, run `nc -vz <vps-ip> 25` — you must see a 220 banner. If the provider silently filters, this will time out.
- Outbound port 25 being blocked is **irrelevant** for receive-only tempmail. Document this in the project README so you don't re-convince yourself later.
- If the VPS provider requires a ticket to open inbound 25, do it at provisioning time, not at deploy time.
- Do *not* try to work around outbound-25 blocking with port-587 tricks, relay services, or similar — v1 is receive-only, period. If you later add bounce-generation (NDRs), reconsider then.

**Warning signs:**
- `nc -vz <vps-ip> 25` from an external host times out or connection-refused while the MTA is running and listening on 0.0.0.0:25 locally.
- External SMTP probe tools (mxtoolbox, mail-tester) report "cannot connect to MX."
- You see SYN packets arrive but no SYN-ACK (`tcpdump -i any port 25`) — indicates upstream filter, not local firewall.

**Phase to address:**
Phase: **Infrastructure/VPS selection** (pre-deploy). Test inbound 25 reachability as the *first* thing done on a new VPS, before installing anything.

---

### Pitfall 3: The service becomes a signup-fraud conduit → hosting provider terminates the VPS with little warning

**What goes wrong:**
Tempmail is *the* tool for automated signup fraud, credential-stuffing prep, free-trial abuse, and promotion-gaming. Once your domain has any traffic, bot operators will hammer it to create tens of thousands of short-lived inboxes per day. Target services notice the pattern, trace it to your domain, and file abuse reports against your VPS IP with the hosting provider. Hetzner, OVH, and DigitalOcean all have fairly aggressive automated abuse pipelines — Hetzner typically gives 24–48h to respond on email-related complaints, and repeated reports lead to suspension. For a solo operator who may not check email for 24h, this can mean waking up to a dead VPS.

This is fundamentally different from "generic web app abuse." The service is **working as designed** when bots use it, but the abuse is *downstream* (at the target site), and the abuse report lands on *you*.

**Why it happens:**
- Tempmail operators frequently underestimate the volume and speed of bot-driven use.
- Hosting provider abuse departments don't distinguish "you are a tempmail provider and someone used you to create a fake Reddit account" from "you are the one creating fake Reddit accounts."
- Operators often don't publish an `abuse@` contact or don't monitor it, so complaints escalate to the hosting provider by default.

**How to avoid:**
- **Publish a clear, monitored `abuse@yourdomain.tld` contact** (both in WHOIS and as a visible footer on the site) and actually read it. This diverts a meaningful fraction of complaints away from the hosting provider.
- **Publish and honor an address-blocklist request endpoint** — if a target service contacts you asking you to stop receiving for `spamtrap-abc@yourdomain.tld`, block that single local-part immediately. Cheap to implement, large goodwill return.
- **Rate-limit address creation aggressively per IP** (e.g., 5/min, 50/hour) — the goal is not to stop bots (you can't) but to make bulk abuse expensive enough to not come from a single IP, so abuse reports against your VPS IP are rarer and less "obvious pattern."
- **Rate-limit message ingestion per sender IP/domain** — high-volume senders hitting your MX are usually target sites' own outbound mailers; being a well-behaved MX (4xx on overload, not 5xx) keeps you out of their sysadmins' inboxes.
- **Pick a hosting provider whose AUP does not explicitly forbid "disposable email services"** (most don't explicitly forbid, but some do). Read the AUP before provisioning. Keep a second VPS provider pre-vetted as a fallback.
- **Keep your data model and deployment scripted** so a VPS termination means "re-provision elsewhere, re-point MX, 2 hours of work" rather than "project dead."
- **Consider publishing to `https://yourdomain.tld/.well-known/security.txt`** with abuse contact — some automated abuse-report systems check this first.
- Do NOT try to "filter" who can create inboxes (captcha, etc. beyond basic rate limiting) — it breaks the "inbox in under 3 seconds" core value and doesn't actually stop the threat model. Bots get past captchas. Focus on "don't let one bot make 10k inboxes from one IP in one minute."

**Warning signs:**
- Abuse report email from hosting provider (this is the explicit signal; respond *within hours* not days).
- Sudden concentration of ingestion from a handful of sender domains (signup services) — these are the ones about to complain.
- Sudden concentration of address-creation requests from a single IP or /24.
- Traffic spike with no Hacker News / Reddit posting to explain it → bot onboarding.

**Phase to address:**
Phase: **Abuse/operations hardening** (pre-launch). Address-creation rate limit, ingestion rate limit, `abuse@` address, and per-address blocklist-on-request **must** be in v1. Cannot be deferred.

---

### Pitfall 4: Logging email content, sender addresses, or full headers in plaintext

**What goes wrong:**
The operator adds `log.info(mail)` or logs `From:`, `Subject:`, and `To:` for "debugging," and now the VPS disk contains a searchable index of every email anyone's ever received on the service — other people's password-reset links, 2FA codes, account creation tokens, medical test results, whatever. This is (a) a massive privacy violation, (b) a regulatory problem under GDPR (you are the data controller for third-party PII you didn't need to store), (c) a **blackmail/subpoena target**, and (d) a disaster if the VPS is ever compromised or seized.

Closely related: logging the **recipient address** long-term creates a retrievable mapping of "which tempmail addresses were ever used," which combined with connection IPs is a user-deanonymization database.

**Why it happens:**
- Standard observability culture says "log everything."
- Default Postfix / Haraka / mail server logging includes envelope sender, envelope recipient, and Message-ID at INFO level.
- Developers reflexively add `console.log` statements during debugging and forget to remove them.
- Application framework middleware (request loggers) often auto-capture POST bodies.

**How to avoid:**
- **Define "logged fields" as a whitelist, not a blacklist.** Logged: timestamp, sender IP (optional), sender domain (not local-part), message size, SMTP result code, a short message hash. Not logged: sender local-part, recipient address (full), Subject, headers, body, attachments.
- If you must log the recipient for debugging, **log only a hash of the recipient local-part + a short retention** (e.g., 1 hour, then purge), never the plaintext.
- **Configure the MTA to log at the minimum level needed for operations.** In Postfix, `maillog_file_prefixes` and careful log rotation. In Haraka, disable the body/headers plugins from the log pipeline.
- **Run log rotation with short retention** (24–48h max). Short retention is both a privacy feature and a breach-blast-radius limiter.
- **Do not forward logs off-box** to any third-party log aggregator (Datadog, Papertrail, Logtail, etc.). Every third party you send logs to becomes a data subprocessor under GDPR.
- **No analytics SDKs on the web frontend** (already in PROJECT.md constraints — respect it). No Sentry with default PII capture. If using error tracking, scrub email addresses and URL path params aggressively.
- **Disable access logs for the route that returns inbox contents**, or at minimum strip the address from the URL and put it in POST body / cookie / WebSocket session.

**Warning signs:**
- `grep @yourdomain.tld /var/log/*` returns any hits for recent mail.
- Application logs show full `To:`, `From:`, `Subject:` fields.
- nginx access log contains full inbox addresses in URL paths.
- `journalctl -u your-app` shows message bodies or headers.

**Phase to address:**
Phase: **Core ingestion** (initial) and reviewed in every phase. This is a "get wrong once and it stays wrong" problem — privacy leaks are retroactively hard to fix because old logs already exist and may have been backed up.

---

### Pitfall 5: HTML email rendered directly in the DOM → XSS, remote-content exfil, tracking pixels

**What goes wrong:**
The webmail UI renders `message.html_body` by setting `innerHTML`, or using React's `dangerouslySetInnerHTML`, or inserts it into the main document in any form. Three distinct bad outcomes:

1. **Active XSS / DOM clobbering.** Malicious sender crafts HTML that executes JS in the context of your frontend origin — can steal WebSocket session, other inboxes the user has open, etc. Surprisingly common in webmail implementations; Fastmail has a well-known writeup on DOM clobbering in particular.
2. **Tracking-pixel exfiltration.** Senders embed 1×1 images and `<link>` preloads; when your frontend loads them, it leaks the user's real IP to the sender, who now knows an identity behind the tempmail address. This defeats the entire privacy premise of the service.
3. **Remote resources render with the user's real IP** as default — beacons, web fonts, CSS `url()`, iframes, form-action targets all become exfil channels.

**Why it happens:**
- HTML email parsing is hard; operators reach for "just render it" and plan to harden later.
- "Our sanitizer strips `<script>`" is not enough — modern vectors use CSS, SVG, `<meta http-equiv>`, event handlers on exotic tags, DOM clobbering, mutation XSS.
- Disposable-mail services are **specifically targeted** by tracking-pixel studies (there's an academic paper — Gang Wang et al. 2019 — explicitly characterizing pixel tracking across disposable email services).

**How to avoid:**
- **Render HTML email in a sandboxed iframe**, not in the main document. `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="...">` — no `allow-scripts`, no `allow-same-origin`. This is the Fastmail/Close/Proton approach. Handles mutation XSS and DOM clobbering because the iframe is origin-less.
- **Sanitize the HTML with DOMPurify** (or equivalent, e.g., the new HTML Sanitizer API where available) *before* inserting into the srcdoc, as defense in depth.
- **Block remote content by default** — rewrite `<img src=...>` to data-URIs or a placeholder, rewrite `<link>`, `<style>@import`, CSS `url()`, `<iframe>`, `<form action=...>`, `<video>`, `<audio>`, `<source>`, `<object>`, `<embed>`. User must click a "Load remote content" button to fetch. This is standard webmail UX (Gmail, Proton, Thunderbird all do this).
- **If you allow remote content loading after a click, proxy it** through your server with the user's IP hidden. Cache the proxied content (small TTL) so repeated opens don't re-hit the sender. This is the Gmail/Proton approach.
- **Set a strict CSP on the iframe** via `<meta http-equiv="Content-Security-Policy">` inside the srcdoc: `default-src 'none'; img-src data: https:;` (or `'none'` if remote-blocking is on).
- **Also render plaintext when available** — for many users, a clean text view is safer and enough.

**Warning signs:**
- You're using `dangerouslySetInnerHTML` anywhere in the message-rendering path.
- Your sanitizer is a regex or a hand-rolled tag allowlist.
- Network inspector shows requests to sender-controlled origins when opening an email.
- You see hits from third-party domains in the frontend's service worker / browser console.

**Phase to address:**
Phase: **Frontend rendering** (before any real HTML email is shown). Non-negotiable for v1 given the "strangers' email" threat model.

---

### Pitfall 6: Race condition between "create address" and "first email arrives"

**What goes wrong:**
User visits the site. Frontend fires `POST /api/addresses` to mint an address, gets back `alice1234@domain`, then opens a WebSocket / SSE to subscribe to that address. Meanwhile the user has already copy-pasted the address into a signup form in another tab *before* the WebSocket handshake completes. The signup triggers an email from the target site that hits the MX within 50–300ms. The MX stores it. But:

- **Case A:** The WebSocket isn't open yet → email is stored, but the frontend never gets a push. User sees empty inbox. Polling fallback shows it only after N seconds. User assumes the service is broken and leaves. (This is Mailinator's and mail.tm's classic "it's broken!" complaint.)
- **Case B:** The WebSocket opens *during* ingestion. Backend emits the `new-message` event before the subscriber has registered. Event dropped. Same outcome.
- **Case C:** Frontend subscribes, then navigates / reloads / WebSocket reconnects. During reconnect, messages arrive. Old subscriber is gone, new one hasn't registered. Gap.

**Why it happens:**
- Pub/sub semantics are fire-and-forget by default. Messages published without a subscriber are lost.
- Developers test locally with empty inboxes and never hit the "email arrives within the first 100ms" case.
- The "under 3 seconds" core value creates pressure to show the inbox instantly, which surfaces this race.

**How to avoid:**
- **Create address server-side *before* responding to the frontend's request.** Address must exist and be subscribable before the HTTP response completes.
- **On WebSocket `subscribe` event, server must fetch-and-flush any already-stored messages for that address** before transitioning to "listening for new." This is the "event cache / replay on subscribe" pattern. Guarantees no message is dropped regardless of ingestion-vs-subscribe ordering.
- **Persistent store is the source of truth**, not the pub/sub channel. Pub/sub is only a *nudge* telling the subscriber to refetch. If the nudge is lost, a periodic "refresh" query (every 10–30s, low frequency) closes the gap.
- **On reconnect, always replay from last-seen message ID**, not from "now." Include a sequence number or monotonic `received_at` on messages so the client can say "give me everything since X."
- **Do not return the newly minted address to the frontend until it is persisted and routable** (MTA must be able to accept mail for it). If the address-to-inbox mapping is in a cache that hasn't replicated to the MTA yet, ingestion silently drops mail for it (550 unknown user).
- **Warm-start: pre-provision a small pool of addresses** so the mint path is "pop from pool, mark claimed" — single DB write, no cold-start latency, easier to guarantee the MTA already knows about it.

**Warning signs:**
- Users complain "I sent the test email but nothing showed up," but the message is in the DB when you look.
- Logs show `message stored` timestamp earlier than `websocket subscribed` for the same address.
- Integration test that mints an address and sends to it immediately is flaky.

**Phase to address:**
Phase: **Core ingestion + realtime** (initial). This is the "does the product actually work" pitfall. If this isn't solved, the core value ("inbox in under 3 seconds") is a lie.

---

### Pitfall 7: No expiry sweeper / no attachment size cap → disk fills up → MX stops accepting mail → silent outage

**What goes wrong:**
The service ships with retention defined on paper (10 min idle, 1h hard cap) but no actual process that deletes old inboxes and messages. Over a week the DB grows to a few GB, then a few tens of GB, then fills the VPS disk. Postfix / Haraka / your app fails to write new messages (ENOSPC). The MX starts returning `452 Insufficient system storage` (temp failure) or, worse, just hangs / crashes and `tcpdump` shows SYN-ACK with no banner. Senders queue for a few days, then bounce back to the user, then the user's target signup fails. You notice when someone complains, days later.

Attachment-specific variant: someone sends a 50MB attachment (or tries to send one much larger that your MTA accepts before rejecting), and a handful of those plus images-inline-in-HTML inflate storage fast. The "many small Maildir files eat inodes" failure is separate and arrives *first* on filesystems with low inode counts — you run out of inodes while only using 40% of disk bytes, and everything breaks with confusing errors.

**Why it happens:**
- Expiry policy is a docs artifact, not a cron job. Gets forgotten.
- MTA default `message_size_limit` is typically 10MB (Postfix) — but nothing stops 10MB × many messages × many addresses from adding up.
- Operators test on a machine with 100GB SSD and never hit the small-VPS limits until production.
- Inode exhaustion is invisible in `df` — you need `df -i` to see it, and nobody checks unless they know.

**How to avoid:**
- **Implement the expiry sweeper as a first-class background job from day one**, not "we'll add it later." Run every 60s. Delete messages older than retention. Delete inboxes with no messages and no activity in retention window.
- **Two independent caps:** per-message size (e.g., 10MB hard, via MTA config — reject at SMTP DATA stage with 552), and per-inbox total size (e.g., 25MB, reject further mail with 452 temp-fail — temp-fail not perm-fail because the user may open a new inbox soon).
- **Global disk watermark:** if free disk < 10%, start aggressive sweep and reject new messages with 452. If free disk < 5%, also refuse new inbox creation at the web layer. This is a circuit breaker, not a retention policy — retention still runs always.
- **Monitor `df -i` (inodes) not just `df -h`.** Consider a filesystem that doesn't use inodes in the classic sense (XFS, or put message storage in a DB blob instead of Maildir) if you expect many small files.
- **Store messages in a DB (SQLite/Postgres) as blobs**, not in Maildir, unless you have a specific reason to use Maildir. DB storage makes retention a single DELETE query, avoids inode pressure, and makes consistent backup trivial.
- **Attachments separately:** if storing to disk, put them under a bounded-size volume with its own watermark, and generate a UUID-sharded directory layout (`attach/ab/cd/abcdef...`) so a single directory never has >10k files.
- **Alerting:** email yourself (via a real email provider, not your own MTA) when disk is 80% full, or when sweeper fails, or when inbound 25 is refused for any reason.

**Warning signs:**
- `df -h` showing climbing utilization week-over-week with no new users.
- `df -i` showing inode utilization >50% while disk is <50%.
- Postfix log: `452 4.3.1 Insufficient system storage` or `no space left on device`.
- Sweeper cron entry exists but hasn't logged in >24h (check `journalctl` for the sweeper unit).
- Messages table row count growing unboundedly.

**Phase to address:**
Phase: **Core ingestion** (sweeper + caps at launch), **Operations/monitoring** (watermarks and alerts). The sweeper is not a "phase 2 nice-to-have" — without it, v1 dies in a week.

---

### Pitfall 8: MX TTL set high → deploy / migration causes silent mail loss for hours

**What goes wrong:**
Default MX TTL on many DNS providers is 3600–14400s (1–4h), with some defaulting to 24h/86400. Operator decides to migrate the VPS, rename the mail hostname, or change MX priority during deploy. They update the MX record, tear down the old MX, bring up the new MX — but resolvers cached on the old value are still sending mail to the old IP for up to the full TTL. Senders don't bounce; they just get `connection refused` and their MTA queues and retries for up to 5 days. Users see "I sent the email but it never arrived." Meanwhile the operator thinks the deploy succeeded because the new MX is working for resolvers that refreshed.

Secondary variant: operator uses two MX records with different priorities for "redundancy," but only one is actually configured to accept mail, so mail routed to the unconfigured one bounces or is deferred depending on how broken it is.

**Why it happens:**
- DNS TTL is invisible during a deploy. Nothing in your deploy tooling surfaces "MX is still cached at the old value for N minutes."
- MX record changes feel like "just a DNS change" — same mental model as changing an A record for a web server, where 5-minute propagation is fine. Mail is different because MTAs *queue and retry* silently.
- Mail providers don't tell the sender the MX they're trying — the user sees nothing, the operator sees nothing, the mail just disappears for hours.

**How to avoid:**
- **Lower MX TTL to 300s at least 48 hours before any planned migration.** Wait for the *old* TTL to fully expire everywhere before touching the MX record. Then do the migration, verify, and raise TTL back.
- **Keep the old MX accepting mail during the cutover window.** Don't take the old MX down the instant DNS is updated. Leave it running with a forwarder to the new MX for at least 1× old-TTL, ideally 2×.
- **Prefer a single MX record over multi-priority redundancy in v1.** Multi-MX adds failure modes (split brain, one-is-unconfigured) that aren't worth it at one-VPS scale. If you want redundancy, do it at the IP/process level, not DNS.
- **Verify MX propagation with external resolvers** post-change: `dig @1.1.1.1 MX yourdomain.tld`, `dig @8.8.8.8 MX yourdomain.tld`, `dig @9.9.9.9 MX yourdomain.tld`, plus a remote host outside your ISP. All should agree before you call a deploy done.
- **Keep a persistent low baseline TTL** (e.g., 1800s) — it trades a tiny DNS query cost for operational flexibility, and mail caches are not query-cost sensitive at small-VPS scale.

**Warning signs:**
- Dig shows different MX values from different resolvers after a change.
- Mail log on *old* server is still receiving inbound SMTP after you thought you'd migrated.
- Users report "sent several hours ago, just arrived now" (classic post-migration symptom).

**Phase to address:**
Phase: **Deploy/ops** phase. Document this as part of any migration runbook; do not rely on memory.

---

### Pitfall 9: Inbox address enumeration → attackers harvest all inbound mail in real time

**What goes wrong:**
Addresses are generated from a small alphabet (e.g., 6 lowercase letters + digits) or from a dictionary of words (`happy.tiger@`). Attackers script a crawler that tries candidate addresses at a rate of thousands/sec against your public "view inbox" endpoint (`/inbox/alice1234` style URLs). Every time they hit an address that exists and has mail, they harvest it. Because many users use tempmail specifically for sensitive flows (password resets, 2FA codes, signup confirmations), attackers can potentially intercept those.

Academic research on exactly this class of attack against public inbox services (pixel tracking study by Gang Wang et al.) demonstrated this is practical and widespread. Services like 10minutemail and Mailinator are explicitly attacked this way — it's not theoretical.

**Why it happens:**
- The "visit → get inbox → read" UX pushes operators toward `GET /inbox/:address` with address in URL, assuming the address itself is a secret.
- Random 6-char alphanum has 36^6 ≈ 2B combinations, which sounds like a lot but is trivially enumerable at 10k qps across a million-inbox day — and the attacker only needs to find active ones.
- Adding keyword/dictionary-friendly addresses (for UX) makes enumeration orders of magnitude cheaper.

**How to avoid:**
- **Address-as-secret requires entropy.** Use a minimum of ~64 bits of randomness in the local-part (e.g., base32 of 10 random bytes = 16 chars of `abcdefghijklmnopqrstuvwxyz234567`). This makes enumeration infeasible even at 10k qps for centuries.
- **But don't rely on address secrecy alone.** Separate the public *address* (what the sender sees, what goes on signup forms) from the *view token* (what the browser uses to fetch the inbox). Server-side map: `address -> view_token`. The token is a long random string held in the user's cookie / local storage. `GET /inbox/:token` uses the token; `GET /inbox/:address` either doesn't exist or requires the token.
- **Rate-limit `/inbox/*` requests per IP** to something like 60/min. Enumerators pattern is "thousands of different addresses from the same IP" — trivially detectable, cheap to rate-limit.
- **Return 404 for non-existent inboxes AND empty inboxes identically.** Don't leak "this address exists but is empty" vs "doesn't exist."
- **Do NOT put the address in the URL path** if you can avoid it. POST body or WebSocket session association is better. If the URL contains the address, that address leaks into browser history, referer headers, HTTP access logs, and shoulder-surfing.
- **Consider displaying a short alias (`alice1234@`) while using a long token under the hood** — user copies the alias, but enumeration doesn't help because there's no aliased-based read path.

**Warning signs:**
- `/inbox/*` request rate massively exceeds `/api/addresses` request rate from a small set of IPs.
- Access log shows sequential/patterned addresses being requested (`aaaa01`, `aaaa02`, `aaaa03`...).
- Reports from users that "someone else got my email."

**Phase to address:**
Phase: **Frontend / API design** (initial). The choice of "address in URL" vs "token in URL" is hard to change after launch because URLs leak to external services (the ones your users signed up at).

---

### Pitfall 10: Misconfigured DNS for receive-only — especially publishing SPF/DKIM as if you're sending

**What goes wrong:**
Multiple distinct DNS failures, in rough order of frequency:

1. **MX record points to a CNAME** (e.g., `MX 10 mail.yourdomain.tld` where `mail.yourdomain.tld` is a CNAME to something else). Violates RFC 2181 §10.3. Some sending MTAs refuse to deliver; others follow it but log warnings; behavior is inconsistent. Breaks a subset of senders invisibly.
2. **No PTR / wrong PTR (rDNS).** Inbound isn't directly affected by *your* PTR, but some sending services do forward-confirmed reverse DNS (FCrDNS) checks on the MX — if `mail.yourdomain.tld` resolves to an IP whose PTR doesn't match, some senders score down or defer.
3. **No MX record at all** — using only an A record on the apex. Mail just bounces at most senders.
4. **Publishing an SPF record listing IPs that are allowed to send** — when you are not sending. This is actively harmful: if anything on those IPs spams, your domain reputation suffers; and publishing `v=spf1 -all` (no senders) is correct for receive-only but often omitted.
5. **Publishing a DKIM selector that never signs anything** — looks abandoned and triggers heuristics at some inbound scanners.
6. **Missing DMARC** — arguably fine for receive-only, but `v=DMARC1; p=reject; sp=reject;` is a free signal to others that your domain should never send, hardening you against domain-spoofing impersonation attacks.
7. **MX hostname doesn't have an A/AAAA record, or A exists but points to wrong IP.** Happens during migration.
8. **HELO/EHLO hostname used by your MTA doesn't match the PTR of the IP.** Minor but triggers spam scoring at some senders.

**Why it happens:**
- Tutorials are mostly written for *sending* servers; receive-only operators cargo-cult the full SPF/DKIM/DMARC setup without understanding which parts they need.
- DNS providers' UIs sometimes auto-wrap MX values in ways that create CNAMEs accidentally, or they suggest "add an MX pointing to your CNAME for convenience."
- PTR/rDNS is set by the VPS provider, not the domain registrar, and operators often don't realize they need to set it separately (usually in the VPS control panel).

**How to avoid (concrete checklist for receive-only tempmail):**
- `MX 10 mail.yourdomain.tld.` — the target is a hostname with direct `A` / `AAAA`, **not a CNAME**.
- `A mail.yourdomain.tld. <vps-ip>` (and AAAA if you have v6).
- **PTR:** set in VPS provider panel so `dig -x <vps-ip>` returns `mail.yourdomain.tld.` (matching the A forward).
- **MTA HELO/EHLO**: configured to announce `mail.yourdomain.tld` (matches PTR).
- **SPF for a non-sending domain**: `TXT "v=spf1 -all"` on the apex. Explicitly says "no IP is authorized to send as this domain." This hardens you against outbound spoofing using your domain.
- **DMARC**: `TXT "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;"` at `_dmarc.yourdomain.tld`. For receive-only, this is pure defense against domain spoofing.
- **No DKIM record** at all (no selector). You're not signing anything; publishing a selector with no key signs nothing.
- **MTA-STS / TLS-RPT / DANE:** optional but cheap. MTA-STS (`mta-sts.yourdomain.tld`) says "senders should use TLS." For a privacy-oriented service, enabling MTA-STS with `mode=enforce` and publishing TLS-RPT to yourself is a small hardening.
- **Verify everything with `mxtoolbox.com/SuperTool.aspx`** and `https://internet.nl/mail/yourdomain.tld/` after setup. Fix anything flagged.

**Warning signs:**
- `dig MX yourdomain.tld` returns a name; `dig A <that-name>` returns CNAME chain before reaching an address.
- Mail from Gmail/Google Workspace gets occasional `421 4.7.0 [IP] Our system has detected...` deferrals.
- internet.nl mail test shows red marks on SPF/DMARC/DANE that aren't explained by "we don't send."
- Users report mail from some big senders never arriving while mail from others does.

**Phase to address:**
Phase: **Domain & DNS setup** (initial). Everything here is configured once at project start and should be verified with an external tool before any user-visible launch.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store messages as files in Maildir | Standard MTA integration, "just works" | Inode exhaustion, slow retention DELETE, hard to query, hard to back up consistently | Only if you are already deeply familiar with Maildir operations. Otherwise use a DB. |
| Use `dangerouslySetInnerHTML` + DOMPurify without iframe isolation | Simpler frontend, no iframe postMessage plumbing | DOM clobbering, mutation XSS, tracking pixels still load, CSS exfil | **Never** for a public tempmail. Use sandboxed iframe. |
| Address in URL path (`/inbox/alice1234`) | Simple routing, shareable URLs | Enumeration, URL leakage, no separation of "address" (public) vs "view token" (secret) | Only if address has ≥64 bits entropy AND rate limits AND you explicitly accept "URL = capability" semantics. |
| One domain, hardcoded everywhere | Fastest v1 path | Can't rotate when domain hits a signup-blocker list, whole product becomes unusable at target sites | Domain rotation isn't a v1 feature but "domain" must be a first-class data-model entity. Don't hardcode the domain string. |
| Rely on MTA default `message_size_limit` | No config | First oversized attachment fills disk; no uniform enforcement between MTA and app | Never — set it explicitly even if you match the default. |
| No sweeper; "retention enforced on read" | No background jobs to run | Disk grows unboundedly for any address that's never re-opened | Never. Sweeper is non-negotiable. |
| Log full sender + recipient for "debugging" | Easier incident triage | Privacy disaster, GDPR exposure, subpoena/blackmail target | Only if you strip to domain-only for sender and hash-only for recipient, with short retention. |
| Single MX record, no backup | Simpler DNS | Any 30-min VPS outage = bounced mail (after MTA retry exhaustion, up to 5d) | v1 acceptable — real senders queue and retry. Revisit if uptime matters. |
| Generic public `contact@` only; no `abuse@` | One less thing to set up | Abuse complaints go directly to hosting provider → VPS suspension | Never. `abuse@` is ~free and saves the VPS. |
| Skip rate limiting in v1 "to ship fast" | Ship faster | Bots discover you in days and make abuse reports a weekly event | Never — rate limits must ship in v1. |

---

## Integration Gotchas

Common mistakes when connecting to external services / infrastructure.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| **VPS provider** (Hetzner/OVH/DO/etc.) | Not verifying inbound port 25 open before deploy; not reading AUP for "disposable email" mentions | Provision, `nc -vz <ip> 25` from external host, read AUP for mail-service and disposable-mail mentions, confirm via support ticket if ambiguous |
| **DNS provider** | Setting MX to a CNAME target; default TTL too high (24h); no support for low-TTL for migration | Pick a DNS host that supports 60–300s TTLs; set MX target to a direct A/AAAA name; lower TTL 48h before any migration |
| **Let's Encrypt / ACME** (for HTTPS + MTA-STS) | Using HTTP-01 on the same port 80 as your webapp without coordination → auto-renew breaks in Docker | Use DNS-01 for renewal or a dedicated ACME sidecar with webroot-hook — don't couple webapp uptime to cert renewal |
| **Hosting provider abuse contact** | Not registering `abuse@yourdomain.tld` with your WHOIS and security.txt | Publish abuse contact prominently; monitor the address; respond within hours, not days |
| **Spamhaus / UCEPROTECT / disposable-domain aggregators** | Trying to get delisted for being a tempmail | Don't try. The listing is factual. Plan for it instead: design for domain rotation, keep personal/pro domains isolated from tempmail domain |
| **Target services your users sign up at** | Treating "our domain was blocklisted at service X" as a bug to fix | Feature, not bug — some/many will block you. This is the product category. Tell users via UX ("if a site rejects this address, try refreshing for a new one") |
| **MTA (Postfix/Haraka/etc.)** | Using default logging verbosity with PII in it | Configure minimum logging, hash recipients, rotate aggressively |
| **WebSocket / SSE library** | Assuming "subscribe" is ordered before "publish" relative to ingestion | Always replay-on-subscribe from persistent store; pub/sub is only a nudge |
| **Reverse proxy (nginx/Caddy)** | Logging full URL paths that include addresses | Strip or hash the address portion of the path in access logs; or don't put address in path at all |
| **Analytics / error tracking** | Default Sentry etc. sending user data off-box | No third-party SDKs on frontend; self-hosted error logs only; scrub PII |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows. Scale thresholds are order-of-magnitude estimates for a 1–2GB RAM / 1 vCPU VPS.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| **Maildir with many small files** | `df` fine, `df -i` at 100%, new mail fails with "no space" that isn't really no space | DB blob storage, or Maildir++ with aggressive expiry, or ext4 with high inode ratio (`mkfs.ext4 -N` or `-i 4096`) | ~500k–1M messages lifetime (depends on FS) |
| **Full-table-scan on "unexpired inboxes"** | Sweeper takes longer than retention window, so it never catches up | Index on `expires_at`; sweeper uses `WHERE expires_at < now()` with limit+loop, not one big DELETE | ~100k active inboxes |
| **Broadcast pub/sub (every subscriber sees every event, filters client-side)** | CPU spikes at the web tier, WebSocket process RAM grows | Per-address channel (Redis `SUBSCRIBE inbox:<id>`, or NATS per-subject) | ~1k concurrent open inboxes |
| **HTML sanitization on every message read** | High CPU per render, slow inbox open | Sanitize once at ingestion, store sanitized HTML | ~10 msg/s open rate |
| **Attachment download: stream from DB every request** | DB memory balloons, OOM kills | Store attachments on disk or dedicated blob store; stream with `sendfile`; cache-control headers for short-lived tokenized URLs | ~10MB/s throughput sustained |
| **No connection limits on MTA** | One bad sender opens 1000 concurrent SMTP connections, memory exhausted | Per-IP concurrent connection limit (Postfix `smtpd_client_connection_count_limit`, Haraka equivalent) | ~50 concurrent SMTP conns |
| **Synchronous delivery pipeline (MTA → app → DB in one blocking call)** | SMTP timeouts under load, senders retry and amplify problem | MTA writes to a queue (spool dir or Redis list); app consumes async; respond 250 fast | ~10 msg/s arrival rate |
| **JSON log lines without log rotation** | `/var/log` fills disk separately from data disk | `logrotate` with hourly/daily rotation and 24–48h retention; or use `journalctl` with explicit size cap | ~1 week of "real" traffic |
| **No DB vacuum / compaction** (SQLite/Postgres) | Disk stays allocated after expiry deletes; apparent disk growth doesn't match message count | Scheduled vacuum/ANALYZE; for SQLite, periodic `VACUUM` or incremental auto-vacuum | ~1–2 weeks after any deletion volume |
| **Frontend polls every second** | N users × 1 Hz = N req/s on a single-VPS API | WebSocket/SSE primary, polling only as fallback; if polling, ≥15s interval with exponential backoff | ~100 concurrent users |

---

## Security Mistakes

Beyond generic web security (CSRF, session hijack, etc.), domain-specific issues for tempmail.

| Mistake | Risk | Prevention |
|---------|------|------------|
| **Address-as-URL-path with low entropy** | Attackers enumerate addresses, harvest password resets and 2FA codes en masse | ≥64 bits entropy in address; separate view-token in cookie; rate-limit inbox reads per IP |
| **Rendering email HTML in main document origin** | XSS in webmail origin → steals other open inboxes, can pivot to cookies | Sandboxed iframe without `allow-scripts` or `allow-same-origin`; DOMPurify as defense-in-depth |
| **Allowing remote images / fonts / CSS to load without user click** | Sender learns user's real IP (deanonymization), user engagement tracked via pixels | Block remote content by default; proxy it through server when user opts in |
| **Logging full email content, sender, or recipient long-term** | Breach = mass PII disclosure; subpoena / coercion target | Log-minimization policy; hash recipients; short retention; no off-box log forwarding |
| **Not rate-limiting address creation per IP** | Bot farms create 10k addresses/min → hosting abuse reports → VPS termination | Per-IP 5/min, 50/hour soft cap with 429; global address-creation rate limit |
| **Accepting mail for any recipient (catch-all) without address pre-existing** | Unlimited storage amplification via spraying; spam traps | MTA only accepts `RCPT TO` for addresses that currently exist in DB; 550 otherwise at SMTP level |
| **Allowing message bodies to be submitted via the web UI ("send as this address")** | Service becomes spam relay → permanent IP blacklisting, VPS termination | Receive-only (already in constraints) — **reject all outbound SMTP code paths in code review** |
| **No maximum message size at SMTP DATA** | 1 attacker sends a few GB messages, fills disk | Set MTA `message_size_limit` explicitly (e.g., 10MB); enforce same or stricter at app layer |
| **Exposing admin / debug endpoints on public port** | Full inbox dump or message browser accessible to anyone who finds the URL | No admin endpoints on public port; admin on Unix socket or bound to localhost with SSH tunnel access only |
| **Session/view token in URL** | Token leaks via Referer header to every external resource the email links to | Token in cookie (HttpOnly, SameSite=Lax) or in-memory JS state; never in URL |
| **Storing attachments without content-type sniffing control** | User opens "image" that's actually HTML → XSS | Always serve attachments with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`; for inline preview, re-encode |
| **No envelope-from validation at MTA** | Accepts mail with spoofed envelope, logs noise, enables backscatter | Basic SPF checking on ingress (even though you're receive-only) — informational, not reject |
| **No TLS on inbound SMTP** | Mail in transit is cleartext; some senders refuse / downgrade warnings | STARTTLS on port 25 with Let's Encrypt cert; publish MTA-STS |
| **Self-hosted open WebSocket endpoint without origin check** | Any website can WebSocket to your API and fingerprint / enumerate | Check `Origin` header on upgrade; CORS on REST; SameSite cookies |

---

## UX Pitfalls

Common UX mistakes specific to public tempmail.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| **"Address arrives then you wait" flow** | User pastes address, signup email arrives at t=100ms, but UI only shows it at t=3s (race) → user thinks service is broken | Replay-on-subscribe pattern (Pitfall 6). First email must appear instantly regardless of order. |
| **Silent inbox expiry** | User comes back after 15 min, inbox is gone, emails lost with no warning | Show countdown timer; warn 60s before expiry; "extend" button that resets idle timer with one click |
| **No copy-to-clipboard affordance near address** | User manually selects and copies, sometimes captures extra whitespace/newline that breaks the target signup form | Dedicated copy button that copies exactly `address@domain` with no whitespace; visual "copied!" confirmation |
| **Changing address on refresh without asking** | User refreshes to check for mail, address is regenerated, previous email to old address is lost | Address persists in cookie/localStorage until explicit "new address" click or expiry |
| **Only showing HTML view** | Plain-text senders show nothing; tracking-heavy HTML renders confusing blank iframe | Default to text view when available; "View HTML" toggle; show both if significantly different |
| **Not showing the full raw headers on request** | Power users debugging why a specific mail isn't arriving can't inspect | "View source / headers" link for each message (but behind a click, not default) |
| **Showing "0 messages" identically to "inbox not found"** | Debugging "is my address even valid?" becomes guesswork | Distinguish in UI: "Waiting for first email" vs "Inbox expired / not found" — but be careful to not leak existence to attackers (see Pitfall 9, rate-limit reads) |
| **No indication that "site rejected this address as disposable"** | User wastes time re-pasting a dead address | When signup fails, user doesn't know — can't be detected from tempmail side. Mitigate with "try a different domain" button (requires multi-domain support in data model). |
| **Auto-loading remote images** | User's IP + open event leaked to sender silently | Block by default; prominent "This email wants to load external images — click to load" banner |
| **Address displayed in a `<input readonly>` that selects partially** | Mobile users can't reliably copy; triple-click doesn't work on mobile | Big plain-text address with a prominent copy button; on click → copy + visual feedback |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces. Run through this before calling v1 done.

- [ ] **Ingestion works in dev:** But is the sweeper running? Has it actually deleted anything? `SELECT count(*) FROM messages WHERE expires_at < now()` must equal 0 after sweeper pass.
- [ ] **Realtime UI updates:** But does it handle the "email arrives before WebSocket subscribed" race? Integration test: mint address → immediately (no delay) fire SMTP send → verify UI shows it.
- [ ] **HTML email renders:** But is it in a sandboxed iframe (view source of the webmail page — search for `<iframe sandbox`)? Does opening a test email with `<script>alert(1)</script>` in HTML body NOT alert? Does it also not load remote images by default?
- [ ] **Retention policy documented:** But is it enforced by code? Sweeper unit present in systemd/cron/supervisor, running, logging, and you've watched it delete something?
- [ ] **Rate limits documented:** But tested? Script 100 address creations in 10s from one IP — you must see 429s after the threshold.
- [ ] **MX record configured:** But does it pass `internet.nl/mail/yourdomain.tld/` with no red marks? Is the target a real A/AAAA record, not a CNAME? Does `dig -x <ip>` return a name that matches your MX target (FCrDNS)?
- [ ] **SPF/DMARC published:** But is SPF set to `-all` (non-sending) and DMARC `p=reject`? You should explicitly *disavow* sending, not claim permission.
- [ ] **Inbound TLS works:** But does STARTTLS advertise a valid cert? `openssl s_client -connect <mx>:25 -starttls smtp` should return a valid chain.
- [ ] **Logs exist:** But do they NOT contain message bodies, subjects, or full recipient addresses? Grep production log for `@yourdomain.tld` and for common signup subjects like "verify your email" — hits mean leakage.
- [ ] **Disk monitoring alerts set:** But have you tested them by filling a throwaway file until threshold? Do you get the alert? Via what channel (not your own MTA, ideally)?
- [ ] **`abuse@yourdomain.tld` address exists:** But does it deliver to somewhere you actually read? Send a test from a personal account; confirm arrival.
- [ ] **Deploy / redeploy tested:** But was it tested with MX TTL propagation? A real redeploy that moves the MX should have been rehearsed once in staging or on a sibling domain.
- [ ] **Backup strategy:** But for a tempmail with 10-min retention, "backup" mostly means "re-deployable infrastructure" — is the VPS config reproducible from a script/Dockerfile? Can you stand up a new VPS in <1 hour?
- [ ] **VPS inbound port 25 verified:** But tested from *multiple* external IPs, not just your laptop? Some ISPs filter outbound 25 from residential networks — so a successful `nc` from home doesn't mean open, and a failed `nc` from home doesn't mean closed.
- [ ] **Address enumeration hardened:** But tested? Script 1000 requests to `/inbox/<random-nonexistent>` — rate limit must kick in; responses must be indistinguishable from empty-existing.
- [ ] **Tracking pixel blocking:** But verified with a real tracking-pixel sender (sign up for a Substack or similar newsletter to the tempmail, open the email, confirm no network request to the sender's pixel domain).

---

## Recovery Strategies

When pitfalls occur despite prevention.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Domain listed on a disposable-provider aggregator | **LOW** (expected) | Don't fight it; if it blocks enough target sites, rotate to secondary domain. Pre-register a fallback. |
| Domain listed on Spamhaus DBL for sending spam (surprising for receive-only) | **MEDIUM** | Investigate: did outbound get enabled accidentally? Shared hosting with another spam source? Isolate, fix root cause, then submit delisting request from a non-disposable email. |
| Hosting provider abuse report | **MEDIUM–HIGH** | Respond within hours. Acknowledge, explain service, show existing rate limits, add the specific complainant's address to block list. Follow up after resolution. |
| Hosting provider suspends VPS | **HIGH** | Have a second-provider fallback pre-staged. Re-deploy from script. Lower old MX TTL was done 48h ago, right? Update MX to new IP. Accept ~hours of queued mail delay. |
| Disk full → MX rejecting | **LOW if caught fast** | Run sweeper manually with aggressive retention (`WHERE expires_at < now() - interval '2 min'`). Restart MTA. Investigate why sweeper didn't catch up (cron dead? query slow?). Real senders will retry queued mail within minutes. |
| Inode exhaustion | **MEDIUM** | Hard: `find /var/spool -type f | wc -l` to locate. Migrating storage to DB blobs is the real fix. Short-term: `find ... -delete` on expired items; resize filesystem with higher inode count (requires mkfs, painful). |
| Attacker harvests inboxes via enumeration | **HIGH (hard to detect, hard to prove scope)** | Rotate all active view-tokens immediately (users see expired inbox, acceptable for a 10-min service). Add rate limiting if not present. Add entropy to addresses going forward. Disclose if you have a legal obligation. |
| XSS in rendered email | **HIGH** | Rotate all active sessions. Audit what an attacker-controlled origin could access (other open inboxes? cookies for other paths?). Add iframe isolation if absent. Disclose if confirmed exploited. |
| PII leak via logs to third party | **VERY HIGH** | Revoke third-party log-collector credentials. Request deletion from all downstream (Datadog, etc.) — they're processors under GDPR and must delete on request. Document timeline. Probable disclosure obligation depending on jurisdiction. |
| MX migration lost hours of mail | **MEDIUM** | Mail is queued at sending MTAs for up to 5 days typically; bringing old MX back online (even just forwarding) recovers most of it. Publish status page; user-reach-out mostly not possible given no-accounts constraint. |
| VPS provider AUP forbids "disposable email" retroactively | **HIGH** | Migrate. Maintain deploy-script reproducibility. Low-TTL MX helps. |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls. Also distinguishing **launch-blockers** (bites at launch, v1 cannot ship without) from **scale-blockers** (bites as usage grows, defer-able if rate limits are in place).

| Pitfall | Prevention Phase | Launch vs Scale | Verification |
|---------|------------------|-----------------|--------------|
| Domain listing on DBLs | Domain/DNS + Ops phase | Scale (expected, not blocking) | `dig TXT yourdomain.tld.dbl.spamhaus.org` (should show listing eventually — not a bug) |
| Outbound/inbound port 25 confusion | Infrastructure/VPS phase | **Launch** | `nc -vz <vps-ip> 25` from external host returns 220 banner |
| Signup-fraud abuse → VPS termination | Abuse/ops hardening phase | **Launch** (rate limits non-negotiable) | Load test: 100 POST /api/addresses from one IP in 10s → 429 after threshold |
| PII / log hygiene | Core ingestion + every phase review | **Launch** | `grep -E "(@yourdomain|Subject:|From:)" /var/log/*` on prod returns nothing sensitive |
| HTML rendering safety (XSS, pixels) | Frontend rendering phase | **Launch** | Send crafted email with `<script>`, tracking pixel, CSS url() → none execute, none fetch |
| Realtime race condition | Core ingestion + realtime phase | **Launch** | Integration test: mint + SMTP send in same function call → UI gets message |
| No sweeper / no size caps | Core ingestion phase | **Launch** | Leave running for 24h → disk usage flat, message count bounded |
| MX TTL / deploy mail loss | Deploy/ops phase | Scale (matters only when redeploying) | First redeploy procedure documented and rehearsed |
| Inbox address enumeration | Frontend/API design phase | **Launch** (capability model decided at v1) | Script 1000 random /inbox reads → rate limited, responses opaque to existence |
| DNS misconfiguration (receive-only specific) | Domain/DNS setup phase | **Launch** | internet.nl mail test passes; `dig` checks all correct; `openssl s_client -starttls smtp` returns valid cert |
| Inode exhaustion (Maildir) | Storage-model decision phase | Scale (doesn't bite at launch) | `df -i` monitoring, or avoid by using DB blobs |
| Abuse contact absence | Domain setup phase | **Launch** (missing one = VPS suspension later) | `abuse@yourdomain.tld` sends test to your real inbox; WHOIS lists it |
| Catch-all acceptance (any recipient) | MTA config phase | **Launch** | Send to a known-nonexistent random address → 550 Unknown User, not 250 |

### Phase ordering implication

Based on the above, a sensible phase order for the roadmap is:

1. **Domain & DNS** (correct MX/PTR/SPF=-all/DMARC=reject, abuse@, receive-only TLS)
2. **VPS infrastructure & inbound-25 verification** (pick provider, verify 25, read AUP)
3. **Core ingestion** (MTA config with size caps, catch-all disabled, storage model, sweeper, PII-minimizing logs)
4. **Address model & API** (≥64-bit entropy addresses, view-token separation, rate limits on creation and reads)
5. **Realtime + frontend** (replay-on-subscribe, sandboxed-iframe HTML render, block-remote-content default, expiry countdown UX)
6. **Abuse & ops hardening** (monitoring for disk/inode, abuse@ triage procedure, per-address block-on-request, deployment runbook with TTL lowering)
7. **Deploy & launch** (external verification via internet.nl, third-party send tests, integration tests for race, enumeration, XSS)

Pitfalls mapped to earlier phases in this list are **launch-blockers**. Pitfalls in phase 6+ are **operational hygiene** that bite as the service grows but can be handled iteratively if phases 1–5 are solid.

---

## Sources

Research sources with confidence notes:

**HIGH confidence (official docs, RFCs, well-known operator writeups):**
- [RFC 2181: Clarifications to the DNS Specification (MX-to-CNAME prohibition, §10.3)](https://www.rfc-editor.org/rfc/rfc2181)
- [RFC 1912: Common DNS Operational and Configuration Errors](https://www.ietf.org/rfc/rfc1912.txt)
- [Postfix Performance Tuning (official)](https://www.postfix.org/TUNING_README.html)
- [Postfix Receiving Limits (O'Reilly Postfix: The Definitive Guide)](https://www.oreilly.com/library/view/postfix-the-definitive/0596002122/ch04s06.html)
- [Spamhaus Domain Blocklist FAQ](https://www.spamhaus.org/faqs/domain-blocklist/)
- [Spamhaus Policy Blocklist (PBL)](https://www.spamhaus.org/blocklists/policy-blocklist/)
- [Fastmail: Sanitising HTML — the DOM clobbering issue (well-known webmail operator writeup)](https://www.fastmail.com/blog/sanitising-html-the-dom-clobbering-issue/)
- [Close: Rendering untrusted HTML email, safely (sandboxed-iframe approach documented)](https://making.close.com/posts/rendering-untrusted-html-email-safely/)
- [DOMPurify (Cure53) — canonical HTML sanitizer](https://github.com/cure53/DOMPurify)
- [Gang Wang et al., "Characterizing Pixel Tracking through the Lens of Disposable Email Services" (academic paper on exactly this threat model)](https://gangw.cs.illinois.edu/tracking-sp19.pdf)
- [EFF: How to Protect Yourself From Email Tracking](https://www.eff.org/deeplinks/2019/01/stop-tracking-my-emails)

**MEDIUM confidence (operator writeups, community consensus, provider docs):**
- [UCEPROTECT Level 3 official page (policy)](https://www.uceprotect.net/en/index.php?m=3&s=5)
- [LowEndTalk: "Can I safely ignore the UCEPROTECT blocklist?" (community consensus that L3 has limited impact at major mailbox providers)](https://lowendtalk.com/discussion/212367/can-i-safely-ignore-the-uceprotect-blocklist)
- [LowEndTalk: "OVH will shut down your server if an abuse report is received"](https://lowendtalk.com/discussion/183760/ovh-will-shut-down-your-server-if-an-abuse-report-is-recieved)
- [LowEndTalk: "Hetzner Abuse & Suspension Issue"](https://lowendtalk.com/discussion/195720/hetzner-abuse-suspension-issue)
- [PTR / rDNS records for email delivery (SMTPedia)](https://smtpedia.com/ptr-rdns-records/)
- [MailRoute: Best Practices for Changing MX Records (TTL lowering before migration)](https://support.mailroute.net/hc/en-us/articles/39787479510803-Best-Practices-for-Changing-MX-Records)
- [Cisco advisory: Malformed MIME Header Filtering Bypass (shows the class of parser bugs)](https://www.cisco.com/c/en/us/support/docs/csa/cisco-sa-20170201-esa1.html)
- [Proton Mail: Enhanced tracker protection documentation (proxy model for images)](https://proton.me/support/email-tracker-protection)
- [GDPR.eu: How the GDPR affects email](https://gdpr.eu/email-encryption/)

**Known-in-practice / operator consensus (informal but widely confirmed):**
- Tempmail operators facing DBL listing is standard — verified across prospeo.io, kickbox, trustfull aggregator lists that explicitly enumerate tempmail domains.
- Directus and Supabase issue trackers for real-world WebSocket subscribe-vs-publish race bugs.
- Postfix mailing list discussions of maildrop inode exhaustion (pc-freak.net writeup on recovering from it).

**LOW confidence (single source or inference — flagged for validation during execution):**
- Specific rate-limit thresholds (5/min, 50/hour) are operator-defensible defaults, not empirically derived for this service. Tune based on observed traffic patterns post-launch.
- Specific disk watermarks (10%, 5%) are conventional but should be adjusted for actual VPS disk size.
- Exact scale thresholds in "Performance Traps" are order-of-magnitude — real-world thresholds depend on stack choice (Postfix vs Haraka vs custom, SQLite vs Postgres, etc.) which is not yet decided per PROJECT.md.

---

*Pitfalls research for: self-hosted public disposable email service (tempmail)*
*Researched: 2026-04-18*
