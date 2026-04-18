# Feature Research

**Domain:** Public, anonymous, self-hosted disposable email (tempmail) service — single VPS, free-to-run, receive-only, no accounts
**Researched:** 2026-04-18
**Confidence:** HIGH (ecosystem is mature and well-documented; conventions are stable across reference products)

## Executive Summary

Public tempmail is a commodity product — the competitive landscape (10minutemail, mail.tm, temp-mail.org, Mailinator, mailsac) has converged on a narrow set of table-stakes features. The primary axes of variation are (1) **privacy model** (deterministic-public a la Mailinator vs. session-private a la mail.tm/10minutemail), (2) **real-time delivery** (SSE/WebSocket vs. polling), and (3) **abuse-resistance posture** (lenient vs. captcha-gated vs. blocklist-aware). For a single-VPS, solo-operator, anonymous-only product, the differentiation is **speed, trust, and operational calm** — not feature breadth. Building less is the competitive move.

The reference products teach three things worth internalizing:
1. Users equate "fast first email" with "service works." Sub-second arrival in the UI after SMTP delivery is the perceived quality bar. Polling that feels instant is acceptable; delays of >5 seconds feel broken.
2. Timers that hard-kill an active session are a top user complaint. Idle-based expiry (reset on activity) plus a hard ceiling is the modern pattern.
3. HTML email is the biggest attack surface. Every mature tempmail renders HTML *in an iframe with sandboxing and a sanitizer*, or degrades to text. Naive HTML rendering is a class of CVE waiting to happen.

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these means the product feels broken. All are already listed or implied in `PROJECT.md` Active requirements, but are categorized here with complexity and abuse interaction.

