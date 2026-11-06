import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const SLOT_IDS = Object.freeze([
  "temple", "statue", "monk", "tree-left", "tree-right", "pond",
  "lantern-left", "lantern-right", "decor-a", "decor-b", "decor-c", "decor-d"
]);
const positions = {
  temple: [0, 0, -5], statue: [0, 1, -0.5], monk: [-3, 0, 4],
  "tree-left": [-10, 0, -5], "tree-right": [10, 0, -5],
  pond: [7, 0, 5], "lantern-left": [-8, 0, 3],
  "lantern-right": [8, 0, 1],
  "decor-a": [-5, 0, 7], "decor-b": [5, 0, 7],
  "decor-c": [-11, 0, 4], "decor-d": [11, 0, 4]
};
export const DEFAULT_WORLD = Object.freeze({
  version: 1,
  title: "Temple Garden",
  showGrid: false,
  interactions: { likeThreshold: 100, giftAction: "lantern", followAction: "bow", commentAction: "wish" },
  slots: SLOT_IDS.map((id) => ({
    id, enabled: true, position: positions[id], rotationY: 0, scale: 1
  }))
});

const actionKinds = new Set(["lotus", "lantern", "bow", "wish", "none"]);
function numeric(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("Invalid " + label);
  }
  return value;
}
export function validateWorld(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== 1) throw new Error("World schema version must equal 1");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 60) throw new Error("Invalid world title");
  if (typeof input.showGrid !== "boolean") throw new Error("showGrid must be boolean");
  const v = input.interactions;
  if (!v || typeof v !== "object") throw new Error("Missing interactions");
  const likeThreshold = numeric(v.likeThreshold, 1, 100000, "likeThreshold");
  const rules = {};
  for (const field of ["giftAction", "followAction", "commentAction"]) {
    if (!actionKinds.has(v[field])) throw new Error("Invalid action " + field);
    rules[field] = v[field];
  }
  if (!Array.isArray(input.slots) || input.slots.length !== SLOT_IDS.length) throw new Error("Invalid slot count");
  const slots = new Map();
  for (const raw of input.slots) {
    if (!raw || !SLOT_IDS.includes(raw.id) || slots.has(raw.id)) throw new Error("Duplicate or invalid slot");
    if (typeof raw.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (!Array.isArray(raw.position) || raw.position.length !== 3) throw new Error("Invalid position");
    slots.set(raw.id, {
      id: raw.id, enabled: raw.enabled,
      position: raw.position.map((n) => numeric(n, -40, 40, "position")),
      rotationY: numeric(raw.rotationY, -6.283185307, 6.283185307, "rotationY"),
      scale: numeric(raw.scale, 0.01, 15, "scale")
    });
  }
  return {
    version: 1, title: input.title.trim(), showGrid: input.showGrid,
    interactions: { likeThreshold, ...rules },
    slots: SLOT_IDS.map((id) => slots.get(id))
  };
}
export function createWorldStore(file = "") {
  const path = file ? resolve(file) : "";
  let current = validateWorld(structuredClone(DEFAULT_WORLD));
  let writing = Promise.resolve();
  if (path && existsSync(path)) current = validateWorld(JSON.parse(readFileSync(path, "utf8")));
  return {
    get: () => structuredClone(current),
    async put(raw) {
      const next = validateWorld(raw);
      if (path) {
        // Serialize simultaneous writes. Replace the last complete file atomically.
        const write = async () => {
          await mkdir(dirname(path), { recursive: true });
          const tmp = path + "." + process.pid + ".tmp";
          await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
          await rename(tmp, path);
        };
        writing = writing.catch(() => {}).then(write);
        await writing;
      }
      current = next;
      return structuredClone(current);
    }
  };
}
