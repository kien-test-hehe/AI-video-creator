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
   continuity / jobs    ComfyUI lab     ASR/TTS tools*
   immutable snapshots  local LLM       upscale/interp*
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
- SHA-256 of the imported workflow/settings JSON.

Retry reuses that snapshot. If the workflow/settings file changed after queue time, retry fails instead of silently producing a different render.
