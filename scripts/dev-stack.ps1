# Starts the local Inklink stack, each service in its own window.
#
#   http://localhost:5173        single entry: landing (/), PWA (/app, /shop, /demo), API (/api)
#   apps/web dev server   5174   (proxied by 5173)
#   backend (FastAPI)     8000   holds the 0G keys (services/backend/.env)
#   print operator        4000   Strands agent; inference brokered by the backend
#   printer adapter       7777
#   document engine       5001
#
# Usage:  .\scripts\dev-stack.ps1                    (0G Private Computer, the default)
#         .\scripts\dev-stack.ps1 -Provider vertex-ai (explicit; refused for sensitive documents)
#
# Service-to-service tokens are generated for this run unless already set in
# the environment or in the services' own .env files. Put the three 0G keys in
# services/backend/.env (see services/backend/.env.example), never in a frontend.
# Prerequisites: npm install at the repo root, in apps/web and services/*;
# Python venvs in services/backend and services/document-engine.
param([ValidateSet('0g-private-computer', 'vertex-ai')][string]$Provider = '0g-private-computer')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function New-Token { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
foreach ($name in 'AGENT_SERVICE_TOKEN', 'PRINTER_AGENT_TOKEN') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { Set-Item "env:$name" (New-Token) }
}
$env:INKLINK_MODEL_PROVIDER = $Provider
$env:BACKEND_URL = 'http://127.0.0.1:8000'
$env:AGENT_URL = 'http://127.0.0.1:4000'
$env:PRINTER_AGENT_URL = 'http://127.0.0.1:7777'
$env:DOCUMENT_ENGINE_URL = 'http://127.0.0.1:5001'

function Start-Service($title, $dir, $cmd) {
  Start-Process powershell -WorkingDirectory (Join-Path $root $dir) -ArgumentList '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$title'; $cmd"
}

Start-Service 'inklink printer adapter' 'services/local-printer-agent' 'node src/index.js'
Start-Service 'inklink document engine' 'services/document-engine' '.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5001'
Start-Service 'inklink print operator' 'services/strands-agent' 'npx tsx src/index.ts'
Start-Service 'inklink backend' 'services/backend' '.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000'
Start-Service 'inklink pwa' 'apps/web' 'npx vite'
Start-Service 'inklink web (landing + proxy)' '.' 'npx vite'

Write-Host ""
Write-Host "Landing page:   http://localhost:5173/"
Write-Host "Customer app:   http://localhost:5173/app"
Write-Host "Shop dashboard: http://localhost:5173/shop   (no token needed on this computer)"
Write-Host "Agent:          http://localhost:5173/shop/agent"
Write-Host "Judge demo:     http://localhost:5173/demo"
Write-Host "Backend API:    http://127.0.0.1:8000/health"
Write-Host "Model provider: $Provider (0G keys are read from services/backend/.env)"
