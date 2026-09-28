# CineForge Local 0.3

**Codex orchestrates. Local AI renders. CapCut finishes.**

CineForge is a local-first desktop production orchestrator for AI video. Its budget rule is explicit: the only intended recurring paid services are **Codex/ChatGPT + CapCut**. Heavy ASR/TTS/image/video/upscale/QC work is local.

## RTX 5060 Ti Windows quick start

For a fresh Windows workstation:

```bat
git clone https://github.com/kien-test-hehe/AI-video-creator.git
cd AI-video-creator
setup.cmd
start.cmd
```

`setup.cmd` is idempotent and prepares a machine-local runtime under `.runtime/`. It also writes `%LOCALAPPDATA%\\CineForge\\bootstrap-machine-settings.v1.json`; a packaged/NSIS CineForge app imports those machine paths on first run when it has no saved machine settings yet. `start.cmd` launches the **built** Electron app (not Vite development mode):

- portable Node.js 22.16;
- FFmpeg + FFprobe when missing;
- the pinned WanGP source/runtime and its automatic RTX-aware environment installer;
- CineForge npm dependencies and source validation;
- machine-local environment values for WanGP/Python/FFmpeg.

NVIDIA display/compute drivers are intentionally **not** silently upgraded by the script; if `nvidia-smi` is missing, setup stops with a clear prerequisite error. CapCut is detected but is not forcibly installed or upgraded.

The first project defaults to **CapCut Free / No Pro** and **CapCut AI credits disabled**. CineForge detects whether a CapCut executable is present, but it does **not** claim to verify the signed-in CapCut account's subscription tier; Pro/No Pro is an explicit project policy setting. If the machine-local WanGP runtime is ready, CineForge automatically reads its model catalog and provisions recommended local profiles. Model weights remain on-demand because shipping tens of gigabytes inside Git would be impractical.

## Unified Studio UX

CineForge opens into **Studio**, a filmmaking control surface inspired by the useful interaction model of node-based tools without exposing users to raw diffusion graph complexity.

Studio keeps the production state visible at once:

- left asset library with search/filter/import, in-place metadata/continuity editing and drag sources;
- center pan/zoom pipeline graph: Story / Assets / System → Scenes → Shots → Workflow Profiles → Queue → Timeline → CapCut;
- draggable visual node layout with lock, cursor-anchored zoom, fit, focus, auto-layout and minimap; node position is presentation only and never changes film order;
- single-click inspect-in-place for story, assets, system/preflight, scenes, shots, workflows, queue, timeline and CapCut; double-click opens the detailed workspace;
- shot nodes that expose status, model/mode, dedicated character/location/generic-reference/prop coverage, keyframes and truthful workflow-route readiness;
- validated video workflows can be dragged onto shot nodes; invalid/disabled/mismatched explicit routes remain visible as blocked instead of silently falling back;
- right shot inspector for prompt, camera, model/mode, workflow, W/H/frames/FPS/steps/CFG/seed, negative prompt, audio policy, continuity review, keyframe generation and role-specific drag/drop;
- bottom Queue dock with every job plus cancel/retry controls and shot focus;
- bottom Timeline dock with every canonical clip, drag-to-reorder and rendered-take → timeline insertion;
- System / Preflight node plus GPU/VRAM/WanGP/ComfyUI/CapCut/Queue HUD;
- one-click Preflight, Render selected and Render all.

Generic visual references are stored separately from props/wardrobe. The project schema enforces asset-kind roles and migrates older projects where generic references were previously carried in the prop slot. Schema v3 also stores structured shot states, continuity dependencies, layered QC history, human-review tasks and canonical-take provenance.

The detailed Story, Assets, Storyboard, Shot Workshop, Queue, Timeline, CapCut and Settings views remain available from the icon rail. The graph is therefore an **overview/control workspace**, not a second hidden project model.

## Architecture

```text
                         CODEX
                  producer / orchestrator
                           │
                           ▼
                   CINEFORGE CORE
        project graph / policy / durable jobs
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           WanGP        ComfyUI      Local tools
        production       lab        ASR/TTS/etc.
              └────────────┼────────────┘
                           ▼
                      media + QC
                           │
                           ▼
                 canonical CineForge cut
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        local master export       CapCut handoff
                                        │
                                        ▼
                                  CapCut × Codex
                                        │
                                        ▼
                                  human final QC
```

CapCut is deliberately **not** the canonical project database. A CineForge project remains reconstructable without a CapCut project file.

## Security model

Portable projects are treated as untrusted input.

- Project schema v3 is runtime-validated and bounded; render/QC/state provenance is fail-closed when current shot inputs or continuity topology no longer match.
- Legacy v1 projects are migrated, but executable paths and AI endpoint URLs are discarded.
- FFmpeg, FFprobe, Python, WanGP, Docker, ComfyUI and local-LLM settings live only in Electron `userData`.
- AI service URLs are loopback-only.
- Every IPC handler validates its sender.
- renderer navigation, popup windows, webviews and permission requests are locked down.
- project reads resolve canonical real paths to block symlink escape.
- writes are restricted to known project roots.
- active render recovery trusts only installation-signed job journals.

