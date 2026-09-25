# Implementation status — CineForge 0.3 hardening

## Implemented

Portable project schema v2 now runtime-validates/migrates project input. Executable paths and local AI endpoints are machine-only settings under Electron userData, and all AI endpoints are loopback-only. IPC sender validation, navigation/window/webview lockdown, denied Electron permissions, canonical symlink-safe filesystem reads, guarded writes, and a fixed CapCut handoff root are implemented.

The render system now has a serialized single-GPU queue, active-shot duplicate prevention, workflow/reference/runtime fingerprints, optional model fingerprinting, installation-signed job journals, restart reconciliation for Comfy prompt IDs, verified native WanGP PIDs, and deterministic Docker container identities, process-tree/container cancellation, Comfy timeouts, and throttled runtime progress persistence separated from canonical project writes. Unsigned active project jobs are never auto-resumed.

WanGP supports native and Docker execution with explicit host→container path mapping. The pinned native runtime can be bootstrapped from `setup.cmd`, its upstream model catalog drives managed profile provisioning, and binding inference is ambiguity-safe. Profiles require structural validation and are invalidated when the source hash changes. Forced profiles must match shot model/mode. Comfy production requires a dedicated instance. Keyframes can use WanGP or Comfy.

FFprobe/FFmpeg technical QC, NVENC/libx264 master normalization, cache cleanup, validated CapCut handoff, Electron packaging/fuses, and GitHub Actions CI are included.

## Validation policy

GitHub Actions is the source/build gate. AI routes are separately considered validated only after the target workstation has the intended driver/runtime/model and has completed a real render. CineForge records validation and successful-render metadata instead of claiming untested routes work.

ASR, TTS, source separation, interpolation and specialized upscalers remain optional local tools orchestrated by Codex; they are not advertised as built-in typed CineForge adapters yet.
