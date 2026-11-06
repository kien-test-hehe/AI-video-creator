/**
 * OBS WebSocket v5 integration. Uses optional MIT-licensed obs-websocket-js package.
 * All control connects to localhost; no stream keys are requested or logged.
 */
export const SCENE_NAME = "Interactive LIVE";
export const INPUT_NAME = "Interactive LIVE Overlay";
export function overlaySettings({ port = 8787, width = 1080, height = 1920 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid port");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320 || width > 4096 || height > 4096) throw Error("Invalid canvas");
  return {
    url: "http://127.0.0.1:" + port + "/?view=overlay",
    width, height, fps: 30, reroute_audio: true
  };
}
export async function withOBS(operation, { url = process.env.OBS_WS_URL || "ws://127.0.0.1:4455", password = process.env.OBS_WS_PASSWORD || "" } = {}) {
  const parsed = new URL(url);
  if (!["ws:", "wss:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw Error("OBS websocket must be localhost");
  }
  const { OBSWebSocket } = await import("obs-websocket-js");
  const obs = new OBSWebSocket();
  await obs.connect(url, password);
  try { return await operation(obs); }
  finally { await obs.disconnect(); }
}
export async function inspectOBS(obs) {
  const [scene, stream, stats] = await Promise.all([
    obs.call("GetSceneList"), obs.call("GetStreamStatus"), obs.call("GetStats")
  ]);
  return {
    scenes: scene.scenes.map((v) => v.sceneName),
    currentScene: scene.currentProgramSceneName,
    streaming: Boolean(stream.outputActive),
    streamSeconds: stream.outputDuration || 0,
    missedFrames: stats.renderSkippedFrames || 0,
    averageFrameRenderTime: stats.averageFrameRenderTime || 0
  };
}
export async function configureOBS(obs, { port = 8787 } = {}) {
  const scenes = await obs.call("GetSceneList");
  if (!scenes.scenes.some((scene) => scene.sceneName === SCENE_NAME)) {
    await obs.call("CreateScene", { sceneName: SCENE_NAME });
  }
  const inputs = await obs.call("GetInputList");
  const settings = overlaySettings({ port });
  if (!inputs.inputs.some((input) => input.inputName === INPUT_NAME)) {
    await obs.call("CreateInput", {
      sceneName: SCENE_NAME, inputName: INPUT_NAME, inputKind: "browser_source",
      inputSettings: settings, sceneItemEnabled: true
    });
  } else {
    await obs.call("SetInputSettings", { inputName: INPUT_NAME, inputSettings: settings, overlay: true });
    const items = await obs.call("GetSceneItemList", { sceneName: SCENE_NAME });
    if (!items.sceneItems.some((item) => item.sourceName === INPUT_NAME)) {
      await obs.call("CreateSceneItem", { sceneName: SCENE_NAME, sourceName: INPUT_NAME, sceneItemEnabled: true });
    }
  }
  return { sceneName: SCENE_NAME, inputName: INPUT_NAME, browserUrl: settings.url };
}
