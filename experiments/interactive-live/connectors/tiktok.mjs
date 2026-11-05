/**
 * Optional adapter for zerodytrash/TikTok-Live-Connector (AGPL-3.0).
 * No source copied; install dependency deliberately after reviewing its terms.
 * Read-only listener; cannot send comments, gifts or automate TikTok account actions.
 */
import { fromTikTokEvent } from "./event-mapper.mjs";

const username = (process.env.TIKTOK_USERNAME || "").replace(/^@/, "");
const token = process.env.EVENT_TOKEN;
if (!username) throw new Error("Set TIKTOK_USERNAME (without @)");
if (!token) throw new Error("Set EVENT_TOKEN to protect the local POST endpoint");

const { TikTokLiveConnection, WebcastEvent, ControlEvent } = await import("tiktok-live-connector");
const endpoint = "http://127.0.0.1:" + (process.env.PORT || "8787") + "/api/events";
let stopping = false, connection = null;
const queue = [];
let draining = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length && !stopping) {
      const next = queue[0];
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-event-token": token },
          body: JSON.stringify(next),
          signal: AbortSignal.timeout(5000)
        });
        if (response.status === 429) { queue.shift(); continue; } // moderation cooldown
        if (!response.ok) throw new Error("HTTP " + response.status);
        queue.shift();
      } catch (err) {
        console.error("Local event delivery failed:", err.message);
        await sleep(2000);
      }
    }
  } finally { draining = false; }
}
function enqueue(type, data) {
  const event = fromTikTokEvent(type, data);
  if (!event) return;
  if (queue.length >= 500) {
    // Prefer keeping gifts and comments when saturated; likes are best effort.
    const likeIndex = queue.findIndex((item) => item.type === "like");
    if (likeIndex >= 0) queue.splice(likeIndex, 1);
    else { console.warn("Event backlog full; dropping an event"); return; }
  }
  queue.push(event);
  void drain();
}
async function shutdown() {
  stopping = true;
  try { await connection?.disconnect(); } catch {}
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

let retry = 2000;
while (!stopping) {
  connection = new TikTokLiveConnection(username, { processInitialData: false });
  connection.on(WebcastEvent.CHAT, (data) => enqueue("chat", data));
  connection.on(WebcastEvent.LIKE, (data) => enqueue("like", data));
  connection.on(WebcastEvent.GIFT, (data) => enqueue("gift", data));
  connection.on(WebcastEvent.FOLLOW, (data) => enqueue("follow", data));
  connection.on(ControlEvent.ERROR, (error) => console.error("TikTok connection:", error.message));
  let finished;
  const disconnected = new Promise((resolve) => { finished = resolve; });
  connection.once(ControlEvent.DISCONNECTED, () => finished("disconnected"));
  connection.once(WebcastEvent.STREAM_END, () => finished("stream ended"));
  try {
    const state = await connection.connect();
    console.log("TikTok LIVE connected:", username, "room:", state.roomId);
    retry = 2000;
    console.warn("TikTok connection ended:", await disconnected);
  } catch (e) {
    console.error("TikTok connect failed:", e.message);
  } finally {
    try { await connection.disconnect(); } catch {}
    connection.removeAllListeners();
    connection = null;
  }
  if (!stopping) {
    console.log("Reconnecting in", retry, "ms");
    await sleep(retry);
    retry = Math.min(retry * 2, 60000);
  }
}
