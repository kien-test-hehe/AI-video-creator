import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeServer } from "../server.mjs";

test("world edit, upload, download and delete flow is token protected", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "live-http-"));
  const { server } = makeServer({
    token: "secret", port: 0,
    worldFile: join(dir, "world.json"),
    stateFile: join(dir, "state.json"),
    assetsDir: join(dir, "assets")
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + server.address().port;
  const headers = { "content-type": "application/json", "x-event-token": "secret" };
  const world = await (await fetch(url + "/api/world")).json();
  world.showGrid = true;
  world.slots[0].position[0] = 5;
  world.interactions.likeThreshold = 7;
  assert.equal((await fetch(url + "/api/world", { method: "PUT", headers, body: JSON.stringify(world) })).status, 200);
  assert.equal((await (await fetch(url + "/api/world")).json()).showGrid, true);
  const unauthorized = await fetch(url + "/api/world", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(world) });
  assert.equal(unauthorized.status, 401);
  const malicious = await fetch(url + "/api/world", { method: "PUT", headers, body: JSON.stringify({ ...world, slots: [] }) });
  assert.equal(malicious.status, 400);
  assert.equal((await (await fetch(url + "/api/world")).json()).slots[0].position[0], 5);
  const event = await fetch(url + "/api/events", { method: "POST", headers, body: JSON.stringify({ type: "like", count: 7 }) });
  assert.equal((await event.json()).actions[0].kind, "lotus");
  const bytes = Buffer.alloc(20);
  bytes.write("glTF", 0, "ascii"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(20, 8);
  const upload = await fetch(url + "/api/assets/temple", { method: "POST", headers: { "content-type": "model/gltf-binary", "x-event-token": "secret" }, body: bytes });
  assert.equal(upload.status, 201);
  assert.equal((await (await fetch(url + "/api/assets")).json()).find((x) => x.id === "temple").present, true);
  const asset = await fetch(url + "/assets/temple.glb");
  assert.equal(asset.status, 200);
  assert.equal((await asset.arrayBuffer()).byteLength, 20);
  const invalid = await fetch(url + "/api/assets/%2e%2e", { method: "POST", headers: { "content-type": "model/gltf-binary", "x-event-token": "secret" }, body: bytes });
  assert.notEqual(invalid.status, 201);
  assert.equal((await fetch(url + "/api/assets/temple", { method: "DELETE", headers: { "x-event-token": "secret" } })).status, 200);
  assert.equal((await fetch(url + "/assets/temple.glb")).status, 404);
});
