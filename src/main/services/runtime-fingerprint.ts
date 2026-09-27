import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
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
    const sourceSha256=await fingerprintWanGpSourceTree(machine.wangp.rootPath,machine.wangp.entrypoint);
    const runtimeVersion = image ? `docker:${image}${imageId ? `@${imageId}` : ''}` : 'docker:unconfigured';
    return {
      backend,
      executionMode: 'docker',
      runtimeVersion,
      runtimeSha256:sourceSha256,
      environmentSha256: sha256Json({
        backend, executionMode:'docker', runtimeVersion, sourceSha256,
        profile:machine.wangp.profile, attention:machine.wangp.attention,
        projectMount:machine.wangp.docker.projectMount, wangpMount:machine.wangp.docker.wangpMount
      })
    };
  }

  const runtimeSha256=await fingerprintWanGpSourceTree(machine.wangp.rootPath,machine.wangp.entrypoint);
  const [gitCommit, pythonVersion, torchInfo, packages] = await Promise.all([
    commandText('git',['-C',machine.wangp.rootPath,'rev-parse','HEAD']),
    requiredCommandText(machine.wangp.pythonPath,['--version'],'WanGP Python version'),
    requiredCommandText(machine.wangp.pythonPath,['-c',"import json,torch; print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'cuda_available':torch.cuda.is_available(),'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"],'WanGP PyTorch/CUDA runtime'),
    requiredCommandText(machine.wangp.pythonPath,['-m','pip','freeze','--disable-pip-version-check'],'WanGP Python package set',20_000,true)
  ]);
  const packagesSha256=createHash('sha256').update(packages.split(/\r?\n/).filter(Boolean).sort().join('\n')).digest('hex');
  const runtimeVersion = [gitCommit && `git:${gitCommit}`, pythonVersion, torchInfo].filter(Boolean).join(' · ');
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

const WANGP_SOURCE_EXTENSIONS=new Set(['.py','.pyi','.json','.yaml','.yml','.toml','.cfg','.ini','.txt','.c','.cc','.cpp','.h','.hpp','.cu','.cuh']);
const WANGP_SOURCE_SKIP_DIRS=new Set(['.git','.venv','venv','env','models','model','checkpoints','checkpoint','ckpts','loras','lora','outputs','output','cache','.cache','__pycache__','node_modules']);

export async function fingerprintWanGpSourceTree(rootPath:string,entrypointName:string):Promise<string>{
  const root=resolve(rootPath);if(!rootPath.trim())throw new Error('WanGP root path is not configured.');
  const entrypoint=resolve(root,entrypointName);
  await stat(entrypoint);
  const records:Array<{path:string;sha256:string;size:number}>=[],pending=[root];let entriesSeen=0,totalSourceBytes=0;
  while(pending.length){
    const dir=pending.pop()!;
    for(const entry of await readdir(dir,{withFileTypes:true})){
      entriesSeen+=1;if(entriesSeen>50_000)throw new Error('WanGP source tree exceeds the 50,000-entry fingerprint safety limit.');
      const lower=entry.name.toLowerCase(),path=join(dir,entry.name);
      if(entry.isDirectory()){if(!WANGP_SOURCE_SKIP_DIRS.has(lower))pending.push(path);continue;}
      if(entry.isSymbolicLink()){
        if(WANGP_SOURCE_SKIP_DIRS.has(lower))continue;
        throw new Error(`WanGP source fingerprint refuses symbolic-link source entries: ${path}`);
      }
      if(!entry.isFile()||!WANGP_SOURCE_EXTENSIONS.has(extname(lower)))continue;
      const info=await stat(path);totalSourceBytes+=info.size;
      if(totalSourceBytes>512*1024*1024)throw new Error('WanGP source/config files exceed the 512 MiB fingerprint safety limit.');
      records.push({path:relative(root,path).replace(/\\/g,'/'),sha256:await sha256File(path),size:info.size});
    }
  }
  if(!records.some(record=>resolve(root,record.path)===entrypoint))records.push({path:relative(root,entrypoint).replace(/\\/g,'/'),sha256:await sha256File(entrypoint),size:(await stat(entrypoint)).size});
  records.sort((a,b)=>a.path.localeCompare(b.path));
  return sha256Json(records);
}

async function commandText(command:string,args:string[],timeout=10_000,full=false):Promise<string>{
  try {
    const { stdout, stderr } = await execFileAsync(command,args,{timeout,maxBuffer:8*1024*1024});
    const out=stdout.trim(),err=stderr.trim();
    if(full)return out;
    return (out||err).split(/\r?\n/).filter(Boolean)[0] || '';
  } catch { return ''; }
}

async function requiredCommandText(command:string,args:string[],label:string,timeout=10_000,full=false):Promise<string>{
  try{
    const {stdout,stderr}=await execFileAsync(command,args,{timeout,maxBuffer:8*1024*1024});
    const out=stdout.trim(),err=stderr.trim(),value=full?out:(out||err).split(/\r?\n/).filter(Boolean)[0]||'';
    if(!value)throw new Error('command returned no usable output');
    return value;
  }catch(error){throw new Error(`${label} could not be fingerprinted: ${error instanceof Error?error.message:String(error)}`);}
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
