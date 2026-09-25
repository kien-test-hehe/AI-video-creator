# CineForge Local 0.2

**Codex orchestrates. Local AI renders. CapCut finishes.**

CineForge is a local-first AI video production OS designed around one budget rule: the only intended recurring paid services are **Codex/ChatGPT + CapCut**. Heavy media generation stays on the workstation.

```text
                         CODEX
                producer / orchestrator
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
     PROJECT STATE      LOCAL AI         LOCAL MEDIA
     story / shots      WanGP main       FFmpeg
     continuity         ComfyUI lab      optional ASR/TTS
     timeline / QC      local LLM        upscale/interp
          │                │                │
          └────────── generated assets ─────┘
                           │
                           ▼
                   CINEFORGE TIMELINE
                           │
                   CapCut handoff
                           │
                           ▼
                     CAPCUT × CODEX
                           │
                  editable final polish
```

## What changed in 0.2

- **WanGP-first production runtime** with a version-safe exported-settings adapter.
- ComfyUI retained as **lab/fallback**, not the canonical generation backend.
- Explicit `codex-capcut-only` cost policy.
- CapCut AI credits default to **disabled**.
- CapCut × Codex handoff manifest + generated task instructions.
- Codex producer and CapCut-finishing skills checked into the repo.
- Immutable render snapshots and workflow/settings SHA-256 remain enforced.
- Local-only network guard remains the default.

## Core production flow

```text
Story
→ Assets / continuity references
→ Director / storyboard
→ Shot graph
→ WanGP or ComfyUI route
→ immutable render queue
→ takes
→ CineForge timeline
→ FFmpeg export and/or CapCut handoff
→ CapCut × Codex finishing
→ final human verification
```

The CapCut project is deliberately **not** the canonical project representation. CineForge keeps enough structured state to reconstruct the edit if the external integration changes.

## Workstation target

The defaults are intended for a machine in the class of:

- RTX 5060 Ti 16 GB VRAM
- 40+ GB system RAM; 64 GB is more comfortable for offload/model switching
- i5-14400F-class CPU or better
- NVMe storage with substantial free space

Generate candidates at practical local resolutions, select/repair shots, then upscale/finish rather than brute-forcing many native-1080p candidates.

## Runtime roles

### WanGP — production

CineForge does **not** hard-code one WanGP model schema. Instead:

1. Configure a preset in your installed WanGP version.
2. Export its working settings JSON.
3. Import that JSON in **Settings → Import WanGP settings**.
4. Review inferred JSON-path bindings.
5. Enable the profile.

At render time CineForge freezes the shot + profile, patches a project-local settings copy, then launches WanGP headlessly. Model-specific parameters that CineForge does not own remain untouched.

Recommended routing intent:

- LTX 2.5 Fast: general I2V/AV, dialogue/audio-aware shots.
- HunyuanVideo 1.5: hero/quality-biased shots.
- Wan 2.2 5B/variants: motion/action/general local generation.
- long-video route: optional specialized profile rather than forcing one giant diffusion shot.

### ComfyUI — lab/fallback

ComfyUI API-format workflows remain supported. UI graph conversion is fail-safe: if CineForge sees connected subgraphs or unknown nodes that cannot be flattened safely, it refuses to create a partial graph and asks for an API-format export.

### CapCut — finishing

After building a CineForge timeline, open **CapCut** in the sidebar and choose **Prepare CapCut handoff**. CineForge creates:

```text
handoff/capcut/<timestamp>/manifest.json
handoff/capcut/<timestamp>/CODEX_CAPCUT_TASK.md
```

The handoff asks the official CapCut × Codex workflow to preserve the edit while using CapCut for:

- caption styling,
- typography,
- trim/order refinement,
- transitions,
- tracking/reframe,
- effects/templates available in the plan,
- final polish and editable export.

When `allowCapcutAiCredits = false`, the task explicitly prohibits paid replacement generation.

