/**
 * OPTIONAL unofficial connector. Not part of core dependencies.
 * Before using: npm install tiktok-live-connector@2.5.0
 * Read the connector's modified AGPL terms and TikTok rules first.
 * Never send gifts, comments or automated interactions to TikTok.
 */
const username = (process.env.TIKTOK_USERNAME || "").replace(/^@/, "");
const token = process.env.EVENT_TOKEN;
if (!username) throw new Error("Set TIKTOK_USERNAME (without @)");
if (!token) throw new Error("Set EVENT_TOKEN to protect the local POST endpoint");

const { TikTokLiveConnection, WebcastEvent, ControlEvent } = await import("tiktok-live-connector");
const connection = new TikTokLiveConnection(username);
const endpoint = "http://127.0.0.1:" + (process.env.PORT || "8787") + "/api/events";

async function send(event) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-event-token": token },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) console.error("Event rejected", response.status, await response.text());
  } catch (e) { console.error("Local backend unavailable:", e.message); }
}
const userOf = (data) => data.user?.uniqueId || data.user?.nickname || "Guest";
connection.on(WebcastEvent.CHAT, (data) => {
  void send({ type: "comment", id: String(data.msgId || ""), user: userOf(data), message: data.comment });
});
connection.on(WebcastEvent.LIKE, (data) => {
  void send({ type: "like", id: String(data.msgId || ""), user: userOf(data), count: data.likeCount || 1 });
});
connection.on(WebcastEvent.GIFT, (data) => {
  // Gift streaks send multiple updates. Process only the final event.
  if (data.giftDetails?.giftType === 1 && !data.repeatEnd) return;
  void send({ type: "gift", id: String(data.msgId || ""), user: userOf(data), gift: data.giftDetails?.giftName || String(data.giftId || "Gift"), count: data.repeatCount || 1 });
});
connection.on(WebcastEvent.SOCIAL, (data) => {
  if (String(data.displayType || "").toLowerCase().includes("follow")) {
    void send({ type: "follow", id: String(data.msgId || ""), user: userOf(data) });
  }
});
connection.on(ControlEvent.CONNECTED, () => console.log("Connected to TikTok LIVE:", username));
connection.on(ControlEvent.DISCONNECTED, () => console.warn("TikTok disconnected; restart connector if necessary"));
connection.on(ControlEvent.ERROR, (error) => console.error("TikTok connector error:", error.message));
await connection.connect();
