import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings, FilmProject } from '../../shared/types';
import { mapHostPathToWanGpRuntime } from './runtime-path-mapper';

const execFileAsync=promisify(execFile);

export interface WanGpRunOptions {
  settingsPath:string;
  outputDir:string;
  onLog?:(line:string)=>void;
  dryRun?:boolean;
  runId?:string;
}

export function wangpEntrypoint(machine:AppMachineSettings):string{return resolve(machine.wangp.rootPath,machine.wangp.entrypoint||'wgp.py');}

export async function probeWanGp(machine:AppMachineSettings):Promise<{configured:boolean;available:boolean;executionMode:'native'|'docker';rootPath:string;entrypoint?:string;pythonPath?:string;error?:string}>{
  const cfg=machine.wangp;
  if(cfg.executionMode==='docker'){
    if(!cfg.docker.image.trim())return{configured:false,available:false,executionMode:'docker',rootPath:cfg.rootPath,error:'Docker image is not configured.'};
    return{configured:true,available:true,executionMode:'docker',rootPath:cfg.rootPath,entrypoint:cfg.entrypoint,pythonPath:'python'};
  }
  if(!cfg.rootPath.trim())return{configured:false,available:false,executionMode:'native',rootPath:''};
  const entrypoint=wangpEntrypoint(machine);
  try{await access(entrypoint);return{configured:true,available:true,executionMode:'native',rootPath:cfg.rootPath,entrypoint,pythonPath:cfg.pythonPath||'python'};}
  catch(error){return{configured:true,available:false,executionMode:'native',rootPath:cfg.rootPath,entrypoint,pythonPath:cfg.pythonPath||'python',error:error instanceof Error?error.message:String(error)};}
}

export function startWanGp(project:FilmProject,machine:AppMachineSettings,options:WanGpRunOptions):ChildProcess{
  const cfg=machine.wangp;
  if(cfg.executionMode==='docker')return startDockerWanGp(project,machine,options);
  if(!cfg.rootPath.trim())throw new Error('WanGP root path is not configured.');
  const args=[wangpEntrypoint(machine),'--process',options.settingsPath,'--output-dir',options.outputDir,'--profile',String(cfg.profile||4),'--verbose','1'];
  if(options.dryRun)args.push('--dry-run');if(cfg.attention&&cfg.attention!=='auto')args.push('--attention',cfg.attention);
  return spawnWithLogs(cfg.pythonPath||'python',args,{cwd:cfg.rootPath,onLog:options.onLog});
}

function startDockerWanGp(project:FilmProject,machine:AppMachineSettings,options:WanGpRunOptions):ChildProcess{
  const cfg=machine.wangp;const image=cfg.docker.image.trim();
  if(!image)throw new Error('WanGP Docker image is not configured.');
  if(!cfg.rootPath.trim())throw new Error('WanGP root path is required in Docker mode so models/config can be mounted.');
  const settingsPath=mapHostPathToWanGpRuntime(project,machine,options.settingsPath),outputDir=mapHostPathToWanGpRuntime(project,machine,options.outputDir);
  const entrypoint=`${cfg.docker.wangpMount.replace(/\/+$/,'')}/${cfg.entrypoint}`;
  const containerName=wanGpContainerName(options.runId||basename(options.settingsPath,'.json'));
  const args=['run','--rm','--name',containerName,'--gpus','all','-v',`${project.rootPath}:${cfg.docker.projectMount}`,'-v',`${cfg.rootPath}:${cfg.docker.wangpMount}`,'-w',cfg.docker.wangpMount,image,'python',entrypoint,'--process',settingsPath,'--output-dir',outputDir,'--profile',String(cfg.profile||4),'--verbose','1'];
  if(options.dryRun)args.push('--dry-run');if(cfg.attention&&cfg.attention!=='auto')args.push('--attention',cfg.attention);
  return spawnWithLogs(cfg.docker.command,args,{onLog:options.onLog});
}

function spawnWithLogs(command:string,args:string[],options:{cwd?:string;onLog?:(line:string)=>void}):ChildProcess{
  const child=spawn(command,args,{cwd:options.cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  const forward=(chunk:Buffer)=>chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(line=>options.onLog?.(line));
  child.stdout?.on('data',forward);child.stderr?.on('data',forward);return child;
}

export async function waitWanGp(child:ChildProcess):Promise<void>{await new Promise<void>((resolvePromise,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>code===0?resolvePromise():reject(new Error(`WanGP exited with code ${code??'null'}${signal?` (${signal})`:''}.`)));});}

const MEDIA_EXT=new Set(['.mp4','.mov','.webm','.mkv','.avi','.png','.jpg','.jpeg','.webp','.wav','.mp3','.flac','.m4a','.aac']);
export async function collectWanGpOutputs(root:string):Promise<string[]>{const out:string[]=[];const walk=async(dir:string)=>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else{const lower=entry.name.toLowerCase(),dot=lower.lastIndexOf('.');if(dot>=0&&MEDIA_EXT.has(lower.slice(dot)))out.push(path);}}};await walk(root).catch(()=>undefined);return out.sort();}
export function outputMediaType(path:string):'video'|'image'|'audio'|'unknown'{const ext=basename(path).toLowerCase().split('.').pop()||'';if(['mp4','mov','webm','mkv','avi'].includes(ext))return'video';if(['png','jpg','jpeg','webp'].includes(ext))return'image';if(['wav','mp3','flac','m4a','aac'].includes(ext))return'audio';return'unknown';}


export function wanGpContainerName(runId:string):string{
  const safe=runId.toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'job';
  return `cineforge-${safe}`;
}

export async function isWanGpDockerRunning(machine:AppMachineSettings,runId:string):Promise<boolean>{
  const name=wanGpContainerName(runId);
  try{
    const{stdout}=await execFileAsync(machine.wangp.docker.command,['inspect','-f','{{.State.Running}}',name],{timeout:8000});
    return stdout.trim().toLowerCase()==='true';
  }catch{return false;}
}

export async function stopWanGpDocker(machine:AppMachineSettings,runId:string):Promise<void>{
  const name=wanGpContainerName(runId);
  await execFileAsync(machine.wangp.docker.command,['rm','-f',name],{timeout:15_000}).catch(()=>undefined);
}
