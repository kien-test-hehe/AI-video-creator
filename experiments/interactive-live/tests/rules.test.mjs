import test from "node:test";
import assert from "node:assert/strict";
import { createEngine, normalizeEvent } from "../rules.mjs";

test("likes trigger a lotus at every 100 hearts", () => {
  const e = createEngine();
  assert.equal(e.receive({ type: "like", count: 99 }).actions.length, 0);
  assert.equal(e.receive({ type: "like", count: 1 }).actions[0].kind, "lotus");
  assert.equal(e.snapshot().likes, 100);
});
test("replayed event IDs do not duplicate gifts", () => {
  const e = createEngine();
  e.receive({ type: "gift", id: "gift-42", count: 3 });
  const dup = e.receive({ type: "gift", id: "gift-42", count: 3 });
  assert.equal(dup.duplicate, true);
  assert.equal(e.snapshot().gifts, 3);
});
test("comments are length-limited, not executable HTML", () => {
  const e = createEngine();
  const output = e.receive({ type: "comment", user: "<script>", message: "<b>Hello</b>" });
  assert.equal(output.actions[0].kind, "wish");
  assert.equal(e.snapshot().wishes, 1);
  assert.equal(normalizeEvent({ type: "comment", message: "a".repeat(300) }).message.length, 140);
});
test("invalid event types and empty comments fail closed", () => {
  assert.throws(() => normalizeEvent({ type: "reset" }));
  assert.throws(() => normalizeEvent({ type: "comment", message: " " }));
});
test("counters clamp pathological inputs", () => {
  const e = createEngine();
  e.receive({ type: "like", count: 9999999 });
  e.receive({ type: "gift", count: 9999999 });
  assert.equal(e.snapshot().likes, 500);
  assert.equal(e.snapshot().gifts, 50);
});
