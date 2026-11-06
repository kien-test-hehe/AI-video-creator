import { withOBS, configureOBS, inspectOBS } from "../obs.mjs";

const operation = process.argv[2] || "probe";
const port = Number(process.env.PORT || 8787);
const allowed = new Set(["probe", "setup", "start", "stop"]);
if (!allowed.has(operation)) throw Error("Usage: node scripts/obs.mjs [probe|setup|start|stop]");
await withOBS(async (obs) => {
  if (operation === "probe") {
    console.log(JSON.stringify(await inspectOBS(obs), null, 2));
  } else if (operation === "setup") {
    console.log(JSON.stringify(await configureOBS(obs, { port }), null, 2));
    console.log("OBS scene created. Check browser source, audio routing and stream credentials manually.");
  } else {
    if (process.env.OBS_ALLOW_STREAM_CONTROL !== "1") {
      throw Error("Refusing to control a LIVE stream; explicitly set OBS_ALLOW_STREAM_CONTROL=1");
    }
    const status = await obs.call("GetStreamStatus");
    if (operation === "start" && !status.outputActive) await obs.call("StartStream");
    if (operation === "stop" && status.outputActive) await obs.call("StopStream");
    console.log(JSON.stringify(await inspectOBS(obs), null, 2));
  }
});
