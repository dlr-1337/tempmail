# ============================================================================
# tempmail local smoke test (Windows PowerShell).
#
# Equivalent to ops/smoke-test.sh — brings compose up with the local override,
# probes healthz, mints an inbox, then tears down. Delivery via swaks is
# opt-in (most Windows devs don't have it installed).
#
# Usage:
#   pwsh ops/smoke-test.ps1
#
# Prereqs:
#   - Docker Desktop running
#   - docker compose v2
#   - .env filled
#   - web/build/ present
# ============================================================================

$ErrorActionPreference = 'Stop'

$Compose = @('compose','-f','docker-compose.yml','-f','docker-compose.local.yml')
$BaseUrl = 'https://tempmail.local'
$TimeoutSecs = 60

function Log($msg)  { Write-Host "[smoke] $msg"    -ForegroundColor Cyan  }
function Ok($msg)   { Write-Host "[smoke OK] $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[smoke FAIL] $msg" -ForegroundColor Red; exit 1 }

# Bypass self-signed cert validation for the local internal CA.
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

try {
  if (-not (Test-Path .env))        { Fail ".env missing — see ops/DEV.md" }
  if (-not (Test-Path web/build))   { Fail "web/build/ missing — run 'cd web; npm ci; npm run build'" }

  Log "starting stack"
  & docker @Compose up -d --build | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "docker compose up failed" }

  Log "waiting for healthz (timeout $TimeoutSecs s)"
  $deadline = (Get-Date).AddSeconds($TimeoutSecs)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "$BaseUrl/healthz" -TimeoutSec 3 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) {
    & docker @Compose logs --tail=50 | Out-Host
    Fail "healthz never came up"
  }
  Ok "healthz responding"

  Log "mint an inbox"
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $mint = Invoke-RestMethod -Uri "$BaseUrl/api/inbox" -Method Post -WebSession $session
  if (-not $mint.id) { Fail "inbox mint returned no id" }
  Ok "inbox minted: $($mint.address) (id=$($mint.id))"

  Log "fetch inbox metadata"
  $meta = Invoke-RestMethod -Uri "$BaseUrl/api/inbox/$($mint.id)" -WebSession $session
  if ($meta.id -ne $mint.id) { Fail "metadata id mismatch" }
  Ok "metadata round-trip OK"

  Ok "smoke test passed (SMTP delivery skipped — run swaks manually to cover)"
}
finally {
  Log "tearing down stack"
  & docker @Compose down --remove-orphans 2>&1 | Out-Null
}
