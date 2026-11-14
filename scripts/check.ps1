param([string]$BaseUrl = 'http://localhost:3000')

$ErrorActionPreference = 'Stop'
$probeBaseUrl = $BaseUrl.TrimEnd('/')
Write-Host "Checking Sahaj API liveness at $probeBaseUrl ..."
$health = Invoke-RestMethod -Uri ($probeBaseUrl + '/api/health?probe=liveness') -Method Get
if (-not $health.ok -or $health.emergency_ready) { throw 'Unexpected health response' }
Write-Host 'PASS: API process is running (emergency features not ready)'

foreach ($route in @('/api/sarvam/tool/ping', '/api/cron/tick')) {
  try {
    Invoke-WebRequest -Uri ($probeBaseUrl + $route) -Method Post -UseBasicParsing | Out-Null
    throw "FAIL: $route accepted a request with no secret"
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    if ($status -notin @(401,503)) { throw "FAIL: $route status $status" }
    Write-Host "PASS: $route blocks missing credentials ($status)"
  }
}
Write-Host 'Liveness and unauthenticated-route checks passed. Verify database readiness separately.'
