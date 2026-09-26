import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMachineSettings, RuntimeBackend, WanGpExecutionMode } from '../../shared/types';
import { ComfyClient, cineforgePromptIdentitiesByMetadata } from './comfy-client';
import { waitForComfyPromptRelease } from './comfy-runner';
import { findExpectedProcessPids, isProcessAlive, killProcessTree } from './process-utils';
import { isWanGpDockerRunning, stopWanGpDocker } from './wangp-runner';

const LEASE_FILE='active-keyframe.v1.json';

export interface KeyframeLease{
  version:1;
  id:string;
  projectId:string;
  runtime:RuntimeBackend;
  runId:string;
  comfyUrl?:string;
  wanGpExecutionMode?:WanGpExecutionMode;
  dockerCommand?:string;
  createdAt:string;
}

interface LeaseEnvelope{version:1;lease:KeyframeLease;mac:string}

export class KeyframeLeaseStore{
  constructor(private readonly userDataDir:string,private readonly key:Buffer){}

  async write(lease:KeyframeLease):Promise<void>{
    await mkdir(this.userDataDir,{recursive:true});
    const file=join(this.userDataDir,LEASE_FILE),temp=`${file}.${process.pid}.tmp`,envelope:LeaseEnvelope={version:1,lease:structuredClone(lease),mac:sign(this.key,lease)};
    await writeFile(temp,JSON.stringify(envelope,null,2),'utf8');
    try{await rename(temp,file);}
    catch(error:any){
      if(!['EEXIST','EPERM','EACCES'].includes(error?.code)){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
      try{await writeFile(file,JSON.stringify(envelope,null,2),'utf8');}finally{await rm(temp,{force:true}).catch(()=>undefined);}
    }
  }

  async read():Promise<KeyframeLease|undefined>{
    const file=join(this.userDataDir,LEASE_FILE);let raw:string;
    try{raw=await readFile(file,'utf8');}catch(error:any){if(error?.code==='ENOENT')return undefined;throw error;}
    const envelope=JSON.parse(raw) as LeaseEnvelope;
    if(envelope?.version!==1||envelope.lease?.version!==1||typeof envelope.mac!=='string')throw new Error('Active keyframe recovery lease is malformed.');
    const expected=Buffer.from(sign(this.key,envelope.lease),'hex'),actual=Buffer.from(envelope.mac,'hex');
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Active keyframe recovery lease failed its installation signature check.');
    return structuredClone(envelope.lease);
  }

  async clear():Promise<void>{await rm(join(this.userDataDir,LEASE_FILE),{force:true});}
}

export async function recoverOrphanedKeyframeLease(store:KeyframeLeaseStore,machine:AppMachineSettings):Promise<void>{
  const lease=await store.read();if(!lease)return;
  if(lease.runtime==='comfyui'){
    const client=new ComfyClient(lease.comfyUrl||machine.comfy.url,true);
    let matches;
    while(true){
      try{
        const[queue,history]=await Promise.all([client.queue(),client.historyAll()]);
        matches=cineforgePromptIdentitiesByMetadata(queue,history,{purpose:'keyframe',submissionId:lease.id});
        break;
      }catch(error){throw new Error(`Cannot verify the stale ComfyUI keyframe lease. Keep CineForge closed until the dedicated ComfyUI instance is reachable or its GPU work is stopped: ${error instanceof Error?error.message:String(error)}`);}
    }
    for(const match of matches.filter(item=>item.state!=='history')){
      try{await client.cancelPrompt(match.promptId);}
      catch{await waitForComfyPromptRelease(client,match.promptId);}
    }
    for(const match of matches)await waitForComfyPromptRelease(client,match.promptId);
  }else{
    const recoveryMachine=structuredClone(machine);
    if(lease.wanGpExecutionMode)recoveryMachine.wangp.executionMode=lease.wanGpExecutionMode;
    if(lease.dockerCommand)recoveryMachine.wangp.docker.command=lease.dockerCommand;
    if(recoveryMachine.wangp.executionMode==='docker'){
      let running:boolean;
      try{running=await isWanGpDockerRunning(recoveryMachine,lease.runId);}
      catch(error){throw new Error(`Cannot verify the stale WanGP Docker keyframe lease. Keep CineForge closed until Docker is reachable or the CineForge keyframe container is stopped: ${error instanceof Error?error.message:String(error)}`);}
      if(running)await stopWanGpDocker(recoveryMachine,lease.runId);
    }else{
      let pids:number[];
      try{pids=await findExpectedProcessPids([lease.runId,'wgp.py']);}
      catch(error){throw new Error(`Cannot verify the stale native WanGP keyframe lease. Keep CineForge closed until process inspection works or the prior keyframe process is stopped: ${error instanceof Error?error.message:String(error)}`);}
      for(const pid of pids)if(isProcessAlive(pid))await killProcessTree(pid);
    }
  }
  await store.clear();
}

function sign(key:Buffer,lease:KeyframeLease):string{return createHmac('sha256',key).update(JSON.stringify(lease)).digest('hex');}
