import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings, RenderRuntimeFingerprint, WorkflowProfile } from '../../shared/types';
import { ComfyClient } from './comfy-client';

const execFileAsync = promisify(execFile);

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, objectKeySorter)).digest('hex');
}

export async function fingerprintRuntime(machine: AppMachineSettings, profile: WorkflowProfile): Promise<RenderRuntimeFingerprint> {
  const backend = profile.runtime ?? (profile.workflowFormat === 'wangp-settings' ? 'wangp' : 'comfyui');
  if (backend === 'comfyui') {
    const ping = await new ComfyClient(machine.comfy.url, true).ping();
    const runtimeVersion = ping.reachable ? extractComfyVersion(ping.systemStats) : 'offline';
    const environmentSha256 = sha256Json({
      backend,
      url: new URL(machine.comfy.url).origin,
      runtimeVersion,
      systemStats: ping.systemStats ?? null
    });
    return { backend, runtimeVersion, environmentSha256 };
  }

  if (machine.wangp.executionMode === 'docker') {
    const image = machine.wangp.docker.image.trim();
    let imageId = '';
    if (image) {
      try {
        const { stdout } = await execFileAsync(machine.wangp.docker.command, ['image','inspect','--format','{{.Id}}',image], { timeout: 10_000 });
        imageId = stdout.trim();
      } catch {}
    }
    const runtimeVersion = image ? `docker:${image}${imageId ? `@${imageId}` : ''}` : 'docker:unconfigured';
    return {
      backend,
      executionMode: 'docker',
      runtimeVersion,
      environmentSha256: sha256Json({
        backend, executionMode:'docker', runtimeVersion,
        profile:machine.wangp.profile, attention:machine.wangp.attention,
        projectMount:machine.wangp.docker.projectMount, wangpMount:machine.wangp.docker.wangpMount
      })
    };
  }

  const entrypoint = resolve(machine.wangp.rootPath, machine.wangp.entrypoint);
  let runtimeSha256: string | undefined;
  try { runtimeSha256 = await sha256File(entrypoint); } catch {}
  const [gitCommit, pythonVersion] = await Promise.all([
    commandText('git',['-C',machine.wangp.rootPath,'rev-parse','HEAD']),
    commandText(machine.wangp.pythonPath,['--version'])
  ]);
  const runtimeVersion = [gitCommit && `git:${gitCommit}`, pythonVersion].filter(Boolean).join(' · ') || 'native:unknown';
  return {
    backend,
    executionMode: 'native',
    runtimeVersion,
    runtimeSha256,
    environmentSha256: sha256Json({
      backend, executionMode:'native', runtimeVersion, runtimeSha256,
      profile:machine.wangp.profile, attention:machine.wangp.attention
    })
  };
}

async function commandText(command:string,args:string[]):Promise<string>{
  try {
    const { stdout, stderr } = await execFileAsync(command,args,{timeout:10_000});
    return `${stdout}\n${stderr}`.trim().split(/\r?\n/).filter(Boolean)[0] || '';
  } catch { return ''; }
}

function extractComfyVersion(stats: unknown): string {
  const value = stats as any;
  return String(value?.system?.comfyui_version ?? value?.comfyui_version ?? value?.system?.version ?? 'unknown');
}

function objectKeySorter(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)));
}
