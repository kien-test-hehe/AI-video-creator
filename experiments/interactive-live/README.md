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
- No databases, durable queue, live session manager, content moderation or retention policy yet.
- State resets on restart; in-memory event dedupe is limited to 2,000 IDs.
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
