param(
  [switch]$SkipWanGP,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $RepoRoot '.runtime'
$NodeVersion = '22.16.0'
$NodeRoot = Join-Path $RuntimeRoot "node-v$NodeVersion-win-x64"
$WanRoot = Join-Path $RuntimeRoot 'Wan2GP'
$WanPin = (Get-Content (Join-Path $RepoRoot 'runtime\WANGP_PIN.txt') -Raw).Trim()
$EnvFile = Join-Path $RuntimeRoot 'cineforge.env.ps1'

function Step([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "Required command not found: $Name" }
  return $cmd.Source
}

function Ensure-Node {
  if (Test-Path (Join-Path $NodeRoot 'node.exe')) { return }
  Step "Installing portable Node.js $NodeVersion into .runtime"
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $fileName = "node-v$NodeVersion-win-x64.zip"
  $zip = Join-Path $RuntimeRoot $fileName
  $url = "https://nodejs.org/dist/v$NodeVersion/$fileName"
  $sumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
  Invoke-WebRequest -Uri $url -OutFile $zip
  $sums = (Invoke-WebRequest -Uri $sumsUrl).Content
  $pattern = '\s+' + [regex]::Escape($fileName) + '$'
  $expectedLine = ($sums -split "`n" | Where-Object { $_ -match $pattern } | Select-Object -First 1)
  if (-not $expectedLine) { throw "Node.js checksum entry not found for $fileName" }
  $expectedHash = ($expectedLine.Trim() -split '\s+')[0].ToLowerInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    throw 'Node.js archive checksum verification failed.'
  }
  Expand-Archive -Path $zip -DestinationPath $RuntimeRoot -Force
  Remove-Item $zip -Force
}

function Find-Python311 {
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($py) {
    try {
      $candidate = (& $py.Source -3.11 -c "import sys; print(sys.executable)" 2>$null | Select-Object -Last 1).Trim()
      if ($candidate -and (Test-Path $candidate)) { return $candidate }
    } catch {}
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Python\pythoncore-3.11-64\python.exe'),
    'C:\Program Files\Python311\python.exe'
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) {
    try {
      $version = (& $python.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
      if ($version -eq '3.11') { return $python.Source }
    } catch {}
  }
  return $null
}

function Ensure-Python311 {
  $python = Find-Python311
  if ($python) { return $python }
  Step 'Installing Python 3.11 for the pinned WanGP runtime'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Python 3.11 is missing and winget is unavailable. Install Python 3.11, then rerun setup.' }
  & $winget.Source install --id Python.Python.3.11 -e --scope user --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw 'winget failed to install Python 3.11.' }
  $python = Find-Python311
  if (-not $python) { throw 'Python 3.11 installation completed but python.exe was not found. Open a new terminal and rerun setup.' }
  return $python
}

function Ensure-FFmpeg {
  $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
  if (Test-Path $wingetLinks) { $env:PATH = "$wingetLinks;$env:PATH" }
  $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  $ffprobe = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
  if ($ffmpeg -and $ffprobe) { return @($ffmpeg.Source, $ffprobe.Source) }
  Step 'Installing FFmpeg/FFprobe'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'FFmpeg is missing and winget is unavailable. Install FFmpeg + FFprobe and rerun setup.' }
  & $winget.Source install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) {
    & $winget.Source install --id Gyan.FFmpeg.Essentials -e --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw 'winget failed to install FFmpeg.' }
  }
  if (Test-Path $wingetLinks) { $env:PATH = "$wingetLinks;$env:PATH" }
  $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  $ffprobe = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
  if (-not $ffmpeg -or -not $ffprobe) { throw 'FFmpeg was installed but this terminal cannot resolve ffmpeg/ffprobe. Open a new terminal and rerun setup.' }
  return @($ffmpeg.Source, $ffprobe.Source)
}

function Assert-Nvidia {
  Step 'Checking NVIDIA GPU and driver'
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if (-not $smi) { throw 'nvidia-smi is missing. Install the NVIDIA driver for the RTX 5060 Ti, reboot if required, then rerun setup.' }
  $gpu = (& $smi.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits | Select-Object -First 1).Trim()
  if (-not $gpu) { throw 'nvidia-smi returned no GPU information.' }
  Write-Host "Detected: $gpu"
  if ($gpu -notmatch 'RTX\s*5060\s*Ti') {
    Write-Warning 'The bootstrap is tuned for RTX 5060 Ti 16 GB, but CineForge will adapt to the detected NVIDIA GPU.'
  }
}

