# Cost policy: Codex + CapCut only

CineForge is designed so the only **intended recurring paid services** are:

1. Codex / ChatGPT access used as the producer/orchestrator.
2. CapCut (Free or Pro) used as the editor and finishing NLE.

Everything else on the core media path is local. There is no Gemini, Groq, OpenRouter, hosted image model, hosted video model, hosted TTS, or hosted ASR dependency in the default architecture.

## Default rules

- Machine AI endpoints are enforced as loopback-only in machine settings; portable projects cannot weaken that policy.
- `settings.costPolicy.mode = "codex-capcut-only"`.
- `settings.costPolicy.allowCapcutAiCredits = false`.
- WanGP and ComfyUI run on the local workstation.
- The AI Director endpoint must be loopback/local when Local-only is enabled.
- FFmpeg runs locally.
- CapCut receives already-generated media and focuses on editorial/finishing.

Local inference still has real costs: electricity, storage, hardware wear, and model/software licensing obligations. “$0/call” means no metered cloud API charge, not literally zero operating cost.

## CapCut Free / Pro / AI credits

New projects start in **Free / No Pro** mode. Pro is explicit opt-in. CapCut's 2026 membership structure can vary by account/region and also includes a Standard tier; CineForge currently treats any non-Pro membership as the non-Pro finishing policy.

CapCut Pro and CapCut AI credits are treated as different budget categories. The handoff manifest contains `capcutAiCreditsAllowed`. When it is `false`, the generated Codex task explicitly tells the CapCut workflow not to generate replacement media with paid AI operations.

If the user intentionally enables AI credits, preflight emits a warning so the spend is visible rather than accidental.

## Canonical state

CapCut is not the source of truth. CineForge keeps:

- project JSON,
- assets and reference packs,
- shots and generation settings,
- immutable render snapshots,
- render outputs,
- canonical timeline,
- CapCut handoff manifests.

This makes the project reconstructable even if CapCut integration behavior changes later.
