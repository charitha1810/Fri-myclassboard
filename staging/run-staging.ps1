# Starts the STAGING copy on this machine only. It is not an IIS site and has no public binding.
# Usage:  powershell -ExecutionPolicy Bypass -File staging\run-staging.ps1 [-Port 8766]
# Then open http://localhost:8766 on the server. Ctrl+C stops it.
# Staging has its own backend\.env: portal database "mcb_portal_staging" and its own session secret.
param(
  [int]$Port = 8766
)
$ErrorActionPreference = "Stop"
Set-Location -Path (Join-Path $PSScriptRoot "backend")

if (-not (Test-Path ".env")) { throw "staging\backend\.env is missing." }

# Same overrides the live web.config applies, except the cookie: staging is plain http on localhost.
$env:MCB_DB_DRIVER = "ODBC Driver 17 for SQL Server"
$env:MCB_COOKIE_SECURE = "false"

& ".\.venv\Scripts\python.exe" -m uvicorn app.localtest:app `
  --host 127.0.0.1 --port $Port `
  --workers 1 `
  --timeout-keep-alive 30 `
  --log-level info `
  --no-server-header
