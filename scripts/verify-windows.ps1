param(
  [switch]$Deep
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $RepoRoot '.runtime'
$NodeVersion = '22.16.0'
$NpmVersion = '10.9.9'
$NodeRoot = Join-Path $RuntimeRoot "node-v$NodeVersion-win-x64"
$EnvFile = Join-Path $RuntimeRoot 'cineforge.env.ps1'
$WanPin = (Get-Content (Join-Path $RepoRoot 'runtime\WANGP_PIN.txt') -Raw).Trim()
$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Pass([string]$Message) { Write-Host "[PASS] $Message" -ForegroundColor Green }
function Warn([string]$Message) { $warnings.Add($Message); Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { $failures.Add($Message); Write-Host "[FAIL] $Message" -ForegroundColor Red }

Write-Host ''
Write-Host 'CineForge Windows workstation verification' -ForegroundColor Cyan
Write-Host "Repository: $RepoRoot"

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) {
  try {
    $head = (& $git.Source -C $RepoRoot rev-parse --short HEAD).Trim()
    Pass "Git repository detected at commit $head."
  } catch { Fail "Git is installed but the repository state could not be read: $($_.Exception.Message)" }
} else {
  Fail 'git.exe is missing. Clone/update workflows and WanGP pin verification require Git.'
}

$smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if (-not $smi) {
  Fail 'nvidia-smi.exe is missing. Install the NVIDIA driver and reboot before local generation.'
} else {
  try {
    $gpuLine = (& $smi.Source --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits | Select-Object -First 1).Trim()
    $parts = $gpuLine.Split(',') | ForEach-Object { $_.Trim() }
    if ($parts.Count -lt 4) { throw "Unexpected nvidia-smi output: $gpuLine" }
    $totalMb = [double]$parts[1]
    $freeMb = [double]$parts[2]
    Pass ("NVIDIA GPU: {0}, {1:N1} GB VRAM total, {2:N1} GB free, driver {3}." -f $parts[0],($totalMb/1024),($freeMb/1024),$parts[3])
    if ($totalMb -lt 15000) { Warn 'GPU has less than the intended ~16 GB VRAM production envelope.' }
    if ($freeMb -lt 8192) { Warn 'Less than 8 GB VRAM is currently free. Close GPU-heavy applications before qualification renders.' }
  } catch { Fail "NVIDIA GPU probe failed: $($_.Exception.Message)" }
}

$node = Join-Path $NodeRoot 'node.exe'
$npm = Join-Path $NodeRoot 'npm.cmd'
if (-not (Test-Path $node)) {
  Fail "Portable Node.js is missing at $node. Run setup.cmd."
} else {
  try {
    $nodeReported = (& $node --version).Trim().TrimStart('v')
    if ($nodeReported -eq $NodeVersion) { Pass "Portable Node.js $nodeReported is pinned correctly." }
    else { Fail "Portable Node.js version mismatch: expected $NodeVersion, got $nodeReported." }
  } catch { Fail "Portable Node.js could not run: $($_.Exception.Message)" }
}
if (-not (Test-Path $npm)) {
  Fail "Portable npm is missing at $npm. Run setup.cmd."
} else {
  try {
    $npmReported = (& $npm --version).Trim()
    if ($npmReported -eq $NpmVersion) { Pass "Portable npm $npmReported is pinned correctly." }
    else { Fail "Portable npm version mismatch: expected $NpmVersion, got $npmReported. Rerun setup.cmd." }
  } catch { Fail "Portable npm could not run: $($_.Exception.Message)" }
}

if (-not (Test-Path $EnvFile)) {
  Fail "Machine environment file is missing: $EnvFile. Run setup.cmd."
} else {
  try {
    . $EnvFile
    Pass 'Machine-local CineForge environment loaded.'
  } catch { Fail "Machine environment file could not be loaded: $($_.Exception.Message)" }
}

foreach ($tool in @(
  @{ Name='FFmpeg'; Path=$env:CINEFORGE_FFMPEG },
  @{ Name='FFprobe'; Path=$env:CINEFORGE_FFPROBE }
)) {
  if (-not $tool.Path -or -not (Test-Path $tool.Path)) {
    Fail "$($tool.Name) path is missing or invalid. Rerun setup.cmd."
    continue
  }
  try {
    & $tool.Path -version 2>$null | Select-Object -First 1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$($tool.Name) exited with code $LASTEXITCODE" }
    Pass "$($tool.Name) is executable at $($tool.Path)."
  } catch { Fail "$($tool.Name) check failed: $($_.Exception.Message)" }
}

if (-not $env:CINEFORGE_WANGP_ROOT) {
  Warn 'WanGP is not configured in the generated environment. If this was intentional (-SkipWanGP), production requires a configured local ComfyUI or later WanGP setup.'
} else {
  $entry = Join-Path $env:CINEFORGE_WANGP_ROOT 'wgp.py'
  if (-not (Test-Path $entry)) {
    Fail "WanGP entrypoint is missing: $entry"
  } else {
    Pass "WanGP entrypoint found at $entry."
  }

  if ($git -and (Test-Path (Join-Path $env:CINEFORGE_WANGP_ROOT '.git'))) {
    try {
      $actualPin = (& $git.Source -C $env:CINEFORGE_WANGP_ROOT rev-parse HEAD).Trim()
      if ($actualPin -eq $WanPin) { Pass "WanGP source matches pinned commit $WanPin." }
      else { Fail "WanGP source pin mismatch: expected $WanPin, got $actualPin." }
      & $git.Source -C $env:CINEFORGE_WANGP_ROOT diff --quiet HEAD --
      if ($LASTEXITCODE -eq 0) { Pass 'WanGP tracked source is clean.' } else { Fail 'WanGP tracked source differs from the pinned commit.' }
    } catch { Fail "WanGP Git verification failed: $($_.Exception.Message)" }
  } else {
    Fail 'WanGP Git checkout is missing, so the pinned runtime cannot be verified.'
  }

  if (-not $env:CINEFORGE_PYTHON -or -not (Test-Path $env:CINEFORGE_PYTHON)) {
    Fail 'WanGP Python path is missing or invalid.'
  } else {
    try {
      $probe = (& $env:CINEFORGE_PYTHON -c "import json,sys,torch; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.version.cuda,'cuda_available':torch.cuda.is_available()}))" | Select-Object -Last 1) | ConvertFrom-Json
      if ($probe.cuda_available -ne $true) { Fail "WanGP Python can import torch $($probe.torch), but torch.cuda.is_available() is false." }
      else { Pass "WanGP Python $($probe.python), torch $($probe.torch), CUDA $($probe.cuda) reports GPU access." }
    } catch { Fail "WanGP Python/PyTorch probe failed: $($_.Exception.Message)" }
  }
}

if ($env:CINEFORGE_DIRECTOR_MODEL) {
  $ollama = Get-Command ollama.exe -ErrorAction SilentlyContinue
  $ollamaPath = if ($ollama) { $ollama.Source } else { $null }
  if (-not $ollamaPath) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $candidate) { $ollamaPath = $candidate }
  }
  if (-not $ollamaPath) {
    Fail "Local QC model '$env:CINEFORGE_DIRECTOR_MODEL' is configured but ollama.exe is missing."
  } else {
    try {
      $modelList = & $ollamaPath list 2>$null
      if (($modelList -join [Environment]::NewLine) -match [regex]::Escape($env:CINEFORGE_DIRECTOR_MODEL)) { Pass "Ollama model $env:CINEFORGE_DIRECTOR_MODEL is installed." }
      else { Fail "Ollama is installed but model $env:CINEFORGE_DIRECTOR_MODEL is not listed. Rerun setup.cmd." }
    } catch { Warn "Ollama is installed but model listing failed. start.cmd will attempt to start the local service: $($_.Exception.Message)" }
  }
} else {
  Warn 'No automatic local VLM/QC model is configured; CineForge will use Human Review gates.'
}

