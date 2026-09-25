# Implementation status — CineForge Local 0.2

## Implemented

- Electron + React + TypeScript desktop application.
- Project creation/open/save, autosave and backup recovery.
- Story parser, scenes, assets, storyboard and shot workshop.
- Character/location/prop/reference continuity attachments.
- Local OpenAI-compatible Director and continuity review with loopback guard.
- WanGP exported-settings inspector, JSON-path binding engine and headless runner.
- ComfyUI API workflow adapter retained for lab/fallback use.
- Model/shot routing across LTX 2.5 Fast, HunyuanVideo 1.5, Wan 2.2 5B and optional long-shot profile.
- Single-GPU render queue, batch queue, cancellation and retry.
- Immutable queued job snapshots including seed/config/effective prompt/profile.
- SHA-256 workflow/settings verification before retry.
- Take history/preferred take behavior and canonical CineForge timeline.
- FFmpeg master export.
- Preflight checks for GPU/VRAM, FFmpeg, required runtime, paths, stale assets, bindings and shot validity.
- Local-only networking policy and explicit Codex + CapCut cost guardrail.
- CapCut × Codex handoff manifest/task generator.
- Dedicated CapCut finishing screen.
- Codex repository skills for producer orchestration and CapCut finishing.
- Path traversal/symlink protections for project media.

## Default cost behavior

```text
Codex / ChatGPT      recurring paid service
CapCut Free/Pro      optional recurring paid service
CapCut AI credits    OFF
WanGP                local
ComfyUI              local
FFmpeg               local
Director LLM         loopback/local
other media AI       expected local / optional
```

No Gemini, Groq or OpenRouter service is required by the core application.

## Validation included in the repository

- TypeScript/TSX syntax sweep.
- Core smoke test.
- Vitest unit tests for parser, workflow conversion/binding, path safety, local-only URL checks, routing, reference bindings and WanGP settings inference.

## Requires validation on the target workstation

- installation of npm dependencies and full semantic typecheck/build;
- a real WanGP installation and model weights;
- exported settings JSON from the exact WanGP/model version in use;
- real GPU renders for each enabled profile;
- optional ComfyUI node packs/workflows;
- CapCut desktop + official CapCut × Codex workflow behavior on the user's account/region;
- final end-to-end performance and VRAM measurements on RTX 5060 Ti 16 GB.

CineForge deliberately does not claim that a model-specific generation route is validated until that route has rendered successfully on the target machine.
