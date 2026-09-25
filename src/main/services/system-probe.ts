import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings, FilmProject, SystemProbe } from '../../shared/types';
import { ComfyClient } from './comfy-client';
import { deriveHardwarePlan } from './hardware-advisor';
import { fingerprintRuntime } from './runtime-fingerprint';

const execFileAsync=promisify(execFile);

async function probeGpu():Promise<SystemProbe['gpu']>{
  try{
    const{stdout}=await execFileAsync('nvidia-smi',['--query-gpu=name,memory.total,memory.free,driver_version,compute_cap','--format=csv,noheader,nounits'],{timeout:5000});
    const[name,total,free,driver,computeCapability]=stdout.trim().split(/\r?\n/)[0].split(',').map(v=>v.trim());
    let cudaVersion:string|undefined;
    try{
      const full=(await execFileAsync('nvidia-smi',[],{timeout:5000})).stdout;
      cudaVersion=full.match(/CUDA Version:\s*([0-9.]+)/i)?.[1];
    }catch{}
    return{name,totalVramMb:Number(total),freeVramMb:Number(free),driver,computeCapability,cudaVersion};
  }catch{return undefined;}
}

async function probeCpu():Promise<SystemProbe['cpu']>{
  const list=cpus(),model=list[0]?.model?.trim()||'Unknown CPU';
  let physicalCores:number|undefined;
  if(process.platform==='win32'){
    try{
      const{stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'],{timeout:5000});
      const n=Number(stdout.trim());if(Number.isFinite(n)&&n>0)physicalCores=n;
    }catch{}
  }
  return{model,logicalCores:list.length,physicalCores};
}

async function probeFfmpeg(machine:AppMachineSettings):Promise<SystemProbe['ffmpeg']>{
  let available=false,version:string|undefined,ffprobeAvailable=false,encoderAvailable=false;
  try{const{stdout,stderr}=await execFileAsync(machine.ffmpeg.path,['-version'],{timeout:5000});available=true;version=`${stdout}\n${stderr}`.split('\n').find(Boolean)?.trim();}catch{}
  try{await execFileAsync(machine.ffmpeg.ffprobePath,['-version'],{timeout:5000});ffprobeAvailable=true;}catch{}
  if(available){
    try{const{stdout}=await execFileAsync(machine.ffmpeg.path,['-hide_banner','-encoders'],{timeout:8000});encoderAvailable=machine.ffmpeg.preferredH264Encoder==='libx264'?/\blibx264\b/.test(stdout):/\bh264_nvenc\b/.test(stdout);}catch{}
  }
  return{available,version,ffprobeAvailable,encoderAvailable};
}

async function probeDocker(machine:AppMachineSettings):Promise<SystemProbe['docker']>{
  try{
    const{stdout}=await execFileAsync(machine.wangp.docker.command,['version','--format','{{.Server.Version}}'],{timeout:8000});
    let gpuAccessible:boolean|undefined;
    try{const{stdout:info}=await execFileAsync(machine.wangp.docker.command,['info','--format','{{json .Runtimes}}'],{timeout:8000});gpuAccessible=/nvidia/i.test(info);}catch{}
    return{available:true,version:stdout.trim(),gpuAccessible};
  }catch(error){return{available:false,error:error instanceof Error?error.message:String(error)};}
}

async function nativePythonInfo(pythonPath:string):Promise<{pythonVersion?:string;torchVersion?:string;torchCudaVersion?:string;cudaAvailable?:boolean;torchError?:string}>{
  const code="import json,sys; d={'pythonVersion':sys.version.split()[0]};\ntry:\n import torch; d.update(torchVersion=torch.__version__,torchCudaVersion=torch.version.cuda,cudaAvailable=torch.cuda.is_available())\nexcept Exception as e: d.update(torchError=str(e))\nprint(json.dumps(d))";
  try{const{stdout}=await execFileAsync(pythonPath,['-c',code],{timeout:20_000,maxBuffer:2*1024*1024});return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)||'{}');}
  catch{
    try{const{stdout,stderr}=await execFileAsync(pythonPath,['--version'],{timeout:5000});return{pythonVersion:`${stdout}\n${stderr}`.trim().replace(/^Python\s+/i,'')};}catch{return{};}
  }
}