$electronPackage = Join-Path $RepoRoot 'node_modules\electron\package.json'
if (Test-Path $electronPackage) { Pass 'CineForge npm dependencies are installed.' }
else { Fail 'CineForge npm dependencies are missing. Rerun setup.cmd.' }

$builtMain = Join-Path $RepoRoot 'out\main\index.js'
if (Test-Path $builtMain) { Pass 'Built Electron main process is present.' }
else { Warn 'Built Electron output is missing. start.cmd will rebuild before launch.' }

try {
  $drive = (Get-Item $RepoRoot).PSDrive
  if ($drive -and $drive.Free -ne $null) {
    $freeGb = [double]$drive.Free / 1GB
    if ($freeGb -lt 40) { Warn ("Repository drive has only {0:N1} GB free. Model downloads and renders may need substantially more." -f $freeGb) }
    else { Pass ("Repository drive has {0:N1} GB free." -f $freeGb) }
  }
} catch { Warn "Disk-space probe failed: $($_.Exception.Message)" }

$capcutCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'CapCut\Apps\CapCut.exe'),
  (Join-Path $env:LOCALAPPDATA 'CapCut\CapCut.exe'),
  (Join-Path $env:ProgramFiles 'CapCut\CapCut.exe')
) | Where-Object { $_ -and (Test-Path $_) }
if ($capcutCandidates.Count -gt 0) { Pass "CapCut detected at $($capcutCandidates[0])." }
else { Warn 'CapCut was not detected in common locations. CineForge can still render/export locally; finishing handoff needs CapCut installed.' }

if ($Deep -and $npm -and (Test-Path $npm)) {
  Write-Host ''
  Write-Host 'Running deep source validation...' -ForegroundColor Cyan
  Push-Location $RepoRoot
  try {
    foreach ($check in @(
      @{ Label='Typecheck'; Args=@('run','typecheck') },
      @{ Label='Lint'; Args=@('run','lint') },
      @{ Label='Unit tests'; Args=@('test') },
      @{ Label='Core smoke'; Args=@('run','test:smoke') }
    )) {
      & $npm @($check.Args)
      if ($LASTEXITCODE -eq 0) { Pass "$($check.Label) passed." } else { Fail "$($check.Label) failed with exit code $LASTEXITCODE." }
    }
    if ($env:CINEFORGE_PYTHON -and (Test-Path $env:CINEFORGE_PYTHON)) {
      & $env:CINEFORGE_PYTHON (Join-Path $RepoRoot 'tests\wangp_bridge_test.py')
      if ($LASTEXITCODE -eq 0) { Pass 'WanGP bridge tests passed.' } else { Fail "WanGP bridge tests failed with exit code $LASTEXITCODE." }
    }
  } finally {
    Pop-Location
  }
}

Write-Host ''
if ($warnings.Count -gt 0) {
  Write-Host ("Warnings: {0}" -f $warnings.Count) -ForegroundColor Yellow
  foreach ($warning in $warnings) { Write-Host "  - $warning" -ForegroundColor Yellow }
}
if ($failures.Count -gt 0) {
  Write-Host ("Verification FAILED with {0} blocking issue(s)." -f $failures.Count) -ForegroundColor Red
  foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
  exit 1
}

Write-Host 'Verification PASSED. The machine bootstrap is ready for CineForge Preflight and a short real qualification render.' -ForegroundColor Green
exit 0
