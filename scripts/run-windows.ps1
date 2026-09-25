$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $RepoRoot '.runtime'
$NodeRoot = Join-Path $RuntimeRoot 'node-v22.16.0-win-x64'
$EnvFile = Join-Path $RuntimeRoot 'cineforge.env.ps1'
$Setup = Join-Path $PSScriptRoot 'setup-windows.ps1'

if (-not (Test-Path $EnvFile) -or -not (Test-Path (Join-Path $NodeRoot 'npm.cmd'))) {
  Write-Host 'CineForge runtime is not bootstrapped yet. Running setup first...' -ForegroundColor Yellow
  & $Setup
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

. $EnvFile
$wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
if (Test-Path $wingetLinks) { $env:PATH = "$NodeRoot;$wingetLinks;$env:PATH" } else { $env:PATH = "$NodeRoot;$env:PATH" }

$npm = Join-Path $NodeRoot 'npm.cmd'
Push-Location $RepoRoot
try {
  & $npm run dev
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
