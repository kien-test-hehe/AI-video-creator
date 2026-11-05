import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "./rules.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function makeServer({ token = process.env.EVENT_TOKEN || "", port = Number(process.env.PORT || 8787) } = {}) {
  const engine = createEngine();
  const listeners = new Set();

  function push(type, data) {
    const packet = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const res of listeners) res.write(packet);
  }

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const fail = (status, message) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    };
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, clients: listeners.size }));
    }
    if (req.method === "GET" && pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(engine.snapshot()));
    }
    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      listeners.add(res);
      res.write("retry: 2000\n\n");
      res.write("event: state\ndata: " + JSON.stringify(engine.snapshot()) + "\n\n");
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => { clearInterval(heartbeat); listeners.delete(res); });
      return;
    }
    if (req.method === "POST" && pathname === "/api/events") {
      const origin = req.headers.origin;
      const address = server.address();
      const currentPort = typeof address === "object" && address ? address.port : port;
      if (origin && origin !== "http://127.0.0.1:" + currentPort && origin !== "http://localhost:" + currentPort) return fail(403, "Untrusted origin");
      if (token && req.headers["x-event-token"] !== token) return fail(401, "Invalid event token");
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return fail(415, "JSON required");
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 16384) return fail(413, "Body too large");
        }
        const result = engine.receive(JSON.parse(body));
        if (!result.duplicate) {
          push("state", result.state);
          for (const action of result.actions) push("action", action);
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(result));
      } catch (error) { return fail(400, error.message); }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed");
    if (!existsSync(dist)) return fail(503, "Run npm run build first");
    try {
      const decoded = decodeURIComponent(pathname);
      const file = resolve(dist, "." + (decoded === "/" ? "/index.html" : decoded));
      if (file !== dist && !file.startsWith(dist + sep)) return fail(403, "Forbidden");
      if (!(await stat(file)).isFile()) return fail(404, "Not found");
      const content = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : content);
    } catch { return fail(404, "Not found"); }
  });

  return { server, engine };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("MVP is local-only; set HOST=127.0.0.1");
  }
  const port = Number(process.env.PORT || 8787);
  makeServer({ port }).server.listen(port, host, () => {
    console.log("Interactive LIVE studio: http://" + host + ":" + port + "/");
    console.log("OBS Browser Source: http://" + host + ":" + port + "/?view=overlay");
  });
}