async function probeWanGp(machine:AppMachineSettings):Promise<SystemProbe['wangp']>{
  const cfg=machine.wangp;
  if(cfg.executionMode==='docker'){
    if(!cfg.docker.image.trim())return{configured:false,available:false,executionMode:'docker',rootPath:cfg.rootPath,error:'Docker image not configured.'};
    const docker=await probeDocker(machine);
    if(!docker?.available)return{configured:true,available:false,executionMode:'docker',rootPath:cfg.rootPath,error:docker?.error||'Docker unavailable.'};
    try{
      const fakeProfile={runtime:'wangp',workflowFormat:'wangp-settings'} as any;
      const fp=await fingerprintRuntime(machine,fakeProfile);
      return{configured:true,available:true,executionMode:'docker',rootPath:cfg.rootPath,entrypoint:cfg.entrypoint,pythonPath:'python',runtimeVersion:fp.runtimeVersion};
    }catch(error){return{configured:true,available:false,executionMode:'docker',rootPath:cfg.rootPath,error:error instanceof Error?error.message:String(error)};}
  }
  if(!cfg.rootPath.trim())return{configured:false,available:false,executionMode:'native',rootPath:''};
  try{
    const fakeProfile={runtime:'wangp',workflowFormat:'wangp-settings'} as any;
    const[fp,py]=await Promise.all([fingerprintRuntime(machine,fakeProfile),nativePythonInfo(cfg.pythonPath)]);
    if(!fp.runtimeSha256)return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,error:'WanGP entrypoint is missing or unreadable.',...py};
    if(!py.torchVersion)return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,entrypoint:cfg.entrypoint,pythonPath:cfg.pythonPath,runtimeVersion:fp.runtimeVersion,error:`WanGP Python cannot import PyTorch: ${py.torchError||'unknown error'}`,...py};
    if(py.cudaAvailable!==true)return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,entrypoint:cfg.entrypoint,pythonPath:cfg.pythonPath,runtimeVersion:fp.runtimeVersion,error:'PyTorch is installed but CUDA is not available in the WanGP environment.',...py};
    return{configured:true,available:true,executionMode:'native',rootPath:cfg.rootPath,entrypoint:cfg.entrypoint,pythonPath:cfg.pythonPath,runtimeVersion:fp.runtimeVersion,...py};
  }catch(error){return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,error:error instanceof Error?error.message:String(error)};}
}

async function probeDisk(project:FilmProject):Promise<SystemProbe['disk']>{
  try{const stats=await statfs(project.rootPath);return{path:project.rootPath,freeBytes:Number(stats.bavail)*Number(stats.bsize),totalBytes:Number(stats.blocks)*Number(stats.bsize)};}catch{return undefined;}
}

async function probeCapCut(project:FilmProject):Promise<SystemProbe['capcut']>{
  const configuredTier=project.settings.capcut.pro?'pro':'free';
  if(process.platform!=='win32')return{installed:false,configuredTier};
  const env=process.env,candidates=[
    env.LOCALAPPDATA?join(env.LOCALAPPDATA,'CapCut','Apps','CapCut.exe'):'',
    env.LOCALAPPDATA?join(env.LOCALAPPDATA,'CapCut','CapCut.exe'):'',
    env.ProgramFiles?join(env.ProgramFiles,'CapCut','CapCut.exe'):'',
    env['ProgramFiles(x86)']?join(env['ProgramFiles(x86)']!,'CapCut','CapCut.exe'):''
  ].filter(Boolean);
  const direct=await firstExisting(candidates);if(direct)return{installed:true,path:direct,configuredTier};
  if(env.LOCALAPPDATA){
    const apps=join(env.LOCALAPPDATA,'CapCut','Apps');
    try{
      for(const entry of await readdir(apps,{withFileTypes:true})){
        if(!entry.isDirectory())continue;
        const found=await firstExisting([join(apps,entry.name,'CapCut.exe'),join(apps,entry.name,'Apps','CapCut.exe')]);if(found)return{installed:true,path:found,configuredTier};
      }
    }catch{}
  }
  return{installed:false,configuredTier};
}

async function firstExisting(paths:string[]):Promise<string|undefined>{
  for(const path of paths){try{await import('node:fs/promises').then(fs=>fs.access(path));return path;}catch{}}
  return undefined;
}

export async function probeSystem(project:FilmProject,machine:AppMachineSettings):Promise<SystemProbe>{
  const[cpu,gpu,ffmpeg,comfy,wangp,docker,disk,capcut]=await Promise.all([
    probeCpu(),probeGpu(),probeFfmpeg(machine),new ComfyClient(machine.comfy.url,true).ping(),probeWanGp(machine),
    machine.wangp.executionMode==='docker'?probeDocker(machine):Promise.resolve(undefined),probeDisk(project),probeCapCut(project)
  ]);
  const base={
    platform:{platform:platform(),release:release(),arch:arch(),hostname:hostname()},
    cpu,gpu,memory:{totalMb:Math.round(totalmem()/1024/1024),freeMb:Math.round(freemem()/1024/1024)},disk,ffmpeg,capcut,comfy,wangp,docker
  };
  return{...base,hardwarePlan:deriveHardwarePlan(base)};
}
