/**
 * Local simulator for a 10-event sequence. Never contacts TikTok.
 * Set EVENT_TOKEN if the local server requires a token.
 */
const endpoint = "http://127.0.0.1:" + (process.env.PORT || "8787") + "/api/events";
const token = process.env.EVENT_TOKEN || "";
const demo = [
  { type: "comment", user: "LotusFan", message: "A peaceful evening" },
  { type: "like", user: "ViewerA", count: 100 },
  { type: "follow", user: "NewFriend" },
  { type: "gift", user: "VisitorB", gift: "Rose", count: 1 },
  { type: "like", user: "ViewerC", count: 100 },
  { type: "gift", user: "VisitorD", gift: "Rose", count: 3 },
  { type: "follow", user: "QuietSun" },
  { type: "like", user: "ViewerE", count: 100 },
  { type: "comment", user: "MoonLight", message: "May all be well" },
  { type: "gift", user: "VisitorF", gift: "Rose", count: 1 }
];
for (const [index, event] of demo.entries()) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-event-token": token } : {}) },
    body: JSON.stringify({ ...event, id: "sample-" + Date.now() + "-" + index }),
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw Error("Event " + index + " failed: " + response.status);
  console.log(index + 1, event.type);
  await new Promise((resolve) => setTimeout(resolve, 650));
}
