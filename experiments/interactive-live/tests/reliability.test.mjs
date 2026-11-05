import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../rules.mjs";
import { createSnapshotStore } from "../storage.mjs";
import { createModerationPolicy } from "../moderation.mjs";

test("state and recent IDs recover; no user message stored on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interactive-live-"));
  try {
    const store = createSnapshotStore(join(dir, "runtime-state.json"));
    const original = createEngine();
    original.receive({ type: "comment", id: "comment-55", user: "Visitor", message: "private text" });
    original.receive({ type: "gift", id: "gift-99", user: "Visitor" });
    store.schedule(original.persisted());
    await store.flush();
    const recovered = createEngine({
      initialState: store.load().state,
      initialIds: store.load().recentEventIds
    });
    assert.equal(recovered.snapshot().gifts, 1);
    assert.equal(recovered.snapshot().wishes, 1);
    assert.equal(recovered.snapshot().lastMessage, "");
    assert.equal(recovered.receive({ type: "gift", id: "gift-99" }).duplicate, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("comment cooldown and URL redaction", () => {
  let clock = 10_000;
  const policy = createModerationPolicy({ now: () => clock, commentCooldownMs: 2500 });
  const first = policy.check({ type: "comment", user: "Alice", message: "hello https://example.org" });
  assert.equal(first.allowed, true);
  assert.equal(first.event.message, "hello [link hidden]");
  assert.equal(policy.check({ type: "comment", user: "Alice", message: "spam" }).allowed, false);
  clock += 2501;
  assert.equal(policy.check({ type: "comment", user: "Alice", message: "welcome" }).allowed, true);
  assert.equal(policy.check({ type: "gift", user: "Alice" }).allowed, true);
});
