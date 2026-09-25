# Upstream references

CineForge deliberately keeps third-party integration details behind adapters because these projects evolve rapidly.

## CapCut × Codex

Official CapCut page:

- https://www.capcut.com/tools/capcut-x-codex

The official workflow describes using Codex with supplied footage to analyze/select moments, trim and arrange clips, produce captions, and create an editable rough cut that remains refinable in CapCut.

## WanGP / Wan2GP

Repository:

- https://github.com/deepbeepmeep/Wan2GP

Current CLI reference:

- https://github.com/deepbeepmeep/Wan2GP/blob/main/docs/CLI.md

CineForge relies on the documented headless settings/queue path (`--process`, `--output-dir`, optional `--dry-run`) rather than automating the WanGP web UI. Performance flags such as `--profile` and `--attention` are passed as process-level options.

## Principle

These links are reference material, not vendored dependencies. Validate exact versions and model licenses before commercial deployment.
