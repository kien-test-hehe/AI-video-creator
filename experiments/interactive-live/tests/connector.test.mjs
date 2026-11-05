import test from "node:test";
import assert from "node:assert/strict";
import { fromTikTokEvent } from "../connectors/event-mapper.mjs";

test("maps comments, follows and per-event likes", () => {
  const user = { uniqueId: "viewer_1" };
  assert.deepEqual(fromTikTokEvent("chat", { msgId: "a", user, comment: "hi" }),
    { type: "comment", id: "a", user: "viewer_1", message: "hi" });
  assert.equal(fromTikTokEvent("follow", { msgId: "b", user }).type, "follow");
  assert.equal(fromTikTokEvent("like", { msgId: "c", user, likeCount: 5, totalLikeCount: 500000 }).count, 5);
});
test("streak gift only emitted at final repeatEnd", () => {
  const base = { msgId: "g1", user: { uniqueId: "Alice" }, giftDetails: { giftType: 1, giftName: "Rose" }, repeatCount: 4 };
  assert.equal(fromTikTokEvent("gift", { ...base, repeatEnd: false }), null);
  const final = fromTikTokEvent("gift", { ...base, repeatEnd: true });
  assert.equal(final.type, "gift");
  assert.equal(final.count, 4);
  assert.equal(final.id, "g1:gift:4");
  assert.equal(fromTikTokEvent("gift", { ...base, repeatEnd: true }).id, final.id);
});
test("non-streak gift emits immediately and bad events ignored", () => {
  assert.equal(fromTikTokEvent("gift", { giftId: 5, repeatCount: 1 }).type, "gift");
  assert.equal(fromTikTokEvent("unknown", {}), null);
});
