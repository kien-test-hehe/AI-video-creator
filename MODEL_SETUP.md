# Model and runtime setup

CineForge 0.3 separates **portable project state** from **machine runtime configuration**.

## Workstation setup

Open **Settings → Machine Settings** and configure WanGP (native or Docker), FFmpeg + FFprobe, optional dedicated ComfyUI, and optional local OpenAI-compatible Director. These values live under Electron's `userData` directory and are never trusted from a project file.

## WanGP production profiles

For every route: validate the preset in WanGP, export its settings JSON, import it, review every binding ambiguity, record a model/checkpoint fingerprint when available, click **Validate profile**, then enable it. Changing the imported settings invalidates the source hash and blocks rendering until revalidation.

Recommended starting routes on 16 GB VRAM are LTX 2.5 Fast I2V/AV for general/audio-aware shots, HunyuanVideo 1.5 I2V for quality-biased hero shots, and Wan 2.2 5B I2V for motion/action fallback. Add long-video routes only after separate validation.

## Reproducibility

A queued render freezes the shot/effective prompt/seed, workflow/settings SHA-256, all attached reference-asset SHA-256 hashes, local runtime fingerprint, and optional model/checkpoint fingerprint. Retry refuses to claim exactness when any of those inputs changed.

## ComfyUI

Use API-format workflows for production. CineForge refuses unsafe UI-graph conversion with connected unknown/subgraph nodes. A production Comfy route requires a dedicated CineForge instance so cancellation/recovery cannot interrupt another queue.

## Technical QC

Video output is inspected with FFprobe/FFmpeg for stream presence, expected duration, expected resolution/FPS, requested audio, black segments, frozen segments, and clipping-risk peaks. A video route that returns no video, or a video that fails technical QC, is not promoted to preferred take.

## CapCut

Build the canonical CineForge cut first. The handoff validates every media path/trim, then writes a manifest and Codex task. CapCut AI credits remain off unless explicitly enabled.
