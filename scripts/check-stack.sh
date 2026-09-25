#!/usr/bin/env bash
set -euo pipefail
COMFY_URL="${CINEFORGE_COMFY_URL:-http://127.0.0.1:8188}"
WANGP_ROOT="${CINEFORGE_WANGP_ROOT:-}"
PYTHON_BIN="${CINEFORGE_PYTHON:-python}"

echo "== GPU =="
if command -v nvidia-smi >/dev/null; then nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader; else echo "nvidia-smi not found"; fi

echo "== FFmpeg =="
if command -v ffmpeg >/dev/null; then ffmpeg -version | head -1; else echo "ffmpeg not found"; fi

echo "== WanGP production =="
if [[ -z "$WANGP_ROOT" ]]; then
  echo "CINEFORGE_WANGP_ROOT not set"
elif [[ ! -f "$WANGP_ROOT/wgp.py" ]]; then
  echo "missing: $WANGP_ROOT/wgp.py"
else
  echo "entrypoint: $WANGP_ROOT/wgp.py"
  "$PYTHON_BIN" --version || true
fi

echo "== ComfyUI lab/fallback =="
if command -v curl >/dev/null; then curl -fsS "$COMFY_URL/system_stats" >/dev/null && echo "reachable: $COMFY_URL" || echo "offline/optional: $COMFY_URL"; else echo "curl not found"; fi

echo "== Cost policy =="
echo "Intended recurring paid services: Codex/ChatGPT + CapCut"
echo "CapCut AI credits: disabled by default in CineForge project settings"