## Cost wall

Defaults:

```json
{
  "mode": "codex-capcut-only",
  "allowCapcutAiCredits": false,
  "localOnly": true
}
```

No Gemini/Groq/OpenRouter dependency exists in the core path. Optional local ASR/TTS/upscale/separation tools can be invoked by Codex or added as local adapters without changing the canonical project model.

“Local / no per-call bill” still means you pay electricity, storage and hardware costs and must respect each model/tool license.

See [docs/COST_POLICY.md](docs/COST_POLICY.md).

## Install

Prerequisites:

- Node.js `22.16.x`
- npm `10.x`
- NVIDIA driver/CUDA stack appropriate for your local AI runtime
- FFmpeg
- WanGP for the production route
- optional ComfyUI for experimental workflows
- optional local OpenAI-compatible LLM server for Director/continuity review

```bash
npm install
npm run typecheck
npm test
npm run dev
```

Environment variables are optional; all can be configured per project:

```bash
cp .env.example .env
```

Important variables:

```text
CINEFORGE_WANGP_ROOT=/path/to/Wan2GP
CINEFORGE_PYTHON=python
CINEFORGE_FFMPEG=ffmpeg
CINEFORGE_COMFY_URL=http://127.0.0.1:8188
CINEFORGE_COMFY_INPUT=/path/to/ComfyUI/input
```

## First-run checklist

1. Open Settings.
2. Point **WanGP root** to the installed WanGP directory.
3. Verify Python and FFmpeg paths.
4. Leave **CapCut AI credits disabled** unless you intentionally want metered CapCut generation.
5. Export/import one working WanGP settings JSON for each model route you want.
6. Map/review prompt, seed, dimensions, frames and reference JSON paths.
7. Enable only validated profiles.
8. Import character/location/prop/reference assets.
9. Plan shots and attach continuity assets/keyframes.
10. Run Preflight before batch rendering.
11. Build the latest cut in Timeline.
12. Prepare a CapCut handoff for finishing.

## Reliability and safety properties

- renderer process has no unrestricted filesystem access;
- project media uses a sandboxed media protocol;
- path containment blocks traversal and symlink escape;
- project writes keep a known-good backup;
- render runtime state is owned by the main process so renderer autosave cannot clobber a live queue;
- one-GPU serialized scheduling avoids accidental concurrent diffusion renders;
- retry uses the exact queued snapshot;
- workflow/settings SHA mismatch blocks non-reproducible retry;
- local-only host checking prevents accidental cloud AI calls in the core path;
- preflight checks missing/stale assets, runtime availability, bindings and shot validity.

## Repository map

```text
src/
  main/
    services/
      wangp-engine.ts       exported-settings binding
      wangp-runner.ts       headless WanGP process runner
      render-queue.ts       immutable single-GPU queue
      capcut-handoff.ts     CapCut × Codex manifest/task
      preflight-service.ts  cost/runtime/workflow checks
      workflow-engine.ts    ComfyUI adapter
      director-service.ts   local LLM planning/review
      ffmpeg-service.ts     deterministic master export
  preload/                  typed IPC bridge
  renderer/                 Electron/React production UI
  shared/                   schema, routing, defaults, API
skills/
  video-producer/SKILL.md
  capcut-finishing/SKILL.md
docs/
  ARCHITECTURE.md
  COST_POLICY.md
  CAPCUT_CODEX.md
```

## Current validation status

The repository includes static/core smoke tests for screenplay parsing, ComfyUI workflow binding/conversion safety, path containment, local-only networking, model routing, continuity references and WanGP JSON-path inference.

Full diffusion integration requires the target machine to have the selected model weights and a working WanGP/ComfyUI installation. A successful TypeScript/build test does not substitute for validating a specific exported model preset on the actual RTX workstation.

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and [MODEL_SETUP.md](MODEL_SETUP.md).
