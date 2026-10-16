# Starts the local Qdrant binary with storage under data/qdrant. Stop with Ctrl+C.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'tools\qdrant\qdrant.exe'
if (-not (Test-Path $exe)) {
  Write-Error 'qdrant.exe not found. Run: npm run qdrant:setup'
  exit 1
}
$dataDir = Join-Path $root 'data\qdrant'
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'storage') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'snapshots') | Out-Null

$env:QDRANT__STORAGE__STORAGE_PATH = Join-Path $dataDir 'storage'
$env:QDRANT__STORAGE__SNAPSHOTS_PATH = Join-Path $dataDir 'snapshots'
$env:QDRANT__SERVICE__HTTP_PORT = if ($env:QDRANT_HTTP_PORT) { $env:QDRANT_HTTP_PORT } else { '6333' }
$env:QDRANT__SERVICE__GRPC_PORT = if ($env:QDRANT_GRPC_PORT) { $env:QDRANT_GRPC_PORT } else { '6334' }
$env:QDRANT__TELEMETRY_DISABLED = 'true'
$staticDir = Join-Path $root 'tools\qdrant\static'
if (Test-Path (Join-Path $staticDir 'index.html')) { $env:QDRANT__SERVICE__STATIC_CONTENT_DIR = $staticDir }

Write-Host "Qdrant REST on http://127.0.0.1:$($env:QDRANT__SERVICE__HTTP_PORT) (storage: $($env:QDRANT__STORAGE__STORAGE_PATH))"
& $exe
