import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings, RenderRuntimeFingerprint, WorkflowProfile } from '../../shared/types';
import { ComfyClient } from './comfy-client';

const execFileAsync = promisify(execFile);

export async function sha256File(path: string): Promise<string> {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, objectKeySorter)).digest('hex');
}

export async function fingerprintRuntime(machine: AppMachineSettings, profile: WorkflowProfile): Promise<RenderRuntimeFingerprint> {
  const backend = profile.runtime ?? (profile.workflowFormat === 'wangp-settings' ? 'wangp' : 'comfyui');
  if (backend === 'comfyui') {
    const client=new ComfyClient(machine.comfy.url,true),ping=await client.ping();
    const runtimeVersion = ping.reachable ? extractComfyVersion(ping.systemStats) : 'offline';
    let nodeCatalogSha256='offline';
    if(ping.reachable){
      try{nodeCatalogSha256=comfyNodeCatalogFingerprint(await client.objectInfo());}
      catch{nodeCatalogSha256='unavailable';}
    }
    const environmentSha256 = sha256Json({
      backend,
      url: new URL(machine.comfy.url).origin,
      runtimeVersion,
      nodeCatalogSha256,
      stableSystem: stableComfySystem(ping.systemStats)
    });
    return { backend, runtimeVersion, environmentSha256 };
  }

  if (machine.wangp.executionMode === 'docker') {
    const image = machine.wangp.docker.image.trim();
    let imageId = '';
    if (image) {
      const { stdout } = await execFileAsync(machine.wangp.docker.command, ['image','inspect','--format','{{.Id}}',image], { timeout: 10_000 });
      imageId = stdout.trim();
      if(!imageId)throw new Error(`Docker image inspect returned no immutable image ID for ${image}.`);
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
  const [gitCommit, pythonVersion, torchInfo, packages] = await Promise.all([
    commandText('git',['-C',machine.wangp.rootPath,'rev-parse','HEAD']),
    commandText(machine.wangp.pythonPath,['--version']),
    commandText(machine.wangp.pythonPath,['-c',"import json,torch; print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'cuda_available':torch.cuda.is_available(),'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"]),
    commandText(machine.wangp.pythonPath,['-m','pip','freeze','--disable-pip-version-check'],20_000,true)
  ]);
  const packagesSha256=packages?createHash('sha256').update(packages.split(/\r?\n/).filter(Boolean).sort().join('\n')).digest('hex'):undefined;
  const runtimeVersion = [gitCommit && `git:${gitCommit}`, pythonVersion, torchInfo].filter(Boolean).join(' · ') || 'native:unknown';
  return {
    backend,
    executionMode: 'native',
    runtimeVersion,
    runtimeSha256,
    environmentSha256: sha256Json({
      backend, executionMode:'native', runtimeVersion, runtimeSha256, packagesSha256,
      profile:machine.wangp.profile, attention:machine.wangp.attention
    })
  };
}

async function commandText(command:string,args:string[],timeout=10_000,full=false):Promise<string>{
  try {
    const { stdout, stderr } = await execFileAsync(command,args,{timeout,maxBuffer:8*1024*1024});
    const out=stdout.trim(),err=stderr.trim();
    if(full)return out;
    return (out||err).split(/\r?\n/).filter(Boolean)[0] || '';
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

export function comfyNodeCatalogFingerprint(objectInfo:unknown):string{
  if(!objectInfo||typeof objectInfo!=='object'||Array.isArray(objectInfo))return'unavailable';
  return sha256Json(objectInfo);
}

function stableComfySystem(stats:unknown):unknown{
  const value=stats as any,system=value?.system??value??{};
  const devices=Array.isArray(value?.devices)?value.devices.map((d:any)=>({name:d?.name,type:d?.type,index:d?.index,total_vram:d?.vram_total??d?.total_vram})):[];
  return{os:system?.os,python_version:system?.python_version,pytorch_version:system?.pytorch_version,embedded_python:system?.embedded_python,comfyui_version:system?.comfyui_version??value?.comfyui_version,devices};
}
