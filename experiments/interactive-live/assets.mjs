import { readFile, stat, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { SLOT_IDS } from "./world.mjs";
const MAX_ASSET_SIZE = 30 * 1024 * 1024;
export function createAssetLibrary(directory = ".local/assets") {
  const root = resolve(directory);
  function pathOf(id) {
    if (!SLOT_IDS.includes(id)) throw Error("Unknown asset slot");
    return resolve(root, id + ".glb");
  }
  async function list() {
    return Promise.all(SLOT_IDS.map(async (id) => {
      try {
        const size = (await stat(pathOf(id))).size;
        return { id, present: true, size };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { id, present: false, size: 0 };
      }
    }));
  }
  function verify(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.length > MAX_ASSET_SIZE) throw Error("Invalid GLB size");
    // Binary glTF format header: magic glTF, version 2, complete declared length.
    if (bytes.toString("ascii", 0, 4) !== "glTF" ||
        bytes.readUInt32LE(4) !== 2 ||
        bytes.readUInt32LE(8) !== bytes.length) throw Error("Expected valid GLB 2.0 header");
  }
  return {
    list, verify, maxSize: MAX_ASSET_SIZE,
    async read(id) {
      return readFile(pathOf(id));
    },
    async put(id, bytes) {
      verify(bytes);
      const path = pathOf(id);
      await mkdir(root, { recursive: true });
      const tmp = path + "." + process.pid + ".tmp";
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, path);
      return { id, size: bytes.length };
    },
    async remove(id) {
      try { await unlink(pathOf(id)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
}
