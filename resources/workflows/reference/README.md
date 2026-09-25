# Reference workflow cache

Run:

```bash
npm run workflows:fetch
```

The script downloads current official reference workflows for LTX-2.5, HunyuanVideo-1.5 and Wan 2.2 5B, validates that each response is JSON, and writes a SHA-256 source manifest next to the files.

These files are **setup-time references**, not hidden cloud dependencies. CineForge does not fetch them during rendering.

## Important: UI JSON vs API JSON

Official examples are commonly saved in ComfyUI's UI workflow format. CineForge can convert ordinary graphs using your local `/object_info`, but complex workflows may contain subgraphs or frontend-only widgets. For production:

1. Open the reference workflow in your local ComfyUI.
2. Install the exact missing custom nodes/models reported by ComfyUI.
3. Verify the graph once in ComfyUI.
4. Export **Save (API Format)**.
5. Import that API JSON into CineForge and review the generated bindings.

This avoids coupling CineForge to private node IDs or to a particular upstream graph revision.
