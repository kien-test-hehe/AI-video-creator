import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FilmProject, SystemProbe } from '../../shared/types';
import { ComfyClient } from './comfy-client';

const execFileAsync = promisify(execFile);

async function probeGpu(): Promise<SystemProbe['gpu']> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'
    ], { timeout: 5000 });
    const [name, total, free, driver] = stdout.trim().split(',').map(v => v.trim());
    return { name, totalVramMb: Number(total), freeVramMb: Number(free), driver };
  } catch {
    return undefined;
  }
}

async function probeFfmpeg(ffmpegPath: string): Promise<SystemProbe['ffmpeg']> {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 5000 });
    const first = `${stdout}\n${stderr}`.split('\n').find(Boolean)?.trim();
    return { available: true, version: first };
  } catch {
    return { available: false };
  }
}

async function probeWanGp(project: FilmProject): Promise<SystemProbe['wangp']> {
  const cfg = project.settings.wangp;
  if (!cfg.rootPath.trim()) return { configured: false, available: false, rootPath: '' };
  const entrypoint = resolve(cfg.rootPath, cfg.entrypoint || 'wgp.py');
  try {
    await access(entrypoint);
    await execFileAsync(cfg.pythonPath || 'python', ['--version'], { timeout: 5000 });
    return { configured: true, available: true, rootPath: cfg.rootPath, entrypoint, pythonPath: cfg.pythonPath || 'python' };
  } catch (error) {
    return { configured: true, available: false, rootPath: cfg.rootPath, entrypoint, pythonPath: cfg.pythonPath || 'python', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function probeSystem(project: FilmProject): Promise<SystemProbe> {
  const [gpu, ffmpeg, comfy, wangp] = await Promise.all([
    probeGpu(),
    probeFfmpeg(project.settings.ffmpegPath),
    new ComfyClient(project.settings.comfyUrl, project.settings.localOnly).ping(),
    probeWanGp(project)
  ]);
  return { gpu, ffmpeg, comfy, wangp };
}