| Feature | Why Expected | Complexity | Notes / Abuse & Ops Impact |
|---------|--------------|------------|----------------------------|
| Zero-signup auto-assigned inbox on first visit | The entire value prop. Typing an address or clicking a button is friction. | S | Inbox must exist server-side (not just client) so MX can deliver before user sees it; keyed by opaque session token in cookie/localStorage so reloads restore the inbox. Abuse: per-IP rate-limit address creation (bots spin up millions). |
| Receive real email from any external sender (valid MX/SPF/DKIM/DMARC) | A tempmail that can't receive Gmail is a toy. | M | Requires correct DNS (MX, SPF, DKIM signing for bounces, DMARC policy), reverse DNS (PTR), TLS on port 25. Ops: a single misconfigured record = silently dropped mail and no user feedback loop. |
| Real-time inbox updates (no manual refresh) | Every competitor does this. Polling a refresh button in 2026 feels broken. | M | SSE is the right default (HTTP, proxy-friendly, auto-reconnect, one-way fits use case); WebSocket is overkill; long-polling as fallback. Abuse: long-lived connections are a DoS vector — cap concurrent streams per IP and idle-timeout aggressively. |
| Read full message: sender, subject, date, text body, HTML body | Basic email UI. Missing any field feels amateur. | M | HTML body rendering is the hard part — see Pitfalls. Text fallback must always be available (some senders send text-only, some HTML-only). |
| HTML email rendering (sanitized, sandboxed) | ~90% of transactional mail is HTML-heavy. Text-only fallback alone feels broken for verification emails with styled buttons. | L | **Highest-risk feature in the whole app.** Must sanitize (strip `<script>`, `on*` handlers, `javascript:` URLs, dangerous CSS), render in sandboxed iframe (`sandbox="allow-same-origin"` NOT including `allow-scripts`), and block/proxy remote images by default. XSS in webmail is a recurring CVE class (Roundcube, etc.). |
| Attachment download (or at minimum: show that attachments exist) | Verification codes sometimes arrive as attachments; breaking this quietly is worse than refusing them loudly. | M | Strong recommendation: accept but gate — show filename + size, require explicit click to download, serve with `Content-Disposition: attachment` + restrictive `Content-Type`, never render inline. Abuse: storage bloat, malware redistribution. Set per-message size cap (e.g. 10 MB) and total inbox cap. Ops-minimizing alternative: reject attachments at SMTP with clear bounce message. **Recommend: accept, size-capped, download-only.** |
| Manually request a new address ("new inbox" button) | Users burn addresses routinely. One-click reset is expected. | S | Issues new address, invalidates old session, drops old messages immediately (don't leave them on disk — privacy expectation). Abuse: rate-limit per IP to prevent address-churn bots. |
| One-click copy address to clipboard | Universal pattern; every competitor has it. | S | Use `navigator.clipboard.writeText()` with fallback. Show transient "Copied!" confirmation. Pure client-side, no abuse surface. |
| Idle-based auto-expiration with countdown visible | Defines "disposable." Users need to know when it dies. | M | Show remaining time (e.g., "expires in 9:47"). Reset timer on activity (WebSocket heartbeat, HTTP poll, tab focus). Hard ceiling regardless of activity (e.g., 1 hour max) to bound storage. Abuse: without a hard ceiling, a bot keeps an address alive forever. |
| Mobile-responsive UI | ~60% of tempmail traffic is mobile (quick verification on phone). A desktop-only UI is dead. | M | Single-column layout, large tap targets on address + copy, readable HTML email on narrow viewport. No native app needed (explicitly out of scope). |
| Service works without JavaScript (graceful degradation — at least reading mail) | Debatable; mark as "nice-to-have" if time-constrained. See differentiators. | M | — |
| Clear retention/privacy statement visible on site | Users increasingly scan for this. Missing = sketchy. | S | One-paragraph "what we keep, for how long, what we log." No GDPR-style legalese needed for a personal project, but stating it is table stakes now. |

### Differentiators (Competitive Advantage)

Features where the product can earn trust and recommendation over 10minutemail/temp-mail.org (which have degraded into ad-heavy, popup-ridden experiences).

| Feature | Value Proposition | Complexity | Notes / Abuse & Ops Impact |
|---------|-------------------|------------|----------------------------|
| Zero ads, zero tracking, zero popups | Every competitor has degraded here. This is the easiest, highest-signal differentiator for a personal project with no monetization pressure. Aligns with PROJECT.md explicit "no analytics SDKs, no telemetry." | S (a choice, not code) | Enforced by absence — don't add GA, don't embed trackers, don't use CDN fonts that phone home. Ops: simpler CSP. |
| Address persistence within a session (restore on reload) | 10minutemail loses your inbox on accidental tab close; users hate it. A cookie-bound session that restores the same inbox on reload is a small change with outsized perceived quality. | S | Opaque session token in cookie or localStorage. No account created — the token IS the "account." Abuse: token must be cryptographically random (128+ bits) to prevent enumeration. Rate-limit restore attempts. |
| Idle-reset timer (keep-alive while tab is active) | Modern expectation (per PostInBox, tempmailo). Fixed 10-min hard timers interrupt slow OTP flows and generate complaints. | S | Timer resets on any server interaction (poll tick, SSE heartbeat, message fetch). Hard ceiling (e.g., 1h) still applies. Abuse: bounded by hard ceiling, so minimal additional risk. |
| QR code of the address | Quick handoff phone ↔ desktop for signup flows; cheap to add; feels modern. | S | Pure client-side library (qrcode.js). No server cost, no abuse surface. |
| HTML email rendered with remote images blocked by default + "load images" toggle | Privacy by default (blocks open-pixel trackers); matches Proton/Fastmail convention. Differentiator vs. competitors that load everything. | M | Requires HTML rewriter that strips `src` attrs on `<img>`, optionally replaces with placeholder. Toggle rewrites and reloads. Bonus: image proxy (see anti-features — probably skip for v1). |
| Fast, honest status page / system health (public) | Signals operator competence; takes minutes to add. | S | Simple static page showing "MTA: up, Web: up, Queue depth: 0." Even a plain uptime dot beats having nothing. |
| Public-inbox-by-address mode (Mailinator-style) — OPTIONAL, opt-in-per-user | A power-user feature for testing: any email to `anyname@domain` is readable at `/inbox/anyname` with no session. Useful for developers and CI. **Only if privacy story is clearly communicated.** | M | **High abuse and confusion risk.** If shipped, must be strictly opt-in via a separate URL pattern (e.g., `/public/<name>`) and never the default. Messages still auto-expire. Consider deferring to v2 — the default-private model is the safer public launch. |
| HTTP API for programmatic access (read-only, no auth, rate-limited) | Developers love tempmail APIs for CI/E2E tests (mail.tm API is widely loved). Zero-cost if the UI already has a JSON endpoint — just document and stabilize it. | S (if piggybacking on UI endpoints) / M (if versioned + documented separately) | Abuse: without auth, strict per-IP rate limits are non-negotiable. SSE endpoint for new-message events is the killer feature (mail.tm has this). Be careful not to invite load: cap concurrent SSE streams per IP. |
| View raw email source | Niche but developer-loved; takes 30 min to add once parsing is done. | S | "Show original" button renders the raw RFC822. Also useful for debugging your own MTA config. |
| Dark mode | Cheap, expected by a subset of users. | S | CSS media query `prefers-color-scheme` — zero JS needed. |
| No-JS read path (SSR for viewing messages, JS only for real-time) | Works on hostile networks, privacy browsers, text-mode readers, Tor. Differentiator in a space where every competitor requires modern JS. | M | Adds some server-side rendering work but isolates the JS layer to the live-update feature only. Abuse: same as JS path, just fewer client signals for bot detection (acceptable tradeoff). |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem like obvious wins but are load-bearing against the product's constraints (single VPS, solo operator, free, anonymous, high-abuse-vector).

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| User accounts / persistent inboxes | "I want to keep my inbox for later" | Defeats the disposable premise; adds auth surface (password reset, session hijack, account takeover, breach notification obligations); changes legal posture (now you hold user data). Already in PROJECT.md out-of-scope. | Session-token persistence (differentiator) restores the inbox on the same browser without creating an account. |
| Sending email (outbound SMTP) | "Reply to verification emails," "use as throwaway sender" | Instantly becomes a spam relay. IP gets blocklisted within days. Legal liability (abuse reports, ISP ToS violations). Already in PROJECT.md out-of-scope. | Receive-only, period. If users need to reply, that's not this product. |
| Custom user-chosen addresses | "I want a memorable address like `joe@yourdomain`" | Enables enumeration attacks (Mailinator-style public inboxes become readable by anyone who guesses the name); creates namespace collisions; users squat on good names. Already in PROJECT.md out-of-scope. | Random addresses with enough entropy (~12 chars / 60+ bits) are unguessable and collision-free. |
| Catch-all forwarding to real inbox | "Make it an alias service" | Different product category; turns tempmail into a forwarder with spam-amplification risk for the target inbox. Already in PROJECT.md out-of-scope. | If users want aliasing, point them at SimpleLogin, AnonAddy, addy.io. |
| Spam filtering / virus scanning | "You should protect users from bad content" | Wrong threat model — by design, users WANT to receive anything sent to a disposable address (including verification emails marked as spam by aggressive filters). Also: rspamd/ClamAV is real RAM. Already in PROJECT.md out-of-scope. | Render HTML safely (sandbox + sanitize), block remote images by default, cap attachment size. Protect the *user from the content*, not the inbox from the sender. |
| Paid tiers / premium features | "Monetize it" | Explicit personal-project goal: free to run, free to use. Adds billing, tax, support, legal. Already in PROJECT.md out-of-scope. | Keep the scope bounded enough that free operation on one VPS is sustainable. |
| Multi-domain support in v1 | "Offer multiple domains like temp-mail.org" | Multiplies MX/DKIM/SPF/DMARC config burden; each domain is a separate deliverability reputation to maintain; domain rotation is what spammers do. Already in PROJECT.md out-of-scope. | One domain, well-configured, good reputation. Multi-domain is a v2 concern *if* blocklisting by receivers becomes a real problem. |
| Native mobile/desktop apps | "Have an app" | App-store overhead, update channels, platform-specific bugs. Already in PROJECT.md out-of-scope. | Responsive mobile web + "Add to Home Screen" PWA manifest gives 90% of the UX at 5% of the cost. |
| Anti-bot CAPTCHA on every visit | "Stop bots from creating inboxes" | CAPTCHAs on the landing page destroy conversion and the "under 3 seconds" Core Value. Also: reCAPTCHA is a tracking surface that violates the no-telemetry stance. | Rate-limit address creation by IP (e.g., 10/hour). Trigger ALTCHA/hCaptcha **only** when the rate limit trips. Privacy-friendly captchas (ALTCHA is self-hostable, no Google). |
| Blocklist-aware address generation (avoid domains on DNSBLs) | "My addresses are blocked by sites" | Cat-and-mouse game with disposable-email blocklists; if you're on the list, adding a new domain just adds it to the list. Low-traffic personal domains have a head start because they're not *on* the blocklists yet. | Accept that some sites will block; don't fight it. Users understand tempmail is gate-kept by some services. |
| Public inbox for any address (Mailinator default mode) | "Developers can guess addresses" | Enormous privacy footgun — any OTP sent to a guessable address is readable by everyone. Trains users to trust a model they shouldn't. | Private-by-default (session-scoped); *if* public addresses are offered, make them strictly opt-in and namespaced (`/public/*`). |
| Infinite retention / "just keep them" | "I might want to check later" | Storage grows unbounded on a single VPS; legal posture shifts from "we hold nothing" to "we hold indefinitely." | Bounded retention (idle + hard ceiling) is the core product invariant. |
| Full-text search across all inboxes | "Power user feature" | No — each inbox is session-scoped; "all inboxes" is an admin capability that a no-accounts system shouldn't have. | Within a single inbox, client-side filter/search is fine (one-screen of messages rarely needs server search). |
| Analytics / engagement tracking | "Understand usage to improve" | Violates PROJECT.md privacy stance. Also: for a free personal project, hot takes from the aggregate are rarely actionable. | Server logs with aggressive rotation (7 days, IP-hashed) are enough to diagnose abuse without becoming a dataset. |
| Image proxy for remote `<img>` tags | "Load images safely without leaking IP" | Turns your server into an image CDN for spammers' tracking pixels — bandwidth cost, and you become a middleman in a surveillance chain. Also: caching rules are subtle. | Block remote images by default; user click-to-load accepts their own IP exposure. Simpler, more honest, zero server cost. |
| Conversation threading / Gmail-style grouping | "Modern email UX" | Massive complexity (thread reconstruction from Message-ID/References/In-Reply-To, rewriting "[RE:]" prefixes, collapsing quotes). Zero value for tempmail — inboxes exist for 10 minutes, threading is moot. | Flat message list, newest first, done. |
| Push notifications (Web Push / APNS) | "Notify me when mail arrives even when tab is closed" | Requires service worker, VAPID keys, persistent subscription storage — state the product is trying NOT to keep. Also: notifications on a tempmail tab-away imply the user expects long-lived state. | Tab must be open; SSE reconnects on focus. Matches the "disposable" semantic. |

## Feature Dependencies

```
[MX receiving + DKIM + SPF/DMARC (infra)]
    └──required by──> [Zero-signup inbox assignment]
                           └──required by──> [Read full message]
                                                  └──required by──> [HTML rendering (sanitized)]
                                                  └──required by──> [Attachment download]

[Zero-signup inbox assignment]
    └──required by──> [Real-time inbox updates (SSE)]
    └──required by──> [Manual "new inbox" button]
    └──required by──> [Copy address to clipboard]
    └──required by──> [QR code of address]

[Session token persistence]
    └──enhances──> [Zero-signup inbox assignment]   (restores same inbox on reload)
    └──enhances──> [Idle-reset timer]                (scopes "idle" to one session)

[Per-IP rate limiting (abuse)]
    └──required by──> [Zero-signup inbox assignment]   (prevents mass creation)
    └──required by──> [Manual "new inbox" button]      (prevents churn bots)
    └──required by──> [HTTP API / SSE endpoint]        (prevents connection flood)
    └──required by──> [Attachment download]            (prevents bandwidth abuse)

[HTML sanitizer + sandboxed iframe]
    └──required by──> [HTML email rendering]
    └──required by──> [Block remote images by default]
    └──conflicts with──> [Image proxy]                 (anti-feature)

[Idle-reset timer]
    └──required by──> [Hard retention ceiling]         (bounds worst case)

[Public-inbox mode (if adopted)]
    └──conflicts with──> [Session-private default]     (must be separate URL namespace)
    └──conflicts with──> [Custom addresses anti-feature] (reintroduces enumeration risk)
```

### Dependency Notes

- **MX/DNS correctness gates everything.** If inbound mail isn't received, the rest of the product is wallpaper. This is the single most important infrastructure dependency; a dedicated early phase on DNS + MTA + test-send-from-gmail is non-negotiable.
- **Rate limiting is not a v1.1 feature.** Every public endpoint (address creation, message fetch, SSE subscribe, attachment download) needs it from day one, or the VPS is a soft target on launch day. Treat rate limiting as infrastructure, not feature.
- **HTML sanitizer is pre-work for HTML rendering.** Don't land HTML rendering in a phase that doesn't also land the sanitizer — they ship together or not at all. Text-only fallback is acceptable as a v0.5 if the sanitizer isn't ready.
- **Session-token persistence and address auto-assignment compose.** Same server-side primitive (opaque token → inbox mapping). Build the primitive once; both features fall out.
- **Public inbox mode is a trap if enabled by default.** If it ever ships, it MUST live under a clearly distinct URL/namespace and the default flow MUST remain private-session. Best path: defer to v2, probably never ship.

## MVP Definition

### Launch With (v1) — matches PROJECT.md Active requirements

Minimum to validate "visit → inbox → receive email in under 3 seconds with zero signup."

- [ ] **Auto-assigned inbox on first visit** (session-token persisted in cookie) — core value prop
- [ ] **Inbound SMTP reception** with proper DNS (MX, SPF, DKIM, DMARC, PTR, TLS) — product is nothing without this
- [ ] **Real-time updates via SSE** (fallback to 5s polling if SSE closes) — table-stakes UX
- [ ] **Read message: sender, subject, date, text body, HTML body** — basic email UI
- [ ] **HTML rendering: sanitized + sandboxed iframe + remote images blocked** — ships with HTML or ships with text-only-for-now; never ships unsafe HTML
- [ ] **Attachment support**: show filename/size, download-on-click, size-capped (10 MB/file, 25 MB/inbox) — OR reject at SMTP if deferring
- [ ] **"New inbox" button** — expected UX, trivial
- [ ] **Copy-to-clipboard** — expected UX, trivial
- [ ] **Countdown timer + idle-reset + hard ceiling** (default: 10 min idle, 1 hr hard) — disposability made visible
- [ ] **Per-IP rate limits** on inbox creation, message fetch, SSE concurrency, attachment bandwidth — day-one abuse floor
- [ ] **Mobile-responsive layout** — half the traffic
- [ ] **Privacy statement visible on landing** — one paragraph, table stakes for trust

### Add After Validation (v1.x)

Ship once v1 runs stably for a week under real traffic.

- [ ] **QR code of address** — ~30 min of work, obvious win once core is stable
- [ ] **"Load remote images" toggle per message** — privacy-conscious default, user override
- [ ] **Dark mode** (CSS media query) — cheap, appreciated
- [ ] **Session-token restore on reload** — if not already in v1 via cookie persistence, promote it here
- [ ] **View raw email source** — developer/debugging feature, low cost
- [ ] **Public status page** — signals operator competence
- [ ] **HTTP/SSE API (document + stabilize what the UI already uses)** — opens developer audience
- [ ] **No-JS read path (SSR)** — differentiator, broader reach
- [ ] **ALTCHA captcha trigger when rate limit trips** — add teeth to rate limiting without punishing normal users

### Future Consideration (v2+)

Defer until real demand is evidenced and v1 ops burden is known.

- [ ] **Public-inbox opt-in mode** — only if there's clear developer demand; namespace-isolated, never the default
- [ ] **Multi-domain** — only if a specific deliverability issue forces it
- [ ] **PWA manifest / Add-to-Home-Screen** — after validating mobile usage patterns
- [ ] **Inbox export (download all messages as mbox/zip)** — if users actually ask
- [ ] **Custom retention override (per-session, within hard cap)** — users asking for longer sessions

Everything in the PROJECT.md Out of Scope list stays out of scope.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Inbound SMTP + DNS correctness | HIGH | HIGH | P1 |
| Auto-assigned inbox + session token | HIGH | MEDIUM | P1 |
| Real-time updates (SSE) | HIGH | MEDIUM | P1 |
| Read message (fields + text body) | HIGH | LOW | P1 |
| HTML rendering sanitized + sandboxed | HIGH | HIGH | P1 |
| Attachment support (capped, download-only) | MEDIUM | MEDIUM | P1 |
| "New inbox" button | MEDIUM | LOW | P1 |
| Copy address to clipboard | MEDIUM | LOW | P1 |
| Idle + hard-ceiling expiration with visible countdown | HIGH | LOW | P1 |
| Per-IP rate limiting (infra) | HIGH | MEDIUM | P1 |
| Mobile-responsive UI | HIGH | MEDIUM | P1 |
| Privacy statement | MEDIUM | LOW | P1 |
| QR code of address | LOW | LOW | P2 |
| Remote-image block + toggle | MEDIUM | MEDIUM | P2 |
| Dark mode | LOW | LOW | P2 |
| View raw email source | LOW | LOW | P2 |
| Public status page | LOW | LOW | P2 |
| HTTP/SSE public API | MEDIUM | LOW (piggyback) | P2 |
| No-JS read path | MEDIUM | MEDIUM | P2 |
| ALTCHA on rate-limit trip | MEDIUM | MEDIUM | P2 |
| Public-inbox opt-in mode | LOW | HIGH (abuse surface) | P3 |
| Multi-domain | LOW | HIGH | P3 |
| PWA manifest | LOW | LOW | P3 |
| Inbox export | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add once v1 is stable
- P3: Defer; only ship on clear signal

## Competitor Feature Analysis

| Feature | 10minutemail | mail.tm | temp-mail.org | Mailinator | Our Approach |
|---------|--------------|---------|---------------|------------|--------------|
| Zero-signup inbox | Yes | Yes (but optional API account) | Yes | Yes (public-only) | **Yes, private session** |
| Real-time push | Polling | **SSE (first-class)** | Polling + ads | API polling | **SSE** |
| HTML rendering | Yes (with ads overlaid) | Yes | Yes | Yes | **Yes, sandboxed + remote-image-blocked** |
| Attachments | Yes | Yes | Yes | Paid tier only | **Yes, download-only, size-capped** |
| Custom addresses | No | Yes (post-signup) | Paid | Yes (public namespace) | **No (random only — see anti-features)** |
| Session restore on reload | No (loses inbox) | Yes (requires login) | Cookie | N/A (addresses are deterministic) | **Yes, cookie-based, no account** |
| Timer model | 10 min hard | Rolling / account-based | Reset button | 24 hrs fixed | **Idle-reset + 1 hr hard ceiling** |
| Ads / tracking | Heavy | Light | Very heavy | Light (paid model) | **None** |
| Public API | No | **Yes (loved by devs)** | Paid tier | **Yes (loved by QA)** | **Yes, read-only, rate-limited** |
| Captcha | Sometimes | None on create | Frequent | None | **On rate-limit trip only (ALTCHA)** |
| Multi-domain | Paid | Several | Many (paid tiers) | Paid domains | **Single domain (v1)** |
| Privacy model | Session | Session (account optional) | Session | **Public (anyone can read)** | **Session, private by default** |
| Self-hostable | No | No | No | No (Enterprise: yes, paid) | **Yes (entire value)** |

The dominant niches are: (1) consumer-facing with ads (temp-mail.org, 10minutemail), (2) dev-facing with API (mail.tm, Mailinator), (3) enterprise-paid (Mailinator, mailsac). **Self-hosted + private + no-ads + simple-operator is an unoccupied niche.**

## Abuse & Ops Impact Summary

For the downstream roadmap / abuse-resistance story, these features interact meaningfully with abuse:

| Feature | Abuse Vector | Mitigation Baked In |
|---------|--------------|---------------------|
| Zero-signup inbox | Mass address creation by bots | Per-IP rate limit + optional captcha on trip |
| "New inbox" button | Address churn (botnets cycling IPs) | Same rate limit, shared bucket with creation |
| SSE real-time updates | Connection exhaustion / slowloris | Concurrent-stream cap per IP, idle timeout |
| Attachment download | Bandwidth exhaustion / malware redistribution | Per-file cap, per-inbox cap, Content-Disposition: attachment, restrictive MIME |
| HTML rendering | XSS, tracking pixels, phishing clickthrough | Sanitizer + sandboxed iframe + remote-image block |
| Hard retention ceiling | Storage exhaustion via "keep-alive" bots | Hard cap regardless of activity (1 hr) |
| HTTP API | Automated scraping, massive inbox creation | Strict per-IP rate limits, documented quotas, no auth-free write endpoints |
| No accounts (by design) | Anonymous abuse untraceable | IP rate limits + hashed-IP-with-rotation logs for 7d debugging |

No listed feature is *incompatible* with the abuse-resistance story, but HTML rendering and attachments are the two features where "ship it safely" costs notably more than "ship it." Every other feature's abuse posture collapses to rate-limiting the relevant endpoint.

## Confidence & Gaps

**HIGH confidence:**
- Table-stakes list (cross-verified across 5+ competitors and multiple 2026 comparison articles)
- Anti-feature list against PROJECT.md out-of-scope (direct mapping)
- Real-time pattern choice (SSE) — mail.tm uses it explicitly; SSE vs WS tradeoff is well-documented
- HTML rendering as highest-risk feature (Roundcube CVEs and HackerOne reports are public record)

**MEDIUM confidence:**
- Specific rate-limit thresholds (stated as examples; tune against real traffic in phase review)
- "60% mobile" traffic estimate (industry soft claim, not formally sourced; directionally right)
- Attachment cap at 10 MB / 25 MB (reasonable default; no single authoritative source)

**LOW confidence / gaps:**
- No published user survey on tempmail feature preferences was found; priorities inferred from competitor convergence and reference product behavior
- Public-inbox mode demand is real for developers but unclear whether it's worth the abuse complexity for *this* product
- Deliverability impact of being a new, unknown domain vs. established tempmail domains is empirical — a phase-specific "send a test email from Gmail" validation is the only real test

## Sources

Competitor analysis and feature conventions:
- [Mail.tm API docs (SSE / real-time)](https://docs.mail.tm/)
- [Mailinator FAQ & public-inbox model](https://www.mailinator.com/mailinator-faqs/)
- [10MinuteMail comparison page](https://10minutemail.com/compare)
- [Best Temp Mail 2026 comparison](https://5minmail.com/blog_temp_email_comparison)
- [Best Temporary Email Services 2026 (InstantTempEmail)](https://instanttempemail.com/blog/best-temporary-email-services-2026)
- [Top 10 Disposable Email Services 2026 (CleanTempMail)](https://cleantempmail.com/blog/top-10-best-disposable-email-services-in-2026-speed-privacy-deliverability-test)
- [Session-based vs fixed-timer design discussion](https://tempemailnow.com/blogs/session-based-temporary-email-vs-temp-mail/)

Security & HTML rendering:
- [Roundcube XSS (Sonar)](https://www.sonarsource.com/blog/government-emails-at-risk-critical-cross-site-scripting-vulnerability-in-roundcube-webmail/)
- [XSS in Email Areas (Medium / Friendly)](https://medium.com/@friendly_/xss-at-hubspot-and-xss-in-email-areas-674fa39d5248)
- [Preventing webmail XSS payloads (MDPI)](https://www.mdpi.com/2076-3417/10/13/4425)

Abuse prevention:
- [Combining CAPTCHA and Rate Limits (bugfree.ai)](https://bugfree.ai/knowledge-hub/combining-captcha-and-rate-limits-for-abuse-defense)
- [ALTCHA (privacy-first captcha)](https://altcha.org/)
- [Disposable email domain blocklist (GitHub)](https://github.com/disposable-email-domains/disposable-email-domains)

Real-time delivery patterns:
- [SSE vs WebSocket vs Polling (AlgoMaster)](https://blog.algomaster.io/p/polling-vs-long-polling-vs-sse-vs-websockets-webhooks)
- [Server-Sent Events real-time updates (Talent500)](https://talent500.com/blog/server-sent-events-real-time-updates/)

Self-hosted MTA references (for infra context):
- [mox (modern full-featured self-hosted mail server)](https://github.com/mjl-/mox)
- [Open source email servers roundup (emailr)](https://emailr.dev/en/blog/open-source-email-servers/)
- [Haraka SMTP server (referenced)](https://haraka.github.io/)

---
*Feature research for: public anonymous disposable email (self-hosted, single-VPS, receive-only)*
*Researched: 2026-04-18*
