# Safe live endpoint verification script for Project SAHAJ Phase 1 (PowerShell)
# Does not read, log, or leak secrets.
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3000',
  [string]$BypassSecret = ''
)

$ErrorActionPreference = 'Stop'

Write-Host "=========================================================="
Write-Host "Running SAHAJ Phase 1 Live Verification on $BaseUrl"
Write-Host "=========================================================="

$headers = @{}
if ($BypassSecret) {
  $headers['x-vercel-protection-bypass'] = $BypassSecret
}

# 1. Dedicated Liveness probe
Write-Host -NoNewline "Checking GET /api/health/liveness ... "
try {
  $res = Invoke-WebRequest -Uri "$BaseUrl/api/health/liveness" -Headers $headers -Method Get -UseBasicParsing
  $statusCode = [int]$res.StatusCode
  $cacheControl = $res.Headers['Cache-Control']
  $body = $res.Content | ConvertFrom-Json

  if ($statusCode -ne 200) { throw "Expected 200, got $statusCode" }
  if ($cacheControl -notmatch 'no-store') { throw "Expected Cache-Control: no-store, got $cacheControl" }
  if (-not $body.ok) { throw "ok is not true" }
  if ($body.emergency_ready -ne $false) { throw "emergency_ready is not false" }
  Write-Host "PASS (HTTP 200, no-store, emergency_ready=false)"
} catch {
  Write-Host "FAIL: $_"
  exit 1
}

# 2. Query param liveness probe
Write-Host -NoNewline "Checking GET /api/health?probe=liveness ... "
try {
  $res = Invoke-WebRequest -Uri "$BaseUrl/api/health?probe=liveness" -Headers $headers -Method Get -UseBasicParsing
  if ([int]$res.StatusCode -ne 200) { throw "Expected 200, got $([int]$res.StatusCode)" }
  Write-Host "PASS (HTTP 200)"
} catch {
  Write-Host "FAIL: $_"
  exit 1
}

# 3. Readiness probe (GET /api/health)
Write-Host -NoNewline "Checking GET /api/health (Readiness) ... "
$readinessCode = 0
$readinessBody = $null
$readinessHeaders = $null
$rawContent = ''

try {
  $res = Invoke-WebRequest -Uri "$BaseUrl/api/health" -Headers $headers -Method Get -UseBasicParsing
  $readinessCode = [int]$res.StatusCode
  $readinessHeaders = $res.Headers
  $rawContent = $res.Content
  $readinessBody = $res.Content | ConvertFrom-Json
} catch {
  if ($_.Exception.Response) {
    $readinessCode = [int]$_.Exception.Response.StatusCode
    $readinessHeaders = $_.Exception.Response.Headers
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $rawContent = $reader.ReadToEnd()
    $readinessBody = $rawContent | ConvertFrom-Json
  } else {
    Write-Host "FAIL: Connection error: $_"
    exit 1
  }
}

if ($readinessCode -notin @(200, 503)) {
  Write-Host "FAIL: Unexpected status code $readinessCode (expected 200 or 503)"
  exit 1
}

$cache = $readinessHeaders['Cache-Control']
if ($cache -notmatch 'no-store') {
  Write-Host "FAIL: Readiness missing Cache-Control: no-store (got $cache)"
  exit 1
}

if ($readinessBody.emergency_ready -ne $false) {
  Write-Host "FAIL: emergency_ready is not false"
  exit 1
}

if ($readinessBody.care_actions -ne 'disabled') {
  Write-Host "FAIL: care_actions is not disabled"
  exit 1
}

# Sensitive tokens leak check
if ($rawContent -match 'postgres:|postgresql:|eyJhb|password') {
  Write-Host "FAIL: Potential credential leak in response payload!"
  exit 1
}

if ($readinessCode -eq 200) {
  Write-Host "PASS (HTTP 200 Ready: Connected, emergency_ready=false, safe body)"
} else {
  Write-Host "PASS (HTTP 503 Degraded: Safe error reported, emergency_ready=false, safe body)"
}

Write-Host "=========================================================="
Write-Host "Phase 1 Live Endpoint Verification Succeeded!"
Write-Host "=========================================================="
