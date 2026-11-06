import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOutbox } from "../connectors/outbox.mjs";

test("outbox preserves stable IDs across process restart, ACK and expiration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-outbox-"));
  try {
    const file = join(directory, "outbox.json");
    let time = 0;
    const a = createOutbox({ file, now: () => time, retentionMs: 10000, max: 2 });
    assert.equal(await a.enqueue({ type: "gift", user: "A" }), true);
    assert.match(a.peek().id, /^local-/);
    const stableId = a.peek().id;
    assert.equal(await a.enqueue({ type: "like", user: "B" }), true);
    assert.equal(await a.enqueue({ type: "gift", user: "C" }), true); // drops like when saturated
    assert.equal(a.count(), 2);
    const b = createOutbox({ file, now: () => time, retentionMs: 10000, max: 2 });
    assert.equal(b.peek().id, stableId);
    await b.ack();
    assert.equal(b.count(), 1);
    time = 20000;
    await b.pruneExpired();
    assert.equal(b.count(), 0);
  } finally { await rm(directory, { force: true, recursive: true }); }
});
