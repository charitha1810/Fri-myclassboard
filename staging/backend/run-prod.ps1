# Production start for MCB Revenue Intelligence (Windows).
# Usage:  powershell -ExecutionPolicy Bypass -File backend\run-prod.ps1 [-Port 8765] [-Workers 2]
# Put it behind IIS / nginx with HTTPS and company sign-in; run as a service with NSSM or Task Scheduler.
param(
  [int]$Port = 8765,
  [int]$Workers = 2,
  [string]$BindHost = "127.0.0.1"
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".env")) { throw "backend\.env is missing — copy .env.example and fill in the database settings." }

# Fail fast if dependencies are missing.
python -c "import fastapi, uvicorn, sqlalchemy, pyodbc, anthropic, psycopg" 2>$null
if ($LASTEXITCODE -ne 0) { pip install -r requirements.txt }

python -m uvicorn app.main:app `
  --host $BindHost --port $Port `
  --workers $Workers `
  --proxy-headers --forwarded-allow-ips "127.0.0.1" `
  --timeout-keep-alive 30 `
  --log-level info `
  --no-server-header
