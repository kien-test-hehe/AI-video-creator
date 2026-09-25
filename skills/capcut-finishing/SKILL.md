---
name: cineforge-capcut-finishing
description: Finish a CineForge canonical timeline in CapCut without accidental AI-credit spend.
---

# CineForge CapCut finishing

Input is a generated `handoff/capcut/<timestamp>/manifest.json` plus `CODEX_CAPCUT_TASK.md`.

- Preserve clip order, trim ranges, dialogue timing and continuity unless an editorial correction is clearly justified.
- Use CapCut for captions, typography, cuts/J-cuts/L-cuts, transitions, tracking/reframe, effects and final polish.
- Keep the CapCut project editable.
- Do not replace existing local-generated media with paid CapCut AI generation when `policy.capcutAiCreditsAllowed` is false.
- Do not bake critical spelling-sensitive text, logos, prices or CTAs into generated imagery.
- If an asset is missing, report the missing source path instead of silently substituting cloud-generated media.
