# Starts the local Inklink stack, each service in its own window.
#
#   printer adapter 7777 · document engine 5001 · print operator 4000 · backend 8000 · web 5174
#
# Usage:  .\scripts\dev-stack.ps1                    (0G Private Computer, the default provider)
#         .\scripts\dev-stack.ps1 -Provider vertex-ai (explicit choice, never a silent fallback)
#
# Service-to-service tokens are generated for this run unless already set in the
# environment. The shop admin token is printed so you can open /shop locally.
# Prerequisites: npm install in services/* and apps/web; Python venvs in
# services/backend and services/document-engine (see each README).
param([ValidateSet('0g-private-computer', 'vertex-ai')][string]$Provider = '0g-private-computer')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function New-Token { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
foreach ($name in 'AGENT_SERVICE_TOKEN', 'PRINTER_AGENT_TOKEN', 'SHOP_ADMIN_TOKEN') {
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
Start-Service 'inklink web' 'apps/web' 'npx vite --port 5174 --strictPort'

Write-Host "Customer app:   http://localhost:5174/"
Write-Host "Shop dashboard: http://localhost:5174/shop"
Write-Host "Shop admin token (this run): $env:SHOP_ADMIN_TOKEN"
Write-Host "Model provider: $Provider"
