import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { AppMachineSettings, FilmProject, SystemProbe } from '../../shared/types';
import { ComfyClient } from './comfy-client';
import { fingerprintRuntime } from './runtime-fingerprint';

const execFileAsync=promisify(execFile);

async function probeGpu():Promise<SystemProbe['gpu']>{
  try{
    const{stdout}=await execFileAsync('nvidia-smi',['--query-gpu=name,memory.total,memory.free,driver_version','--format=csv,noheader,nounits'],{timeout:5000});
    const[name,total,free,driver]=stdout.trim().split(',').map(v=>v.trim());
    return{name,totalVramMb:Number(total),freeVramMb:Number(free),driver};
  }catch{return undefined;}
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
    try{
      const{stdout:info}=await execFileAsync(machine.wangp.docker.command,['info','--format','{{json .Runtimes}}'],{timeout:8000});
      gpuAccessible=/nvidia/i.test(info);
    }catch{}
    return{available:true,version:stdout.trim(),gpuAccessible};
  }catch(error){return{available:false,error:error instanceof Error?error.message:String(error)};}
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
    const fp=await fingerprintRuntime(machine,fakeProfile);
    if(!fp.runtimeSha256)return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,error:'WanGP entrypoint is missing or unreadable.'};
    return{configured:true,available:true,executionMode:'native',rootPath:cfg.rootPath,entrypoint:cfg.entrypoint,pythonPath:cfg.pythonPath,runtimeVersion:fp.runtimeVersion};
  }catch(error){return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,error:error instanceof Error?error.message:String(error)};}
}

async function probeDisk(project:FilmProject):Promise<SystemProbe['disk']>{
  try{
    const stats=await statfs(project.rootPath);
    return{path:project.rootPath,freeBytes:Number(stats.bavail)*Number(stats.bsize),totalBytes:Number(stats.blocks)*Number(stats.bsize)};
  }catch{return undefined;}
}

export async function probeSystem(project:FilmProject,machine:AppMachineSettings):Promise<SystemProbe>{
  const [gpu,ffmpeg,comfy,wangp,docker,disk]=await Promise.all([
    probeGpu(),probeFfmpeg(machine),new ComfyClient(machine.comfy.url,true).ping(),probeWanGp(machine),
    machine.wangp.executionMode==='docker'?probeDocker(machine):Promise.resolve(undefined),probeDisk(project)
  ]);
  return{
    gpu,
    memory:{totalMb:Math.round(totalmem()/1024/1024),freeMb:Math.round(freemem()/1024/1024)},
    disk,ffmpeg,comfy,wangp,docker
  };
}
