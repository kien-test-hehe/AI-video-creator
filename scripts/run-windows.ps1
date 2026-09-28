$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $RepoRoot '.runtime'
$NodeRoot = Join-Path $RuntimeRoot 'node-v22.16.0-win-x64'
$EnvFile = Join-Path $RuntimeRoot 'cineforge.env.ps1'
$Setup = Join-Path $PSScriptRoot 'setup-windows.ps1'
$BuildStamp = Join-Path $RuntimeRoot 'build-commit.txt'
$LockStamp = Join-Path $RuntimeRoot 'package-lock.sha256'

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
  $lockPath = Join-Path $RepoRoot 'package-lock.json'
  $currentLock = if (Test-Path $lockPath) { (Get-FileHash -Algorithm SHA256 $lockPath).Hash } else { '' }
  $savedLock = if (Test-Path $LockStamp) { (Get-Content $LockStamp -Raw).Trim() } else { '' }
  $depsMissing = -not (Test-Path (Join-Path $RepoRoot 'node_modules\electron\package.json'))
  if ($depsMissing -or $currentLock -ne $savedLock) {
    Write-Host 'Dependencies changed or are missing; restoring exactly from package-lock.json...' -ForegroundColor Yellow
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    if ($currentLock) { $currentLock | Set-Content -Encoding ASCII $LockStamp }
  }

  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  $currentCommit = if ($git) { (& $git.Source -C $RepoRoot rev-parse HEAD).Trim() } else { '' }
  $workingTreeDirty = $false
  if ($git) {
    $dirtyLines = @(& $git.Source -C $RepoRoot status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the CineForge working tree before launch.' }
    $workingTreeDirty = $dirtyLines.Count -gt 0
  }
  $builtCommit = if (Test-Path $BuildStamp) { (Get-Content $BuildStamp -Raw).Trim() } else { '' }
  $buildMissing = -not (Test-Path (Join-Path $RepoRoot 'out\main\index.js'))
  if ($buildMissing -or $workingTreeDirty -or -not $currentCommit -or $currentCommit -ne $builtCommit -or $currentLock -ne $savedLock) {
    Write-Host 'Source changed or built output is missing; rebuilding CineForge...' -ForegroundColor Yellow
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'CineForge build failed.' }
    if ($currentCommit) { $currentCommit | Set-Content -Encoding ASCII $BuildStamp }
  }

  & $npm run preview
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
