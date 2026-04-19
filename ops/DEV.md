# Local development / smoke test

Run the full compose stack on your laptop with no real domain, no real TLS,
and no Let's Encrypt. This is the environment you use to catch config
regressions before they reach production.

## 1. One-time setup

### Hosts file

Point `tempmail.local` at your loopback. On Linux / macOS:

```bash
echo '127.0.0.1 tempmail.local' | sudo tee -a /etc/hosts
```

On Windows: edit `C:\Windows\System32\drivers\etc\hosts` as Administrator and
add the same line.

### Secrets

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
DOMAIN=tempmail.local
PII_LOG_SALT=<openssl rand -hex 32>
COOKIE_SECRET=<openssl rand -hex 32>
TLS_DEV_SELF_SIGNED=true
LETS_ENCRYPT_EMAIL=dev@tempmail.local
```

### Build the web frontend

The compose stack bind-mounts `./web/build` into Caddy. Build it once:

```bash
cd web && npm ci && npm run build && cd ..
```

## 2. Bring the stack up

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

The `--build` is only needed on first run or after backend changes.

## 3. Verify

In another terminal:

```bash
# Healthz via Caddy (self-signed; -k to accept the cert)
curl -kfsS https://tempmail.local/healthz

# Mint an inbox
curl -kfsS -X POST https://tempmail.local/api/inbox
# -> {"id":"...", "address":"abc123@tempmail.local", ...}

# Send a test message via SMTP
swaks --to abc123@tempmail.local --server 127.0.0.1:2525 \
  --from sender@example.com --body "hello from swaks"
```

Open a browser to `https://tempmail.local/` — accept the self-signed warning
and you should see the SPA, a new-inbox button, and the SSE stream delivering
the test message within ~200ms.

## 4. Scripted smoke test

Instead of the manual flow above:

```bash
# Linux / macOS
ops/smoke-test.sh

# Windows PowerShell
ops\smoke-test.ps1
```

These spin the stack up, exercise the key paths, tear down, and exit nonzero
on any failure.

## 5. Teardown

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml down
# Add -v to also delete the persisted data volume:
docker compose -f docker-compose.yml -f docker-compose.local.yml down -v
```

## 6. Developing without the container

For faster iteration you can run the backend directly on the host:

```bash
npm install
# Leave compose Caddy + the web build alone; just run the backend:
DOMAIN=tempmail.local \
  PII_LOG_SALT=$(openssl rand -hex 32) \
  COOKIE_SECRET=$(openssl rand -hex 32) \
  TLS_DEV_SELF_SIGNED=true \
  DATA_DIR=./data \
  SMTP_PORT=2525 \
  HTTP_PORT=8080 \
  HTTP_HOST=127.0.0.1 \
  npm run dev
```

Then run Caddy manually against `ops/Caddyfile.local` with a tweaked upstream
of `127.0.0.1:8080` instead of `app:8080`.

## 7. Troubleshooting

### Browser says "self-signed certificate" and you don't see a proceed button

Some browsers (Firefox default profile) refuse to skip for non-public TLDs.
Either:

- Click through the advanced-warning UI (most chrome-based browsers), or
- Run `curl -k` to probe directly and test the API from a script, or
- Trust Caddy's internal CA once: `docker compose ... exec caddy caddy trust`
  (requires running as root on your host; reads
  `caddy_data/pki/authorities/local/root.crt`).

### `docker compose` complains about orphaned services

```
docker compose -f docker-compose.yml -f docker-compose.local.yml down --remove-orphans
```

### Port 2525 already in use

Another local process holds it. On Linux: `ss -lntp | grep 2525`. Kill the
culprit or edit `docker-compose.local.yml` to use a different host port.
