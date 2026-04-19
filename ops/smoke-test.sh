#!/usr/bin/env bash
# =============================================================================
# tempmail local smoke test (Phase 8, D-21).
#
# Brings the compose stack up with the .local override, exercises the core
# paths (healthz, inbox mint, SMTP ingest, messages list), then tears down.
# Exits nonzero on any failure.
#
# Prerequisites:
#   - Docker Desktop / daemon running
#   - docker compose v2
#   - .env filled (see ops/DEV.md)
#   - web/build/ present (`cd web && npm ci && npm run build`)
#   - `curl` and `jq` on PATH
#   - Optional: `swaks` for SMTP delivery test
# =============================================================================

set -euo pipefail

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.local.yml"
BASE_URL="https://tempmail.local"
SMTP_HOST="127.0.0.1"
SMTP_PORT="2525"
TIMEOUT_SECS=60

log()  { printf '\033[1;34m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[smoke FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[smoke OK]\033[0m %s\n' "$*"; }

cleanup() {
  log "tearing down stack"
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null || fail "docker not on PATH"
command -v curl   >/dev/null || fail "curl not on PATH"
command -v jq     >/dev/null || fail "jq not on PATH"

if [ ! -f .env ]; then
  fail ".env missing — copy .env.example and fill secrets (see ops/DEV.md)"
fi
if [ ! -d web/build ]; then
  fail "web/build/ missing — run 'cd web && npm ci && npm run build' first"
fi

log "starting stack"
$COMPOSE up -d --build

log "waiting for healthz (timeout ${TIMEOUT_SECS}s)"
deadline=$(( $(date +%s) + TIMEOUT_SECS ))
while : ; do
  if curl -kfsS -m 3 "$BASE_URL/healthz" >/dev/null 2>&1 ; then
    ok "healthz responding"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    $COMPOSE logs --tail=50
    fail "healthz never came up within ${TIMEOUT_SECS}s"
  fi
  sleep 2
done

log "mint an inbox"
jar=$(mktemp)
mint=$(curl -kfsS -X POST -c "$jar" "$BASE_URL/api/inbox")
id=$(echo "$mint" | jq -r '.id')
address=$(echo "$mint" | jq -r '.address')
[ -n "$id" ] && [ "$id" != "null" ] || fail "inbox mint did not return id; body: $mint"
ok "inbox minted: $address (id=$id)"

if command -v swaks >/dev/null; then
  log "delivering test mail via swaks"
  swaks --quiet --to "$address" --server "${SMTP_HOST}:${SMTP_PORT}" \
        --from "sender@example.com" --body "smoke test" \
    || fail "swaks delivery failed"
  ok "swaks delivered"

  log "polling messages list"
  deadline=$(( $(date +%s) + 10 ))
  while : ; do
    msgs=$(curl -kfsS -b "$jar" "$BASE_URL/api/inbox/$id/messages")
    count=$(echo "$msgs" | jq '.items | length' 2>/dev/null || echo 0)
    if [ "$count" -ge 1 ]; then
      ok "message visible in inbox (count=$count)"
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "message never appeared in list; body: $msgs"
    fi
    sleep 1
  done
else
  log "swaks not installed — skipping SMTP delivery test"
fi

ok "smoke test passed"
