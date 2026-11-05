import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function createSnapshotStore(file = "") {
  const path = file ? resolve(file) : "";
  let pending = null;
  let timer = null;
  let writing = Promise.resolve();
  function load() {
    if (!path || !existsSync(path)) return { state: {}, recentEventIds: [] };
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!data || data.version !== 1 || !data.state || !Array.isArray(data.recentEventIds)) {
      throw Error("Invalid state snapshot: " + path);
    }
    return data;
  }
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!path || !pending) return writing;
    const next = pending;
    pending = null;
    writing = writing.catch((e) => console.error("Previous state write failed:", e)).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = path + "." + process.pid + ".tmp";
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, path);
    });
    return writing;
  }
  function schedule(data) {
    if (!path) return;
    pending = data;
    if (!timer) timer = setTimeout(() => { void flush().catch((e) => console.error("State write failed:", e)); }, 250);
  }
  return { load, schedule, flush };
}