function Ensure-WanGP([string]$BootstrapPython) {
  if ($SkipWanGP) { return $BootstrapPython }
  Step "Installing pinned WanGP runtime ($WanPin)"
  $git = Require-Command 'git.exe'
  if (-not (Test-Path (Join-Path $WanRoot '.git'))) {
    & $git clone https://github.com/deepbeepmeep/Wan2GP.git $WanRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to clone WanGP.' }
  } else {
    $origin = (& $git -C $WanRoot remote get-url origin).Trim()
    if ($origin -notmatch '^(https://github\.com/|git@github\.com:)deepbeepmeep/Wan2GP(?:\.git)?$') {
      throw "Refusing to update unexpected WanGP remote: $origin"
    }
  }
  Push-Location $WanRoot
  try {
    & $git fetch --all --tags --prune
    if ($LASTEXITCODE -ne 0) { throw 'Failed to fetch the pinned WanGP repository.' }
    & $git checkout --detach $WanPin
    if ($LASTEXITCODE -ne 0) { throw "Failed to checkout pinned WanGP commit $WanPin" }
    $actualPin = (& $git rev-parse HEAD).Trim()
    if ($actualPin -ne $WanPin) { throw "WanGP checkout mismatch: expected $WanPin, got $actualPin" }
    & $BootstrapPython setup.py install --env venv --auto
    if ($LASTEXITCODE -ne 0) { throw 'WanGP automatic installer failed.' }
    $infoMatch = (& $BootstrapPython setup.py get_env_info 2>&1 | Select-String 'ENV_INFO\|' | Select-Object -Last 1)
    if (-not $infoMatch) { throw 'WanGP installed but its active environment path could not be discovered.' }
    $info = $infoMatch.ToString()
    if ($info -notmatch 'ENV_INFO\|[^|]+\|(.+)$') { throw 'WanGP installed but its active environment path could not be parsed.' }
    $envPath = $Matches[1].Trim()
    $envPython = Join-Path $envPath 'Scripts\python.exe'
    if (-not (Test-Path $envPython)) { throw "WanGP environment Python not found: $envPython" }
    return $envPython
  } finally {
    Pop-Location
  }
}

Step 'Creating CineForge machine runtime'
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
Ensure-Node
Assert-Nvidia
$python = Ensure-Python311
$ff = Ensure-FFmpeg
$wanPython = Ensure-WanGP $python
$ffmpegPath = $ff[0]
$ffprobePath = $ff[1]

Step 'Writing machine-local CineForge environment'
$escapedWan = $WanRoot.Replace("'", "''")
$escapedPy = $wanPython.Replace("'", "''")
$escapedFfmpeg = $ffmpegPath.Replace("'", "''")
$escapedFfprobe = $ffprobePath.Replace("'", "''")
@(
  ('$env:CINEFORGE_WANGP_ROOT = ''{0}''' -f $escapedWan),
  ('$env:CINEFORGE_PYTHON = ''{0}''' -f $escapedPy),
  ('$env:CINEFORGE_FFMPEG = ''{0}''' -f $escapedFfmpeg),
  ('$env:CINEFORGE_FFPROBE = ''{0}''' -f $escapedFfprobe),
  '$env:CINEFORGE_COMFY_URL = ''http://127.0.0.1:8188''',
  '$env:CINEFORGE_DIRECTOR_URL = ''http://127.0.0.1:11434/v1'''
) | Set-Content -Encoding UTF8 $EnvFile

Step 'Installing CineForge dependencies'
$npm = Join-Path $NodeRoot 'npm.cmd'
if (Test-Path (Join-Path $RepoRoot 'package-lock.json')) {
  & $npm ci --prefix $RepoRoot
} else {
  & $npm install --prefix $RepoRoot
}
if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed.' }

if (-not $SkipBuild) {
  Step 'Validating CineForge source'
  & $npm run typecheck --prefix $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw 'TypeScript validation failed.' }
  & $npm run lint --prefix $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw 'ESLint validation failed.' }
  & $npm test --prefix $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }
  & $npm run test:smoke --prefix $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw 'Core smoke test failed.' }
  & $npm run build --prefix $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw 'Electron/Vite build failed.' }
}

Write-Host ''
Write-Host 'CineForge workstation setup is ready.' -ForegroundColor Green
Write-Host 'Run: start.cmd'
Write-Host 'CapCut Pro is NOT assumed. New projects default to CapCut Free / No Pro.'
Write-Host 'WanGP model weights download on demand on the first generation for each chosen model.'
