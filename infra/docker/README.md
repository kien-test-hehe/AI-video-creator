# Optional GPU runtime isolation

CineForge does not containerize Electron, Codex or CapCut. Docker is only an optional execution mode for the local WanGP backend.

Requirements: Docker Engine/Desktop, GPU exposure through `docker run --gpus all`, NVIDIA Container Toolkit on Linux, and a WanGP image that you have already validated.

Configure Machine Settings with an immutable image tag/digest plus project and WanGP mount roots. CineForge maps only the project root and WanGP root into the container. Any absolute path outside those mounts is rejected before launch.

Conceptually CineForge runs:

```bash
docker run --rm --gpus all \
  -v "<project>:/workspace/project" \
  -v "<wangp>:/workspace/Wan2GP" \
  -w /workspace/Wan2GP \
  <validated-image> \
  python /workspace/Wan2GP/wgp.py \
  --process /workspace/project/.../settings.json \
  --output-dir /workspace/project/.../renders \
  --profile 4
```

For RTX 50-series, do not assume an upstream Docker helper image matches the newest recommended native Python/PyTorch/CUDA stack. Treat the image as an independently fingerprinted runtime.
