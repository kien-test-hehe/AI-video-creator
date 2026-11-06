import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Single-process durable connector outbox. Bounds disk use and replay age.
 * Not a payment ledger; no exactly-once guarantee across remote delivery.
 */
export function createOutbox({ file = ".local/connector-outbox.json", max = 500, retentionMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const path = resolve(file);
  let records = [];
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw.version !== 1 || !Array.isArray(raw.records)) throw Error("Invalid outbox format");
    records = raw.records.filter((r) => r && typeof r === "object" && r.event && typeof r.createdAt === "number");
  }
  let writing = Promise.resolve();
  function prune() {
    records = records.filter((item) => now() - item.createdAt < retentionMs);
  }
  async function save() {
    const snapshot = JSON.stringify({ version: 1, records });
    writing = writing.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = path + "." + process.pid + ".tmp";
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, path);
    });
    return writing;
  }
  return {
    count: () => records.length,
    peek: () => records[0]?.event || null,
    async enqueue(event) {
      prune();
      if (records.length >= max) {
        const index = records.findIndex((r) => r.event.type === "like");
        if (index >= 0) records.splice(index, 1);
        else return false;
      }
      const stable = { ...event, id: event.id || "local-" + randomUUID() };
      records.push({ event: stable, createdAt: now() });
      await save();
      return true;
    },
    async ack() {
      if (records.length) records.shift();
      await save();
    },
    async pruneExpired() {
      prune();
      await save();
    },
    flush: () => writing
  };
}
