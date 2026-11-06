import test from "node:test";
import assert from "node:assert/strict";
import { overlaySettings, configureOBS, inspectOBS, SCENE_NAME, INPUT_NAME } from "../obs.mjs";

test("OBS setup is idempotent and only targets local browser input", async () => {
  const calls = [];
  let hasScene = false, hasInput = false;
  const obs = {
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "GetSceneList") return { scenes: hasScene ? [{ sceneName: SCENE_NAME }] : [], currentProgramSceneName: "" };
      if (name === "GetInputList") return { inputs: hasInput ? [{ inputName: INPUT_NAME }] : [] };
      if (name === "GetSceneItemList") return { sceneItems: [{ sourceName: INPUT_NAME }] };
      if (name === "CreateScene") hasScene = true;
      if (name === "CreateInput") hasInput = true;
      if (name === "GetStreamStatus") return { outputActive: false };
      if (name === "GetStats") return { averageFrameRenderTime: 4 };
    }
  };
  const result = await configureOBS(obs, { port: 8787 });
  assert.equal(result.browserUrl, "http://127.0.0.1:8787/?view=overlay");
  await configureOBS(obs, { port: 8787 });
  assert.equal(calls.filter((x) => x.name === "CreateInput").length, 1);
  assert.equal(calls.filter((x) => x.name === "SetInputSettings").length, 1);
  assert.equal(calls.filter((x) => x.name === "StartStream").length, 0);
  assert.equal((await inspectOBS(obs)).streaming, false);
  assert.throws(() => overlaySettings({ port: 70000 }));
});
