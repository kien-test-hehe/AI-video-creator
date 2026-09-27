# CapCut × Codex handoff

CineForge does not automate CapCut with screen coordinates. Instead, **Finishing → Prepare CapCut handoff** creates:

```text
handoff/capcut/<timestamp>-<uuid>/
  manifest.json
  CODEX_CAPCUT_TASK.md
```

The manifest is machine-readable and includes:

- canonical timeline clips,
- source paths,
- trims and volume,
- shot dialogue and continuity notes,
- project assets,
- output settings,
- cost policy.

The generated task tells Codex to use the official CapCut × Codex workflow for an editable rough cut/final polish and to avoid CapCut AI generation when `capcutAiCreditsAllowed` is false.

## Recommended finishing responsibilities

CapCut:

- editorial trim/order refinement,
- caption styling,
- typography,
- deterministic transitions,
- tracking and reframing,
- effects/templates that are already available in the user plan,
- audio level polish,
- final human-verifiable export.

Local pipeline:

- ASR/transcription,
- TTS/voice generation,
- image generation,
- video generation,
- upscale/interpolation,
- source separation,
- deterministic preprocessing/QC.

Important text, logos, prices and CTAs should be overlays in CapCut/another deterministic renderer rather than baked into generative video frames.
