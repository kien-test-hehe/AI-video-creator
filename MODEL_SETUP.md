# Model and runtime setup

CineForge 0.4 separates **portable project state** from **machine runtime configuration**.

## Workstation setup

On the primary Windows target, run `setup.cmd`. It prepares the pinned machine-local WanGP runtime, portable Node, FFmpeg/FFprobe, CineForge dependencies, and by default Ollama + `qwen3-vl:4b` for local multimodal QC. Use `powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1 -SkipVisionModel` only if you intentionally want visual/semantic/continuity QC to fall back to Human Review. Machine paths/endpoints still live under Electron's `userData` directory and are never trusted from a project file. Settings remains available for advanced native/Docker overrides, optional dedicated ComfyUI, and an optional loopback OpenAI-compatible Director.

## WanGP production profiles

For the pinned native runtime, CineForge reads WanGP's model catalog directly and auto-provisions/validates managed settings profiles for the available recommended routes. The current managed preference order is LTX-2.5 Distilled NVFP4 for general/audio-aware shots, HunyuanVideo 1.5 I2V for hero shots, Wan 2.2 TI2V 5B for motion-heavy fallback, and Qwen Image 2.1 for keyframes when exposed by the installed catalog.

Manual WanGP settings import remains available for custom models/presets. Any imported or managed settings file is source-hashed; changing it blocks production rendering until revalidation. Record an immutable model/checkpoint fingerprint when available for stronger reproducibility.

Long shots remain on the managed LTX route by default and are warned by preflight; optional FramePack/other long-video routes are only used when explicitly configured and validated.

## Reproducibility

A queued render freezes the shot/effective prompt/seed, workflow/settings SHA-256, all attached reference-asset SHA-256 hashes, local runtime fingerprint, and optional model/checkpoint fingerprint. Retry refuses to claim exactness when any of those inputs changed.

## ComfyUI

Use API-format workflows for production. CineForge refuses unsafe UI-graph conversion with connected unknown/subgraph nodes. A production Comfy route requires a dedicated CineForge instance so cancellation/recovery cannot interrupt another queue.

## Technical QC

Video output is inspected with FFprobe/FFmpeg for stream presence, expected duration, expected resolution/FPS, requested audio, black segments, frozen segments, and clipping-risk peaks. A video route that returns no video, or a video that fails technical QC, is not promoted to preferred take.

## CapCut

Build the canonical CineForge cut first. The handoff validates every media path/trim, then writes a manifest and Codex task. CapCut AI credits remain off unless explicitly enabled.


## Automatic QC runtime

The default local QC endpoint is `http://127.0.0.1:11434/v1` with `qwen3-vl:4b`. CineForge sends only bounded local frame samples to loopback. After a shot QC batch, it requests immediate Ollama unload (`keep_alive: 0`) so the RTX 5060 Ti can reclaim VRAM for the next generation.

A missing/unavailable vision model does not silently PASS anything. CineForge records an uncertain QC result and creates a Human Task. Low-confidence observed-final state likewise requires explicit review.

## Previz

Blender is optional. CineForge probes it and uses a previz advisor to decide none/optional/required. Required shots receive a generated manifest in `.cineforge/previz/`; a human supplies/approves the 3D camera/blocking reference. AUTO RUN waits at that Human Task and resumes after approval.
