$ErrorActionPreference = "Continue"
$ComfyUrl = if ($env:CINEFORGE_COMFY_URL) { $env:CINEFORGE_COMFY_URL } else { "http://127.0.0.1:8188" }
$WanGpRoot = $env:CINEFORGE_WANGP_ROOT
$PythonBin = if ($env:CINEFORGE_PYTHON) { $env:CINEFORGE_PYTHON } else { "python" }

Write-Host "== GPU =="
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader
} else { Write-Host "nvidia-smi not found" }

Write-Host "== FFmpeg =="
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  ffmpeg -version | Select-Object -First 1
} else { Write-Host "ffmpeg not found" }

Write-Host "== WanGP production =="
if (-not $WanGpRoot) {
  Write-Host "CINEFORGE_WANGP_ROOT not set"
} elseif (-not (Test-Path (Join-Path $WanGpRoot "wgp.py"))) {
  Write-Host "missing: $(Join-Path $WanGpRoot 'wgp.py')"
} else {
  Write-Host "entrypoint: $(Join-Path $WanGpRoot 'wgp.py')"
  & $PythonBin --version
}

Write-Host "== ComfyUI lab/fallback =="
try {
  Invoke-RestMethod -Method Get -Uri "$ComfyUrl/system_stats" -TimeoutSec 3 | Out-Null
  Write-Host "reachable: $ComfyUrl"
} catch { Write-Host "offline/optional: $ComfyUrl" }

Write-Host "== Cost policy =="
Write-Host "Intended recurring paid services: Codex/ChatGPT + CapCut"
Write-Host "CapCut AI credits: disabled by default in CineForge project settings"
