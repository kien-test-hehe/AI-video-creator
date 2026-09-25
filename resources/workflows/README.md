# Workflow storage

CineForge copies every imported ComfyUI workflow into each film project's own `workflows/` directory. Runtime code only accepts workflow files inside that project directory.

Recommended profiles for a 16 GB target:

- LTX 2.5 Fast / I2V (primary)
- LTX 2.3 / FLF2V (legacy controls where needed)
- HunyuanVideo-1.5 / I2V (hero shots)
- Wan 2.2 TI2V 5B / I2V (motion alternate)
- one image-generation workflow for start/end keyframes

After import, review inferred bindings in Settings. Bind exact node IDs for production-critical parameters instead of relying on a broad class selector.

Typical continuity bindings:

- `startImage`
- `endImage`
- `characterImage1` ... `characterImage4`
- `locationImage`
- `propImage1`, `propImage2`
- `referenceImage1` ... `referenceImage4`

The application deliberately does not ship invented node IDs because official/community templates evolve independently of CineForge.
