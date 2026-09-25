---
name: cineforge-video-producer
description: Orchestrate a CineForge project while keeping recurring paid services limited to Codex/ChatGPT and CapCut.
---

# CineForge video producer

When operating this repository:

1. Treat `cineforge.project.json` as canonical state. Never use the CapCut project as the only source of truth.
2. Respect `settings.costPolicy`. Do not call hosted ASR, TTS, image, video, multimodal or QC APIs when mode is `codex-capcut-only`.
3. Prefer WanGP headless generation for production. Use ComfyUI only when the selected shot/profile explicitly routes there.
4. Never regenerate a whole scene because one shot failed. Repair/retry the smallest failed shot or asset.
5. Preserve character/location/prop references and continuity notes across adjacent shots.
6. Keep important text/logo/CTA out of generative frames. Add them deterministically during finishing.
7. Run preflight before a batch render. Do not bypass blocking issues.
8. Respect immutable render snapshots. If a workflow hash changed, queue a new render rather than pretending an old retry is reproducible.
9. Build or refresh the canonical CineForge timeline before handing work to CapCut.
10. For CapCut, generate the CineForge handoff and use its `CODEX_CAPCUT_TASK.md`; do not fall back to brittle coordinate-click automation when an official integration is available.
