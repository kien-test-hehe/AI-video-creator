# Architecture

```text
                         CODEX
                producer / orchestrator
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   CINEFORGE STATE      LOCAL AI        LOCAL MEDIA
   project / shots      WanGP main      FFmpeg
   states / topology    ComfyUI lab     ASR/TTS tools*
   QC provenance/jobs   local LLM       upscale/interp*
          │                │                │
          └──────────── generated media ────┘
                           │
                           ▼
                    CANONICAL TIMELINE
                           │
                  CapCut handoff manifest
                           │
                           ▼
                    CAPCUT × CODEX
             captions / typography / edit
          transitions / tracking / finishing
                           │
                           ▼
                      FINAL VIDEO
```

`*` Optional local tools are intentionally outside the required runtime. Codex can invoke installed local tools directly; CineForge does not force a hosted API provider.

## Runtime split

### WanGP — production generation

WanGP is the preferred production runtime. CineForge imports an exported WanGP settings JSON, binds project/shot values by JSON path, writes an immutable job settings file, then launches WanGP headlessly. This avoids coupling CineForge to a rapidly changing model-specific parameter schema.

### ComfyUI — lab/fallback

ComfyUI remains supported for experimental or specialized graphs. API-format workflows are preferred. UI workflows are converted only when the conversion is provably complete; connected subgraphs/unknown nodes trigger a fail-safe request to export API format from ComfyUI.

### CapCut — finishing, not storage

The CapCut handoff is derived from the current CineForge timeline. It contains media paths, clip order, trims, volumes, dialogue and continuity notes plus explicit spending policy. A matching Codex instruction asks CapCut to produce an editable draft without replacing local media through paid generation unless explicitly permitted.

## Render reproducibility

Each queued render stores an immutable snapshot of:

- the shot,
- effective prompt,
- generation settings and seed,
- runtime profile and bindings,
- SHA-256 of the imported workflow/settings JSON;
- SHA-256 of every referenced project asset;
- a local runtime/environment fingerprint;
- an optional model/checkpoint fingerprint.

Retry reuses that snapshot. If the workflow/settings file, referenced assets, runtime environment, or recorded model fingerprint changed after queue time, retry fails instead of silently claiming an exact reproduction.


## State and QC authority

A rendered take is canonical only when its stored production-input fingerprint still matches the current shot/reference/workflow/structured-state inputs and the required current QC records match their own input fingerprints. Changing upstream continuity state, shot topology, keyframes, assets or render inputs invalidates downstream generated truth rather than silently reusing historical PASS records.

Default sequential continuity edges are rebuilt when shot order/membership changes. Custom dependency edges are preserved. Human-owned start frames are never overwritten by automatic propagation.
