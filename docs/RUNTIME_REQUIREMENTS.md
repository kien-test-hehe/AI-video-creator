# Runtime requirements

## Target workstation

Primary validation target is an RTX 5060 Ti 16 GB, i5-14400F-class CPU, 40+ GB RAM (64 GB preferred), and NVMe storage. Windows 11 is the primary desktop/CapCut target.

## CineForge desktop

The pinned application toolchain is declared in package.json and locked by package-lock.json. Node 22.16.x and npm 10.9.9 are the supported development baseline. CI is authoritative for TypeScript, lint, tests and Electron/Vite build.

## WanGP on RTX 50-series

Follow the current upstream WanGP guide rather than old setup posts. The current upstream recommendation for RTX 30XX–50XX uses Python 3.11.14 and PyTorch 2.10 with CUDA 13.x; Windows RTX 30XX–50XX guidance uses Triton 3.6, and RTX 50XX can use optimized NV FP4 paths.

CineForge does not vendor WanGP or weights. Configure the exact working installation under Machine Settings and import JSON exported from that same version/model.

## Native versus Docker

Native is the default for the 5060 Ti target. Docker mode isolates only the local AI backend; Electron and CapCut remain native. Upstream WanGP Docker helper scripts can use a different CUDA/PyTorch generation from current RTX 50 native guidance, so a Docker image is a separately validated runtime and should be pinned by tag/digest.

## FFmpeg / ComfyUI / Director

Both ffmpeg and ffprobe are required. h264_nvenc is the default RTX encoder, with libx264 fallback. Production ComfyUI must be a dedicated CineForge instance. The Director endpoint must be loopback-only; portable projects cannot override it.
