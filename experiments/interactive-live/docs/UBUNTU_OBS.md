# Ubuntu + Blender + OBS operator runbook

This experiment **does not** automate creation of TikTok stream keys. Confirm LIVE RTMP/OBS privileges on your own account before planning 24/7 service.

## 1) Build an original temple in Blender

Requires Blender 4.x (Linux). This script generates procedural geometry and exports a local GLB; no downloaded assets or license ambiguity.

```sh
cd experiments/interactive-live
blender --background --python scripts/generate_temple.py -- public/models/temple.glb
npm install && npm run build
```

With `npm start` running, open `http://127.0.0.1:8787/?view=overlay&asset=temple`. No source code modifications are required to swap in your own GLB at the same path.

You can download CC0/compatible GLB assets from a properly licensed source instead; comply with attribution, trademark, redistribution, and rights to likenesses. Treat external assets as untrusted and inspect them before importing.

## 2) OBS Studio on Ubuntu Desktop

- Keep an active graphical desktop session. Add a Browser Source at `http://127.0.0.1:8787/?view=overlay&asset=temple`.
- Canvas 1080x1920, output 720x1280, 30 FPS initially; measure VRAM, FPS and CPU/GPU encode utilization.
- Prefer hardware H.264 NVENC if supported by the installed NVIDIA driver and OBS build.
- Verify WebGL works in OBS Browser Source. If GPU acceleration fails, lower canvas resolution before adding more visual effects.
- Do not assume a new TikTok LIVE session can reuse an old RTMP stream key.

## 3) Smoke tests

```sh
npm test
npm run build
STATE_FILE=./.local/state.json npm start
# Other terminal:
npm run demo:replay
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/api/metrics
```

The replay script exercises synthetic events and does **not** access TikTok.

## 4) Optional systemd services

A systemd **user** unit may keep the Node backend running while the user account is logged in and permitted to linger, but OBS remains a graphical application requiring a functioning GUI. A backend restart is not the same as reestablishing a TikTok LIVE session.

Create `~/.config/systemd/user/interactive-live.service`, replace `YOUR_REPO` with the absolute path:

```ini
[Unit]
Description=Interactive LIVE local event engine
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/YOUR_USER/YOUR_REPO/experiments/interactive-live
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=STATE_FILE=.local/state.json
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

Do not add secrets directly to a publicly committed unit file. Use a private user-owned environment file and filesystem permissions. TikTok connector service should start only when explicitly configured, and it must not auto-bypass livestream permissions.

## 5) Known operational gaps

The project is still a prototype: state snapshots are debounced, connector queue is in-memory, SSE has no durable replay, there is no integrated content moderation service, and OBS automation/recovery is not implemented. No uninterrupted 24/7 LIVE guarantee.
