import test from "node:test";
import assert from "node:assert/strict";
import { createNarrator } from "../narrator.mjs";
import { createPiperVoice } from "../voice.mjs";

test("AI narrator disabled by default and remote endpoint needs opt-in", async () => {
  const n = createNarrator({ model: "unused" });
  assert.equal(await n.handle({ event: { type: "comment", message: "hello" } }, () => {}), false);
  assert.throws(() => createNarrator({ enabled: true, model: "model", baseUrl: "https://llm.example/v1" }), /approved local/);
  assert.equal(createPiperVoice({}), null);
  await assert.rejects(() => createPiperVoice({ model: "a.onnx" }).read("../secrets.wav"), /Invalid audio filename/);
});
test("AI narration sends one consented comment, honors cooldown and sanitizes output", async () => {
  const calls = [];
  const emitted = [];
  const voice = { speak: async () => "speech-11111111-1111-1111-1111-111111111111.wav" };
  const n = createNarrator({
    enabled: true, model: "local-model", now: () => 1000, voice,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), request: JSON.parse(init.body) });
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "Chúc bạn bình an https://spam.test" } }] }) };
    }
  });
  const event = { event: { type: "comment", user: "Viewer", message: "Hôm nay tôi vui" } };
  assert.equal(await n.handle(event, (kind, data) => emitted.push({ kind, data })), true);
  assert.equal(await n.handle(event, () => {}), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.messages[1].content.includes("Hôm nay tôi vui"), true);
  assert.equal(emitted[0].kind, "narration");
  assert.equal(emitted[0].data.text.includes("https:"), false);
  assert.equal(emitted[1].kind, "speech");
  assert.equal(n.status().narrated, 1);
});