Opening a project never executes a path or contacts an endpoint supplied by that project.

## Render reliability

Each queued render freezes:

- the shot, prompt, generation settings and seed;
- workflow/settings SHA-256;
- SHA-256 of every referenced project asset;
- local runtime fingerprint;
- optional model/checkpoint fingerprint.

Retry refuses to claim exactness when those inputs changed.

Runtime progress is journaled separately from canonical project JSON, so verbose model logs do not rewrite the whole project. After restart, signed queued jobs are re-queued, ComfyUI jobs reconcile by prompt ID, native WanGP jobs verify the recovered process command line before attaching by PID, and Docker WanGP jobs reconcile by deterministic container identity. If immutable workflow/assets/runtime no longer match, the verified WanGP backend is stopped and the job becomes `orphaned`. Unsigned active state from a foreign project never auto-runs.

## Production backends

### WanGP

WanGP is the primary production runtime. `setup.cmd` installs the repository-pinned upstream commit into `.runtime/Wan2GP`; model weights download on first use. CineForge supports:

- native process execution as the primary RTX 5060 Ti route;
- optional isolated Docker execution with deterministic per-job container names;
- direct upstream model-catalog discovery and managed profile provisioning;
- manual exported-settings import for custom routes;
- explicit JSON-path bindings and ambiguity-safe binding inference;
- automatic Start/End/reference prompt-mode activation when those assets are attached;
- dry-run validation;
- host→container path mapping limited to explicit mounts.

### ComfyUI

ComfyUI is a lab/fallback runtime. Production routes require:

- API-format workflows;
- validated bindings;
- a dedicated CineForge ComfyUI instance.

Connected unknown/subgraph UI nodes are never silently flattened.

## Technical QC

Generated video is inspected before it can become the preferred take:

- video/audio stream presence;
- expected duration;
- expected resolution/FPS;
- requested audio presence;
- black-segment detection;
- frozen-segment detection;
- clipping-risk audio peak detection.

A video route that produces no video or fails technical QC becomes a failed job, while the output remains available for diagnosis.

## CapCut

**Finishing → Prepare CapCut handoff** validates the current canonical timeline and writes:

```text
handoff/capcut/<timestamp>-<uuid>/
  manifest.json
  CODEX_CAPCUT_TASK.md
```

The task asks the official CapCut × Codex workflow to preserve media/order/trims/dialogue while using CapCut for captions, typography, transitions, tracking/reframe, effects and final polish. New projects are **Free / No Pro by default**. Pro is an explicit project toggle, and CapCut AI-credit generation remains a separate opt-in.

This is a handoff contract, not brittle coordinate-click GUI automation.

## Target workstation

Primary target:

- RTX 5060 Ti 16 GB
- i5-14400F class CPU
- 40+ GB RAM; 64 GB preferred
- NVMe with meaningful free space
- Windows 11 for CapCut finishing

See [docs/RUNTIME_REQUIREMENTS.md](docs/RUNTIME_REQUIREMENTS.md) and [MODEL_SETUP.md](MODEL_SETUP.md).

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run test:smoke
npm run build
npm run dev
```

Machine defaults can be seeded from:

```bash
cp .env.example .env
```

The supported Node/npm baseline is declared in `package.json`.

## Packaging

```bash
npm run pack
npm run dist:win
npm run dist:linux
npm run dist:mac
```

Production packages use ASAR plus Electron fuses that disable Run-As-Node, Node CLI inspection/options and file-protocol privilege expansion while enabling ASAR integrity validation.

The NSIS installer contains the desktop application, not multi-gigabyte model/runtime payloads. On a workstation bootstrapped with `setup.cmd`, the installed app imports the machine-local WanGP/Python/FFmpeg paths on first run. Without that bootstrap, the same paths can be configured explicitly in **Machine Settings**.

Code signing credentials are intentionally not stored in this repository.

## CI

`.github/workflows/ci.yml` gates:

1. dependency lock/install;
2. TypeScript;
3. zero-warning ESLint;
4. unit/security tests;
5. WanGP Python bridge tests;
6. core smoke tests;
7. Electron/Vite production build;
8. Linux Electron packaging;
9. Windows PowerShell bootstrap parsing + NSIS installer packaging.

A model route is **not** considered hardware-validated merely because source CI is green. The exact runtime/model must also complete a real render on the target GPU.

## Repository map

```text
src/
  main/
    services/
      project-schema.ts
      app-settings-service.ts
      render-queue.ts
      job-journal.ts
      technical-qc.ts
      wangp-runner.ts
      workflow-engine.ts
      capcut-handoff.ts
  preload/
  renderer/
    src/views/Studio.tsx
    src/asset-assignment.ts
  shared/

tests/
docs/
infra/docker/
skills/
```

## Cost wall

Default policy:

```json
{
  "mode": "codex-capcut-only",
  "allowCapcutAiCredits": false
}
```

There is no required Gemini, Groq, OpenRouter, hosted ASR, hosted TTS or hosted image/video generation dependency in the core path. “Local” means no per-call cloud inference bill; hardware, electricity, storage and model/tool licences still matter.

See [docs/COST_POLICY.md](docs/COST_POLICY.md).
