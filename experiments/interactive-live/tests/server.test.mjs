import test from "node:test";
import assert from "node:assert/strict";
import { makeServer } from "../server.mjs";

test("localhost event API authenticates, broadcasts and exposes state", async (t) => {
  const { server } = makeServer({ token: "sample-secret", port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.ok, true);
  const blocked = await fetch(base + "/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "like" }) });
  assert.equal(blocked.status, 401);
  const badOrigin = await fetch(base + "/api/events", { method: "POST", headers: { "content-type": "application/json", "x-event-token": "sample-secret", origin: "https://attacker.example" }, body: JSON.stringify({ type: "like" }) });
  assert.equal(badOrigin.status, 403);
  const allowed = await fetch(base + "/api/events", { method: "POST", headers: { "content-type": "application/json", "x-event-token": "sample-secret" }, body: JSON.stringify({ type: "like", count: 100 }) });
  assert.equal(allowed.status, 200);
  assert.equal((await (await fetch(base + "/api/state")).json()).likes, 100);
});
