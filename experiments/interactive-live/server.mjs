import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, normalizeEvent } from "./rules.mjs";
import { createSnapshotStore } from "./storage.mjs";
import { createModerationPolicy } from "./moderation.mjs";
import { createWorldStore, SLOT_IDS } from "./world.mjs";
import { createAssetLibrary } from "./assets.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".glb": "model/gltf-binary",
  ".woff2": "font/woff2", ".json": "application/json"
};
const json = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(payload));
};
async function readBounded(req, maxBytes) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
function clientError(error) {
  if (error.status) return error.status;
  if (error instanceof SyntaxError || /Invalid |Missing |Unsupported |Expected |Unknown |Empty |must be |schema|World |Duplicate or/.test(error.message)) return 400;
  if (error.code === "ENOENT") return 404;
  return 500;
}
export function makeServer({
  token = process.env.EVENT_TOKEN || "", port = Number(process.env.PORT || 8787),
  stateFile = process.env.STATE_FILE || "",
  worldFile = process.env.WORLD_FILE || "",
  assetsDir = process.env.ASSET_DIR || ".local/assets",
  onEvent = null
} = {}) {
  const store = createSnapshotStore(stateFile);
  const loaded = store.load();
  const world = createWorldStore(worldFile);
  const assets = createAssetLibrary(assetsDir);
  const engine = createEngine({
    initialState: loaded.state, initialIds: loaded.recentEventIds,
    rules: world.get().interactions
  });
  const moderation = createModerationPolicy();
  const metrics = { accepted: 0, rejected: 0, duplicate: 0, errors: 0, startedAt: Date.now() };
  const listeners = new Set();

  function push(type, data) {
    const packet = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const res of listeners) {
      if (res.destroyed || !res.write(packet)) {
        listeners.delete(res);
        res.end();
      }
    }
  }
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const address = server.address();
    const currentPort = typeof address === "object" && address ? address.port : port;
    const origin = req.headers.origin;
    const safeOrigin = !origin || origin === "http://127.0.0.1:" + currentPort || origin === "http://localhost:" + currentPort;
    const authorized = !token || req.headers["x-event-token"] === token;
    const fail = (status, error) => json(res, status, { error });
    if (req.method === "GET" && pathname === "/health") {
      return json(res, 200, { ok: true, clients: listeners.size, uptimeSeconds: Math.floor(process.uptime()) });
    }
    if (req.method === "GET" && pathname === "/api/metrics") {
      return json(res, 200, { ...metrics, clients: listeners.size });
    }
    if (req.method === "GET" && pathname === "/api/state") return json(res, 200, engine.snapshot());
    if (req.method === "GET" && pathname === "/api/world") return json(res, 200, world.get());
    if (req.method === "GET" && pathname === "/api/assets") {
      try { return json(res, 200, await assets.list()); }
      catch { metrics.errors++; return fail(500, "Could not list assets"); }
    }
    if (req.method === "GET" && pathname === "/events") {
      if (listeners.size >= 16) return fail(503, "Overlay client limit");
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
        "connection": "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff"
      });
      listeners.add(res);
      res.write("retry: 2000\n\n");
      res.write("event: state\ndata: " + JSON.stringify(engine.snapshot()) + "\n\n");
      res.write("event: world\ndata: " + JSON.stringify(world.get()) + "\n\n");
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.write(": ping\n\n")) { listeners.delete(res); res.end(); }
      }, 15000);
      req.on("close", () => { clearInterval(heartbeat); listeners.delete(res); });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/assets/") && pathname.endsWith(".glb")) {
      try {
        const id = pathname.slice("/assets/".length, -".glb".length);
        if (!SLOT_IDS.includes(id)) return fail(404, "Unknown slot");
        const bytes = await assets.read(id);
        res.writeHead(200, {
          "content-type": "model/gltf-binary", "content-length": bytes.length,
          "cache-control": "no-store", "x-content-type-options": "nosniff"
        });
        return res.end(bytes);
      } catch (error) { return fail(error.code === "ENOENT" ? 404 : 500, "Asset unavailable"); }
    }
    const mutating = ["POST", "PUT", "DELETE"].includes(req.method);
    if (mutating && !safeOrigin) return fail(403, "Untrusted origin");
    if (mutating && !authorized) return fail(401, "Invalid event token");
    if (req.method === "POST" && pathname === "/api/events") {
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return fail(415, "JSON required");
      try {
        const event = normalizeEvent(JSON.parse((await readBounded(req, 16 * 1024)).toString("utf-8")));
        if (engine.isDuplicate(event.id)) {
          metrics.duplicate++;
          return json(res, 200, { duplicate: true, state: engine.snapshot(), actions: [] });
        }
        const verdict = moderation.check(event);
        if (!verdict.allowed) {
          metrics.rejected++;
          return fail(429, verdict.reason);
        }
        const result = engine.receive(verdict.event);
        metrics.accepted++;
        store.schedule(engine.persisted());
        push("state", result.state);
        for (const action of result.actions) push("action", action);
        if (typeof onEvent === "function") {
          try { void Promise.resolve(onEvent(result, { push })).catch((error) => console.error("onEvent failed:", error.message)); }
          catch (error) { console.error("onEvent failed:", error.message); }
        }
        return json(res, 200, result);
      } catch (error) {
        const status = clientError(error);
        if (status === 500) metrics.errors++;
        return fail(status, status === 500 ? "Event processing failed" : error.message);
      }
    }
    if (req.method === "PUT" && pathname === "/api/world") {
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return fail(415, "JSON required");
      try {
        const next = await world.put(JSON.parse((await readBounded(req, 20 * 1024)).toString("utf8")));
        engine.setRules(next.interactions);
        push("world", next);
        return json(res, 200, next);
      } catch (error) {
        const status = clientError(error);
        if (status === 500) metrics.errors++;
        return fail(status, status === 500 ? "Unable to save world" : error.message);
      }
    }
    const assetMatch = /^\/api\/assets\/([a-z-]+)$/.exec(pathname);
    if (assetMatch && req.method === "POST") {
      if (!["model/gltf-binary", "application/octet-stream"].includes(String(req.headers["content-type"] || "").split(";")[0])) {
        return fail(415, "Upload a binary GLB file");
      }
      try {
        const result = await assets.put(assetMatch[1], await readBounded(req, assets.maxSize));
        push("asset", { id: result.id, updated: Date.now() });
        return json(res, 201, result);
      } catch (error) {
        const status = clientError(error);
        if (status === 500) metrics.errors++;
        return fail(status, status === 500 ? "Asset upload failed" : error.message);
      }
    }
    if (assetMatch && req.method === "DELETE") {
      try {
        await assets.remove(assetMatch[1]);
        push("asset", { id: assetMatch[1], deleted: true, updated: Date.now() });
        return json(res, 200, { deleted: true, id: assetMatch[1] });
      } catch (error) {
        const status = clientError(error);
        if (status === 500) metrics.errors++;
        return fail(status, status === 500 ? "Could not remove asset" : error.message);
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed");
    if (!existsSync(dist)) return fail(503, "Run npm run build first");
    try {
      const decoded = decodeURIComponent(pathname);
      const file = resolve(dist, "." + (decoded === "/" ? "/index.html" : decoded));
      if (file !== dist && !file.startsWith(dist + sep)) return fail(403, "Forbidden");
      if (!(await stat(file)).isFile()) return fail(404, "Not found");
      const content = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      return res.end(req.method === "HEAD" ? undefined : content);
    } catch { return fail(404, "Not found"); }
  });
  server.on("close", () => { void store.flush().catch((error) => console.error("Final snapshot flush failed:", error)); });
  return { server, engine, store, world, assets, metrics, push };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") throw Error("Local-only server; HOST must be loopback");
  if (process.env.LIVE_MODE === "1" && !process.env.EVENT_TOKEN) throw Error("EVENT_TOKEN is required in LIVE_MODE");
  const port = Number(process.env.PORT || 8787);
  makeServer({
    port,
    stateFile: process.env.STATE_FILE || ".local/state.json",
    worldFile: process.env.WORLD_FILE || ".local/world.json",
    assetsDir: process.env.ASSET_DIR || ".local/assets"
  }).server.listen(port, host, () => {
    console.log("Interactive LIVE Studio: http://" + host + ":" + port + "/");
    console.log("OBS scene: http://" + host + ":" + port + "/?view=overlay");
  });
}
