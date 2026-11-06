import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

export function createPiperVoice({
  executable = "piper", model = "", directory = ".local/audio", timeoutMs = 20000
} = {}) {
  const folder = resolve(directory);
  if (!model) return null;
  async function speak(text) {
    await mkdir(folder, { recursive: true });
    const name = "speech-" + randomUUID() + ".wav";
    const file = join(folder, name);
    try {
      await new Promise((done, reject) => {
        const child = spawn(executable, ["--model", model, "--output_file", file], {
          stdio: ["pipe", "ignore", "pipe"], shell: false
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 400); });
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
        child.once("error", (err) => { clearTimeout(timer); reject(err); });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 0) done();
          else reject(Error("Piper exited " + code + ": " + stderr.slice(0, 300)));
        });
        child.stdin.on("error", () => {});
        child.stdin.end(text + "\n");
      });
      const names = (await readdir(folder)).filter((item) => /^speech-[a-f0-9-]{36}\.wav$/.test(item)).sort();
      for (const old of names.slice(0, -20)) await unlink(join(folder, old)).catch(() => {});
      return name;
    } catch (error) {
      await unlink(file).catch(() => {});
      throw error;
    }
  }
  async function read(name) {
    if (!/^speech-[a-f0-9-]{36}\.wav$/.test(name)) throw Error("Invalid audio filename");
    return readFile(join(folder, name));
  }
  return { speak, read };
}
