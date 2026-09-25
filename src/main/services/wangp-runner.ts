import { spawn, type ChildProcess } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { FilmProject } from '../../shared/types';

export interface WanGpRunOptions {
  settingsPath: string;
  outputDir: string;
  onLog?: (line: string) => void;
  dryRun?: boolean;
}

export function wangpEntrypoint(project: FilmProject): string {
  return resolve(project.settings.wangp.rootPath, project.settings.wangp.entrypoint || 'wgp.py');
}

export async function probeWanGp(project: FilmProject): Promise<{ configured: boolean; available: boolean; rootPath: string; entrypoint?: string; pythonPath?: string; error?: string }> {
  const cfg = project.settings.wangp;
  if (!cfg.rootPath.trim()) return { configured: false, available: false, rootPath: '' };
  const entrypoint = wangpEntrypoint(project);
  try {
    await access(entrypoint);
    return { configured: true, available: true, rootPath: cfg.rootPath, entrypoint, pythonPath: cfg.pythonPath || 'python' };
  } catch (error) {
    return { configured: true, available: false, rootPath: cfg.rootPath, entrypoint, pythonPath: cfg.pythonPath || 'python', error: error instanceof Error ? error.message : String(error) };
  }
}

export function startWanGp(project: FilmProject, options: WanGpRunOptions): ChildProcess {
  const cfg = project.settings.wangp;
  if (!cfg.rootPath.trim()) throw new Error('WanGP root path is not configured.');
  const args = [wangpEntrypoint(project), '--process', options.settingsPath, '--output-dir', options.outputDir, '--profile', String(cfg.profile || 4), '--verbose', '1'];
  if (options.dryRun) args.push('--dry-run');
  if (cfg.attention && cfg.attention !== 'auto') args.push('--attention', cfg.attention);
  const child = spawn(cfg.pythonPath || 'python', args, { cwd: cfg.rootPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const forward = (chunk: Buffer) => chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(line => options.onLog?.(line));
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  return child;
}

export async function waitWanGp(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`WanGP exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`));
    });
  });
}

const MEDIA_EXT = new Set(['.mp4','.mov','.webm','.mkv','.avi','.png','.jpg','.jpeg','.webp','.wav','.mp3','.flac','.m4a','.aac']);
export async function collectWanGpOutputs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const lower = entry.name.toLowerCase();
        const dot = lower.lastIndexOf('.');
        if (dot >= 0 && MEDIA_EXT.has(lower.slice(dot))) out.push(path);
      }
    }
  };
  await walk(root).catch(() => undefined);
  return out.sort();
}

export function outputMediaType(path: string): 'video'|'image'|'audio'|'unknown' {
  const ext = basename(path).toLowerCase().split('.').pop() || '';
  if (['mp4','mov','webm','mkv','avi'].includes(ext)) return 'video';
  if (['png','jpg','jpeg','webp'].includes(ext)) return 'image';
  if (['wav','mp3','flac','m4a','aac'].includes(ext)) return 'audio';
  return 'unknown';
}
