import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { withOBS, inspectOBS } from "../obs.mjs";
const report = {};
function checkBinary(bin, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore", shell: false });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
const port = Number(process.env.PORT || 8787);
report.node22 = Number(process.versions.node.split(".")[0]) >= 22;
report.blender = await checkBinary("blender", ["--version"]);
report.ffmpeg = await checkBinary("ffmpeg", ["-version"]);
report.nvidiaSmi = await checkBinary("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
try {
  const response = await fetch("http://127.0.0.1:" + port + "/health", { signal: AbortSignal.timeout(1500) });
  report.localServer = response.ok;
} catch { report.localServer = false; }
try {
  const details = await withOBS(inspectOBS);
  report.obsWebsocket = true;
  report.obsStreaming = details.streaming;
  report.obsScene = details.currentScene;
} catch { report.obsWebsocket = false; }
report.tiktokUsernameConfigured = Boolean(process.env.TIKTOK_USERNAME);
report.eventTokenConfigured = Boolean(process.env.EVENT_TOKEN);
report.aiOptIn = process.env.AI_ENABLED === "1";
report.aiModelConfigured = Boolean(process.env.AI_MODEL);
report.piperVoiceConfigured = Boolean(process.env.PIPER_MODEL);
try { report.piperModelExists = Boolean(process.env.PIPER_MODEL && (await stat(process.env.PIPER_MODEL)).isFile()); }
catch { report.piperModelExists = false; }
console.log(JSON.stringify(report, null, 2));
console.log("\nDiagnostic only. No LIVE operation, RTMP access or OBS configuration was changed.");
if (!report.node22 || !report.localServer) process.exitCode = 1;
