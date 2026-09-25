# Model/runtime setup — RTX 5060 Ti 16 GB class

CineForge 0.2 is **WanGP-first** for production and keeps ComfyUI as a lab/fallback path.

## 1. WanGP

Install WanGP separately and validate the desired model/preset in WanGP itself before importing it into CineForge.

In CineForge Settings configure:

```text
WanGP root    <your WanGP folder>
Python        python / python.exe from the working WanGP environment
Entrypoint    wgp.py
Profile       4 by default
Attention     auto unless the installation requires a specific backend
```

Then, for each route:

1. create/load the preset in WanGP;
2. export its settings JSON;
3. import it through **Import WanGP settings**;
4. review inferred JSON paths;
5. add/fix bindings for references that inference could not identify safely;
6. enable the profile;
7. run CineForge Preflight.

Do not assume settings exported from one WanGP/model version remain valid forever. CineForge intentionally leaves unknown settings untouched and only patches explicit bindings.

## 2. Suggested route set

Start small:

```text
LTX 2.5 Fast I2V/AV   general/default
HunyuanVideo 1.5 I2V  hero/quality-biased
Wan 2.2 5B I2V        motion/action/general fallback
```

Only install extra models when a real shot class requires them. Disk and RAM pressure become operational costs even when API cost is zero.

## 3. Resolution strategy

For 16 GB VRAM, prefer candidate generation at practical model-native draft/final resolutions, then upscale selected takes. Do not generate many native-1080p candidates just to discard most of them.

## 4. References/continuity

Useful binding keys include:

```text
startImage
endImage
locationImage
characterImage1..4
propImage1..2
referenceImage1..4
inputAudio
inputVideo
```

For WanGP these map to JSON paths in the exported settings. For ComfyUI they map to node selectors + input names.

Create stable reference packs for recurring characters/locations before rendering a film. Carry the previous shot's ending state into the next shot when physical continuity matters.

## 5. Audio

Prefer local/native model audio when it fits the shot. For narration/dubbing/ASR, use locally installed tools or local loopback services so the project does not acquire a new metered provider dependency. Import the resulting WAV/SRT/media into the project or CapCut handoff.

## 6. ComfyUI fallback

For ComfyUI, prefer **Save (API Format)** JSON. Normal UI graphs can be imported only when CineForge can convert them completely. Connected subgraphs/unknown node types are intentionally rejected rather than silently dropped.

## 7. CapCut

CapCut is not a generation requirement. Build a CineForge timeline, generate a handoff, then use CapCut × Codex for finishing. Leave CapCut AI credits disabled to preserve the Codex + CapCut-only recurring-cost policy.
