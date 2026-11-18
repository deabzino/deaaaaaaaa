# Builds the Windows capture app and zips it for a GitHub Release.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\package-capture.ps1
param([string]$Origin = "https://deaaaaaaaa.onrender.com")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "artifacts\among-us-capture"
$stage = Join-Path $root "dist\Dea.Capture-win-x64"
$zip = Join-Path $root "dist\Dea.Capture-win-x64.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }

dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $stage
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

# Players double-click this. It pairs with the server and starts capturing.
$launcher = "@echo off`r`ntitle dea capture`r`n`"%~dp0Dea.Capture.exe`" --connect $Origin`r`npause`r`n"
Set-Content -Path (Join-Path $stage "Start dea capture.bat") -Value $launcher -Encoding ASCII

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Write-Host "`nBuilt $zip"
Write-Host "Publish it with:"
Write-Host "  gh release create capture-v0.1.0 `"$zip`" --title `"dea capture 0.1.0`" --notes `"Windows capture app (beta)`""
