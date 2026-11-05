# Interactive LIVE — Ubuntu MVP (isolated experiment)

A custom, TikFinity-style **local event engine + realtime 3D temple garden** for OBS Browser Source.
This is an **independent prototype** under experiments/; it does not alter CineForge runtime or its dependencies.

## What works today

- Node 22 local API: POST /api/events, GET /api/state, GET /health and SSE GET /events.
- 3D scene rendered with Three.js, built locally by Vite (no CDN runtime dependency).
- Simulator buttons for likes, gifts, follows and comments.
- Rule engine: 100 likes -> lotus; gift -> lantern; follow -> bow; comment -> on-screen wish.
- Deduplication by supplied event ID, bounded inputs, browser-side textContent.
- OBS portrait overlay at /?view=overlay; dashboard at /.
- Optional TikTok read-only event adapter using an **unofficial** connector. No automatic TikTok login or RTMP publishing.

## Ubuntu quick start

Prerequisites: Node.js 22+, npm, graphics drivers and modern Chromium/OBS Browser Source.

~~~sh
cd experiments/interactive-live
npm install
npm test
npm run build
npm start
~~~

Open http://127.0.0.1:8787/ to test. Add an OBS **Browser Source** at
http://127.0.0.1:8787/?view=overlay with width 1080, height 1920, FPS 30.
The program can run locally even if TikTok is unavailable.
OBS on Linux provides Browser Source in its official packages; test WebGL/NVIDIA rendering on the actual Ubuntu host.

For API automation, set EVENT_TOKEN to a strong secret and add x-event-token to every POST request.
Do not expose port 8787 to a public interface.

~~~sh
EVENT_TOKEN=replace-with-long-random-value npm start
~~~

## Optional live event connector

The project does **not** silently install unofficial TikTok packages. Evaluate the connector's modified AGPL and TikTok rules first. It currently targets the documented 2.5.0 event names.

~~~sh
npm install --no-save tiktok-live-connector@2.5.0
EVENT_TOKEN=replace-with-long-random-value npm start
# In a second terminal, same directory:
TIKTOK_USERNAME=your_channel EVENT_TOKEN=replace-with-long-random-value npm run connect:tiktok
~~~

The adapter reads chat/gifts/likes and attempts to identify follow events via social payloads. TikTok's non-public Webcast protocol, gift streak semantics, reconnection behavior and access can change. This is **not production-validated**. Restarting after disconnect is currently manual. Never claim that received gift events represent reconciled payment records.

## Streaming to TikTok

This repo only produces the OBS scene; it **does not create, acquire or bypass** TikTok LIVE access. If your account legitimately receives an RTMP URL + stream key, configure them in OBS yourself. Stream keys and LIVE session lifetime are controlled by TikTok; 24/7 uninterrupted broadcast is **not guaranteed**.

## Honest boundaries

- No AI-generated voice/TTS yet; no LLM needed for event-to-animation routing.
- No database, durable queue, live session manager, comprehensive content moderation or retention policy yet.
- State resets on restart unless STATE_FILE is configured; bounded deduplication persists only when state snapshots are enabled.
- This scene is procedural 3D; there are no downloaded models or licensed third-party assets.
- Not a payment system, donation counter, religious authority or production streaming service.

## Next milestones

1. Validate actual TikTok connector payloads and gift streak behavior on a test LIVE.
2. Add content moderation, rate-limited TTS and human controls.
3. Add persisted state + replayable queue and reconnect/backoff.
4. Improve scene with Blender/GLB assets and quality settings for NVENC/GPU use.
5. Production hardening: observability, health probes, controlled service restarts, licensing review.

## Architecture

TikTok (optional) / Simulator -> Event Adapter -> Local Node API -> Rule Engine -> SSE -> Three.js 3D renderer -> OBS Browser Source -> permitted TikTok LIVE output.

This repository's original CineForge app is unrelated. Keep this experiment isolated until moving it to a standalone repository.

## Phase 2 additions (2026-11-05)

- Optional persistent state with `STATE_FILE=./.local/state.json`: debounced atomic snapshots store aggregate counts and the most recent 2,000 event IDs, **not comments**. At crash time, up to ~250ms of updates can be lost; no exactly-once guarantee.
- Comment cooldown (2.5 seconds per user) and basic URL redaction; this is not comprehensive moderation.
- `GET /api/metrics` provides accepted/rejected/duplicate counts and connected overlay clients (metrics reset on restart).
- TikTok adapter uses **FOLLOW event** instead of guessing from generic SOCIAL events; finalizes gift streaks before creating actions; bounded in-memory queue and reconnect/backoff.
- Blender GLB: export a model to `public/models/temple.glb`, rebuild, open `/?view=overlay&asset=temple`. If GLB loading fails, procedural temple remains visible. Three.js GLTFLoader is imported from the existing MIT-licensed `three` package, with no vendored code.
- Procedural monks, flowers and pond remain interactive even with the custom building model.

### Reference projects and license decisions

- [Three.js](https://github.com/mrdoob/three.js) — MIT; reuse GLTFLoader through the published npm dependency.
- [TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector) — AGPL-3.0; used only via optional external package; no source copied into this repo. Check reciprocal obligations before distributing a combined work.
- No unlicensed 3D assets are bundled. Obtain explicit reuse/redistribution rights and attribution for downloaded GLB assets.

### Persisted run (Ubuntu)

```bash
mkdir -p .local
STATE_FILE=./.local/state.json EVENT_TOKEN=replace-me npm start
```

Do not commit `.local/` or the state file: it may contain event IDs, and it must remain on the local machine.

### Known limitations

- Connector payload mapping is based on current upstream documentation but **not yet tested against a live TikTok session**.
- Rate limiting and dedupe are process-local. A restart recovers the most recent ID set only when `STATE_FILE` was configured and flushed.
- The bounded connector queue is not durable; temporary backend outages can cause dropped events.
- Keep OBS / scene renderer on the graphical Ubuntu host; use optional GLB only after checking model scale, performance and content rights.
