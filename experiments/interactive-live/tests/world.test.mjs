import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORLD, validateWorld, createWorldStore, SLOT_IDS } from "../world.mjs";
import { createAssetLibrary } from "../assets.mjs";
import { createEngine } from "../rules.mjs";

test("world config supports controlled slot transforms and interaction choices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-world-"));
  try {
    const file = join(dir, "world.json");
    const store = createWorldStore(file);
    const updated = store.get();
    updated.showGrid = true;
    updated.slots[0].position = [1.5, 0, -4];
    updated.interactions.likeThreshold = 30;
    updated.interactions.giftAction = "lotus";
    assert.equal((await store.put(updated)).showGrid, true);
    assert.deepEqual(createWorldStore(file).get().slots[0].position, [1.5, 0, -4]);
    const engine = createEngine({ rules: updated.interactions });
    assert.equal(engine.receive({ type: "like", count: 30 }).actions[0].kind, "lotus");
    assert.equal(engine.receive({ type: "gift" }).actions[0].kind, "lotus");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("malformed world configs cannot create unknown asset slots", () => {
  const world = structuredClone(DEFAULT_WORLD);
  assert.equal(SLOT_IDS.length, 12);
  world.slots[0].id = "../secrets";
  assert.throws(() => validateWorld(world));
  world.slots[0].id = "temple";
  world.interactions.giftAction = "shell_exec";
  assert.throws(() => validateWorld(world));
  world.interactions.giftAction = "lantern";
  world.slots[0].position[0] = NaN;
  assert.throws(() => validateWorld(world));
});
test("GLB upload accepts only bounded glTF 2 binaries and fixed slot IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-assets-"));
  try {
    const lib = createAssetLibrary(dir);
    const glb = Buffer.alloc(20);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    await lib.put("temple", glb);
    assert.equal((await lib.read("temple")).length, 20);
    assert.equal((await lib.list()).find((x) => x.id === "temple").present, true);
    await assert.rejects(() => lib.put("../config", glb), /Unknown asset slot/);
    await assert.rejects(() => lib.put("temple", Buffer.alloc(30)), /Expected valid GLB/);
    await lib.remove("temple");
    assert.equal((await lib.list()).find((x) => x.id === "temple").present, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
