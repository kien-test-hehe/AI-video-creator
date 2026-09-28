# Implementation status — CineForge state-centric production core

## Implemented

Portable project schema v3 now runtime-validates/migrates project input and carries structured shot state, continuity dependencies, QC history, human-review tasks, canonical-take provenance and cut revisions. Executable paths and local AI endpoints are machine-only settings under Electron userData, and all AI endpoints are loopback-only. IPC sender validation, navigation/window/webview lockdown, denied Electron permissions, canonical symlink-safe filesystem reads, guarded writes, and a fixed CapCut handoff root are implemented.

The render system now has a serialized single-GPU queue, active-shot duplicate prevention, workflow/reference/runtime fingerprints, optional model fingerprinting, installation-signed job journals, restart reconciliation for Comfy prompt IDs, verified native WanGP PIDs, and deterministic Docker container identities, process-tree/container cancellation, Comfy timeouts, and throttled runtime progress persistence separated from canonical project writes. Unsigned active project jobs are never auto-resumed.

WanGP supports native and Docker execution with explicit host→container path mapping. The pinned native runtime can be bootstrapped from `setup.cmd`, its upstream model catalog drives managed profile provisioning, and binding inference is ambiguity-safe. Profiles require structural validation and are invalidated when the source hash changes. Forced profiles must match shot model/mode. Comfy production requires a dedicated instance. Keyframes can use WanGP or Comfy.


The renderer now includes a unified Studio workspace with a searchable draggable asset library, in-place asset editing, a pan/zoom node-style production graph, inspect-in-place panels for every production node, truthful validated workflow routing, a complete shot inspector, minimap, System/Preflight node, hardware/runtime HUD, direct queue controls, rendered-take → timeline drag/drop, and a draggable canonical timeline dock. Characters, locations, generic visual references, props/wardrobe, temporal keyframes, motion video and input audio are represented as distinct shot roles. Detailed task-specific views remain available rather than being replaced by the graph. Canvas node positions are presentation-only and are kept separate from screenplay/shot/timeline ordering.

FFprobe/FFmpeg technical QC, production-input fingerprints, stale-QC rejection, state/topology invalidation, canonical-take gating, NVENC/libx264 master normalization, cache cleanup, validated CapCut handoff, Electron packaging/fuses, and GitHub Actions CI are included.

The autonomous runtime now processes shots sequentially through preflight, previz gating, render, layered QC, stable-final-frame selection, observed-final state extraction, continuity propagation, canonical selection, bounded retry, Human Review and canonical timeline rebuild. The run has pause/resume/stop ownership, a durable recovery journal, live RAM/VRAM/disk admission checks, and a Studio control surface that exposes current phase, shot, retries, blockers, actual state, QC and dependency edges.

Windows setup can bootstrap Ollama + qwen3-vl:4b for local automatic visual/semantic/continuity QC. If local vision is unavailable or uncertain, the runtime fails safely into Human Review. The QC model is unloaded after each shot's QC batch to return VRAM to generation. Blender is detected and spatially complex shots receive an automatic previz requirement/manifest; creation of the actual 3D reference remains deliberately human-owned.

## Validation policy

GitHub Actions is the source/build gate. AI routes are separately considered validated only after the target workstation has the intended driver/runtime/model and has completed a real render. CineForge records validation and successful-render metadata instead of claiming untested routes work.

ASR, TTS, source separation, interpolation and specialized upscalers remain optional local tools orchestrated by Codex; they are not advertised as built-in typed CineForge adapters yet.


## Remaining optional / advanced adapters

The core autonomous film loop is implemented. Human-created Blender geometry/previz remains intentional rather than synthetic automation. Specialized ASR, TTS, source separation, interpolation/upscale and deep NLE/audio-post adapters are optional roadmap integrations; the canonical film pipeline does not claim those tools are built in.

Physical performance qualification still has to happen on the actual target workstation because GitHub CI has no RTX 5060 Ti. CineForge therefore reports live readiness and records successful local workflow renders rather than treating CI as GPU validation.
