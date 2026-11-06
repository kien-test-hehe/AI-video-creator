/**
 * Optional adapter for zerodytrash/TikTok-Live-Connector (AGPL-3.0).
 * No source copied; install dependency deliberately after reviewing its terms.
 * Read-only listener; cannot send comments, gifts or automate TikTok account actions.
 */
import { fromTikTokEvent } from "./event-mapper.mjs";
import { createOutbox } from "./outbox.mjs";

const username = (process.env.TIKTOK_USERNAME || "").replace(/^@/, "");
const token = process.env.EVENT_TOKEN;
if (!username) throw new Error("Set TIKTOK_USERNAME (without @)");
if (!token) throw new Error("Set EVENT_TOKEN to protect the local POST endpoint");

const { TikTokLiveConnection, WebcastEvent, ControlEvent } = await import("tiktok-live-connector");
const endpoint = "http://127.0.0.1:" + (process.env.PORT || "8787") + "/api/events";
let stopping = false, connection = null;
const outbox = createOutbox({ file: process.env.OUTBOX_FILE || ".local/connector-outbox.json" });
let draining = false;
let connected = false, roomId = "";
const statusEndpoint = "http://127.0.0.1:" + (process.env.PORT || "8787") + "/api/connector/status";
async function statusPing() {
  try {
    await fetch(statusEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-event-token": token },
      body: JSON.stringify({ connected, roomId, queue: outbox.count() }),
      signal: AbortSignal.timeout(2500)
    });
  } catch { /* reported by backend TTL */ }
}
const heartbeat = setInterval(() => { void statusPing(); }, 5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (outbox.count() && !stopping) {
      const next = outbox.peek();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-event-token": token },
          body: JSON.stringify(next),
          signal: AbortSignal.timeout(5000)
        });
        if (response.status === 429 || response.ok) { await outbox.ack(); continue; }
        if (response.status === 401 || response.status === 403) {
          console.error("Connector authorization rejected; fix EVENT_TOKEN before retrying.");
          break;
        }
        throw new Error("HTTP " + response.status);
      } catch (err) {
        console.error("Local event delivery failed:", err.message);
        await sleep(2000);
      }
    }
  } finally { draining = false; }
}
async function enqueue(type, data) {
  const event = fromTikTokEvent(type, data);
  if (!event) return;
  try {
    if (!await outbox.enqueue(event)) {
      console.error("Outbox full; cannot enqueue", event.type);
      return;
    }
    void drain();
  } catch (error) { console.error("Outbox write failed:", error.message); }
}
async function shutdown() {
  stopping = true;
  clearInterval(heartbeat);
  connected = false;
  await statusPing();
  try { await connection?.disconnect(); } catch {}
  await outbox.flush();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

let retry = 2000;
void drain();
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
    connected = true; roomId = String(state.roomId || "");
    await statusPing();
    console.warn("TikTok connection ended:", await disconnected);
  } catch (e) {
    console.error("TikTok connect failed:", e.message);
  } finally {
    connected = false; roomId = "";
    void statusPing();
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
