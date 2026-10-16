# Downloads the Qdrant Windows binary (and the optional web dashboard) into tools/qdrant.
# No Docker required. Re-run to upgrade; set QDRANT_VERSION (for example v1.19.2) to pin a release.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $root 'tools\qdrant'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$headers = @{ 'User-Agent' = 'meeting-copilot-setup' }

$version = $env:QDRANT_VERSION
if (-not $version) {
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/qdrant/qdrant/releases/latest' -Headers $headers
  $version = $release.tag_name
}
Write-Host "Qdrant version: $version"

$zip = Join-Path $toolsDir "qdrant-$version-windows.zip"
$url = "https://github.com/qdrant/qdrant/releases/download/$version/qdrant-x86_64-pc-windows-msvc.zip"
if (-not (Test-Path $zip)) {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -Headers $headers
}
Expand-Archive -Path $zip -DestinationPath $toolsDir -Force
$exe = Get-ChildItem -Path $toolsDir -Filter 'qdrant.exe' -Recurse | Select-Object -First 1
if (-not $exe) { throw "qdrant.exe was not found inside $zip" }
if ($exe.DirectoryName -ne $toolsDir) { Copy-Item $exe.FullName (Join-Path $toolsDir 'qdrant.exe') -Force }
Write-Host "Installed $(Join-Path $toolsDir 'qdrant.exe')"

# Optional dashboard (http://127.0.0.1:6333/dashboard). The bare binary does not bundle it.
try {
  $ui = Invoke-RestMethod -Uri 'https://api.github.com/repos/qdrant/qdrant-web-ui/releases/latest' -Headers $headers
  $asset = $ui.assets | Where-Object { $_.name -eq 'dist-qdrant.zip' } | Select-Object -First 1
  if ($asset) {
    $uiZip = Join-Path $toolsDir 'dist-qdrant.zip'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $uiZip -Headers $headers
    $staticDir = Join-Path $toolsDir 'static'
    if (Test-Path $staticDir) { Remove-Item -Recurse -Force $staticDir }
    Expand-Archive -Path $uiZip -DestinationPath $staticDir -Force
    $nested = Get-ChildItem -Path $staticDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'index.html') } | Select-Object -First 1
    if ($nested -and -not (Test-Path (Join-Path $staticDir 'index.html'))) {
      Get-ChildItem $nested.FullName | Move-Item -Destination $staticDir -Force
      Remove-Item -Recurse -Force $nested.FullName
    }
    Write-Host "Dashboard installed to $staticDir"
  }
} catch {
  Write-Warning "Dashboard download skipped: $($_.Exception.Message)"
}

Write-Host 'Done. Start Qdrant with: npm run qdrant'
