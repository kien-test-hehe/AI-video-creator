import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  AppMachineSettings, Asset, AssetFingerprint, FilmProject, QueueSnapshot, RenderBatchRequest, RenderJob, RenderOutput, RenderRuntimeFingerprint,
  RenderRequest, Shot, SystemProbe, WorkflowBindingKey, WorkflowProfile
} from '../../shared/types';
import { ProjectService } from './project-service';
import { AppSettingsService } from './app-settings-service';
import { ComfyClient } from './comfy-client';
import { compileProfile, type WorkflowValues } from './workflow-engine';
import { compileWanGpProfile } from './wangp-engine';
import { collectWanGpOutputs, isWanGpDockerRunning, outputMediaType, startWanGp, stopWanGpDocker, waitWanGp } from './wangp-runner';
import { routeWorkflow } from './model-router';
import { collectComfyFileRefs, inferMediaType, uniqueComfyFileRefs } from './comfy-output';
import { waitForComfyCompletion } from './comfy-runner';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertPathInside, assertSafeWritePath } from './path-safety';
import { fingerprintRuntime, sha256File } from './runtime-fingerprint';
import { mapJsonHostPathsForWanGp } from './runtime-path-mapper';
import { JobJournal } from './job-journal';
import { technicalQcVideo } from './technical-qc';
import { isExpectedProcess, isProcessAlive, killProcessTree } from './process-utils';
import { probeSystem } from './system-probe';
import { planShotReferences } from './reference-plan';

const ACTIVE = new Set(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);
const TERMINAL = new Set(['done','failed','cancelled','orphaned']);

export class RenderQueueService extends EventEmitter {
  private pending:string[]=[];
  private runningJobId?:string;
  private cancelled=new Set<string>();
  private wanGpProcesses=new Map<string,ChildProcess>();
  private liveJobs=new Map<string,RenderJob>();
  private lastJournalWrite=new Map<string,number>();
  private journal:JobJournal;

  constructor(private projects:ProjectService,private settings:AppSettingsService){
    super();
    this.journal=new JobJournal(settings.getJournalKey());
  }

  snapshot():QueueSnapshot{
    const project=this.projects.getCurrent();
    const jobs=(project?.renderJobs??[]).map(job=>structuredClone(this.liveJobs.get(job.id)??job));
    for(const live of this.liveJobs.values())if(!jobs.some(j=>j.id===live.id))jobs.push(structuredClone(live));
    jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return{runningJobId:this.runningJobId,jobs};
  }

  isBusy():boolean{return Boolean(this.runningJobId||this.pending.length||this.snapshot().jobs.some(j=>ACTIVE.has(j.status)));}

  async enqueue(request:RenderRequest):Promise<QueueSnapshot>{
    const project=this.requireProject();
    if(project.rootPath!==request.projectRoot)throw new Error('Render request does not match the open project.');
    const shot=project.shots.find(s=>s.id===request.shotId);if(!shot)throw new Error('Shot not found.');
    if(this.hasActiveJobForShot(shot.id))throw new Error(`An active render already exists for ${shot.title}.`);
    const profile=routeWorkflow(project,shot,request.forceWorkflowProfileId);
    const machine=this.settings.get(),probe=await probeSystem(project,machine);
    this.assertExecutionEnvironment(machine,profile,probe);
    const job=await this.createJob(project,shot,profile,machine);
    await this.commitQueuedJobs([job]);return this.snapshot();
  }

  async enqueueBatch(request:RenderBatchRequest):Promise<QueueSnapshot>{
    const project=this.requireProject();if(project.rootPath!==request.projectRoot)throw new Error('Batch render request does not match the open project.');
    const jobs:RenderJob[]=[];
    const machine=this.settings.get(),probe=await probeSystem(project,machine),runtimeFingerprints=new Map<string,Promise<RenderRuntimeFingerprint>>();
    const fingerprintFor=(profile:WorkflowProfile)=>{
      const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
      const key=runtime==='wangp'?`wangp:${machine.wangp.executionMode}`:'comfyui';
      let pending=runtimeFingerprints.get(key);if(!pending){pending=fingerprintRuntime(machine,profile);runtimeFingerprints.set(key,pending);}return pending;
    };
    for(const id of [...new Set(request.shotIds)]){
      const shot=project.shots.find(s=>s.id===id);if(!shot)throw new Error(`Shot not found: ${id}`);
      if(request.skipIfRendered&&shot.latestRenderId)continue;
      if(this.hasActiveJobForShot(shot.id))continue;
      const profile=routeWorkflow(project,shot);
      this.assertExecutionEnvironment(machine,profile,probe);
      jobs.push(await this.createJob(project,shot,profile,machine,await fingerprintFor(profile)));
    }
    if(jobs.length)await this.commitQueuedJobs(jobs);return this.snapshot();
  }

  async retry(jobId:string):Promise<QueueSnapshot>{
    const prior=this.snapshot().jobs.find(j=>j.id===jobId);if(!prior)throw new Error('Render job not found.');
    if(ACTIVE.has(prior.status))throw new Error('Cannot retry an active job.');
    if(!prior.spec)return this.enqueue({projectRoot:this.requireProject().rootPath,shotId:prior.shotId,forceWorkflowProfileId:prior.workflowProfileId});
    const project=this.requireProject(),machine=this.settings.get(),probe=await probeSystem(project,machine);
    this.assertExecutionEnvironment(machine,prior.spec.workflowProfile,probe);
    await this.verifyImmutableSpec(project,prior);
    const now=new Date().toISOString();
    const retry:RenderJob={id:randomUUID(),shotId:prior.shotId,createdAt:now,updatedAt:now,status:'queued',progress:0,message:`Retry of ${prior.id.slice(0,8)} · immutable snapshot`,modelFamily:prior.spec.shot.generation.modelFamily,workflowProfileId:prior.spec.workflowProfile.id,outputs:[],spec:structuredClone(prior.spec)};
    await this.commitQueuedJobs([retry]);return this.snapshot();
  }

  async cancel(jobId:string):Promise<QueueSnapshot>{
    this.requireProject();const job=this.snapshot().jobs.find(j=>j.id===jobId);if(!job)throw new Error('Render job not found.');if(TERMINAL.has(job.status))return this.snapshot();
    const wasRunning=this.runningJobId===jobId;
    const runtime=job.spec?.workflowProfile.runtime??(job.spec?.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(wasRunning&&runtime==='comfyui'&&!this.settings.get().comfy.dedicatedInstance)throw new Error('Safe cancellation is disabled for a shared ComfyUI instance. Configure a dedicated CineForge ComfyUI instance first.');
    this.cancelled.add(jobId);this.pending=this.pending.filter(id=>id!==jobId);
    if(wasRunning){
      if(runtime==='wangp'){
        const machine=this.settings.get(),child=this.wanGpProcesses.get(jobId);
        if(machine.wangp.executionMode==='docker'){
          await stopWanGpDocker(machine,job.id);
          if(child?.pid)await killProcessTree(child.pid);
        }else if(child?.pid)await killProcessTree(child.pid);
        else if(job.backendPid){
          if(!await isExpectedProcess(job.backendPid,[job.id,'wgp.py']))throw new Error('Refusing to kill a recovered PID whose command line no longer matches this WanGP job.');
          await killProcessTree(job.backendPid);
        }
      }else{
        const machine=this.settings.get();
        await new ComfyClient(machine.comfy.url,true).interrupt().catch(()=>undefined);
      }
    }
    await this.updateJob(jobId,{status:'cancelled',progress:0,message:'Cancelled'},true,true);
    await this.projects.mutate(p=>{const shot=p.shots.find(s=>s.id===job.shotId);if(shot)shot.status=shot.latestRenderId?'rendered':'draft';});
    if(!wasRunning){this.cancelled.delete(jobId);void this.pump();}
    return this.snapshot();
  }

  async reconcileAfterProjectOpen():Promise<void>{
    this.pending=[];this.runningJobId=undefined;this.liveJobs.clear();this.cancelled.clear();
    const project=this.projects.getCurrent();if(!project)return;
    const journals=await this.journal.readAll(project.rootPath);const byId=new Map(journals.map(j=>[j.id,j]));
    const jobs=project.renderJobs.map(j=>byId.get(j.id)??j).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    let recoveryStarted=false;
    for(const job of jobs){
      const signed=byId.has(job.id);
      this.liveJobs.set(job.id,structuredClone(job));
      if(TERMINAL.has(job.status))continue;
      if(!signed){
        await this.updateJob(job.id,{status:'orphaned',progress:0,message:'Untrusted runtime state was not resumed',error:'No valid installation-signed job journal exists for this active job. Queue a new render explicitly.'},true,false);
        continue;
      }
      if(['queued','preparing','uploading'].includes(job.status)){
        await this.updateJob(job.id,{status:'queued',progress:0,message:'Recovered after restart · queued again'},true,true);
        this.pending.push(job.id);continue;
      }
      if(!recoveryStarted&&['submitted','running','recovering','stalled','downloading'].includes(job.status)){
        recoveryStarted=true;this.runningJobId=job.id;void this.recoverActiveJob(job.id);continue;
      }
      await this.updateJob(job.id,{status:'queued',progress:0,message:'Recovered after restart · serialized behind the active job'},true,true);
      this.pending.push(job.id);
    }
    this.emitSnapshot();if(!this.runningJobId)void this.pump();
  }

  private async recoverActiveJob(jobId:string):Promise<void>{
    let recoveredJob:RenderJob|undefined;
    try{
      const project=this.requireProject(),job=this.snapshot().jobs.find(j=>j.id===jobId);if(!job?.spec)throw new Error('Recovered job has no immutable spec.');
      recoveredJob=job;
      await this.verifyImmutableSpec(project,job);
      const runtime=job.spec.workflowProfile.runtime??(job.spec.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
      await this.updateJob(jobId,{status:'recovering',message:`Recovering ${runtime} job after restart`},true,true);
      if(runtime==='wangp')await this.recoverWanGp(project,job);
      else await this.recoverComfy(project,job);
    }catch(error){
      if(recoveredJob)await this.cleanupRejectedRecovery(recoveredJob).catch(()=>undefined);
      await this.updateJob(jobId,{status:'orphaned',progress:0,message:'Recovery failed',error:error instanceof Error?error.message:String(error)},true,true);
    }finally{
      this.runningJobId=undefined;this.emitSnapshot();void this.pump();
    }
  }

  private async cleanupRejectedRecovery(job:RenderJob):Promise<void>{
    const runtime=job.spec?.workflowProfile.runtime??(job.spec?.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(runtime!=='wangp')return;
    const machine=this.settings.get();
    if(machine.wangp.executionMode==='docker'){await stopWanGpDocker(machine,job.id);return;}
    if(job.backendPid&&isProcessAlive(job.backendPid)&&await isExpectedProcess(job.backendPid,[job.id,'wgp.py']))await killProcessTree(job.backendPid);
  }

  private async recoverWanGp(project:FilmProject,job:RenderJob):Promise<void>{
    const outputDir=join(project.rootPath,'renders',job.shotId,job.id),machine=this.settings.get();
    const started=Date.now();let stalled=false;
    if(machine.wangp.executionMode==='docker'){
      while(await isWanGpDockerRunning(machine,job.id)){
        if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
        if(Date.now()-started>12*60*60_000&&!stalled){stalled=true;await this.updateJob(job.id,{status:'stalled',message:'Recovered WanGP Docker job has exceeded 12 hours; GPU slot remains reserved until it ends or is cancelled.'},true,true);}
        if(!stalled)await this.updateJob(job.id,{status:'recovering',progress:Math.max(job.progress,0.35),message:'WanGP Docker container is still running · recovered by container identity',lastHeartbeatAt:new Date().toISOString()},false);
        await sleep(5000);
      }
    }else if(job.backendPid&&isProcessAlive(job.backendPid)){
      if(!await isExpectedProcess(job.backendPid,[job.id,'wgp.py']))throw new Error('Recovered PID exists but no longer matches this WanGP job command line.');
      while(isProcessAlive(job.backendPid)){
        if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
        if(Date.now()-started>12*60*60_000&&!stalled){stalled=true;await this.updateJob(job.id,{status:'stalled',message:'Recovered WanGP process has exceeded 12 hours; GPU slot remains reserved until it ends or is cancelled.'},true,true);}
        if(!stalled)await this.updateJob(job.id,{status:'recovering',progress:Math.max(job.progress,0.35),message:'WanGP process is still running · recovered by PID',lastHeartbeatAt:new Date().toISOString()},false);
        await sleep(5000);
      }
    }
    const files=await collectWanGpOutputs(outputDir);if(!files.length)throw new Error('WanGP process ended but no media output was found.');
    await this.finalizeWanGpFiles(project,job,files);
  }

  private async recoverComfy(project:FilmProject,job:RenderJob):Promise<void>{
    if(!job.comfyPromptId)throw new Error('Recovered ComfyUI job has no prompt id.');
    const client=new ComfyClient(this.settings.get().comfy.url,true);
    let history=await client.history(job.comfyPromptId);
    if(!history){
      const queue=await client.queue();
      if(!JSON.stringify(queue).includes(job.comfyPromptId))throw new Error('ComfyUI no longer has this prompt in history or queue.');
      history=await waitForComfyCompletion(client,job.comfyPromptId,{cancelled:()=>this.cancelled.has(job.id),onTick:elapsed=>this.updateJob(job.id,{status:'recovering',message:`ComfyUI recovered · ${elapsed}s`,lastHeartbeatAt:new Date().toISOString()},false)});
    }
    await this.finalizeComfyHistory(project,job,client,history);
  }

  private requireProject():FilmProject{const project=this.projects.getCurrent();if(!project)throw new Error('Open a project first.');return project;}

  private hasActiveJobForShot(shotId:string):boolean{return this.snapshot().jobs.some(j=>j.shotId===shotId&&ACTIVE.has(j.status));}

  private async createJob(project:FilmProject,shot:Shot,profile:WorkflowProfile,machine:AppMachineSettings,knownRuntimeFingerprint?:RenderRuntimeFingerprint):Promise<RenderJob>{
    if(profile.validation?.structuralStatus!=='valid')throw new Error(`Profile “${profile.name}” must be validated in Settings before rendering.`);
    const bindingKeys=new Set(profile.bindings.map(binding=>binding.key));
    const requiredInputs:Array<[boolean,WorkflowBindingKey,string]>=[
      [Boolean(shot.startFrameAssetId),'startImage','start frame'],
      [Boolean(shot.endFrameAssetId),'endImage','end frame'],
      [Boolean(shot.referenceVideoAssetId),'inputVideo','motion/reference video'],
      [Boolean(shot.audioAssetId),'inputAudio','input audio']
    ];
    for(const[present,key,label]of requiredInputs)if(present&&!bindingKeys.has(key))throw new Error(`Shot “${shot.title}” has a ${label}, but profile “${profile.name}” has no ${key} binding. Remove that input or use a compatible workflow so it is not silently ignored.`);
    const workflowPath=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`),`workflow path for ${profile.name}`);
    const workflowSha256=await sha256File(workflowPath);
    if(profile.validation.sourceSha256!==workflowSha256)throw new Error(`Profile “${profile.name}” changed after validation. Revalidate it before rendering.`);
    const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(runtime==='comfyui'&&!machine.comfy.dedicatedInstance)throw new Error('Production ComfyUI jobs require a dedicated CineForge instance because cancellation/recovery uses server-wide queue controls.');
    const assetFingerprints=await this.fingerprintAssets(project,shot);
    const runtimeFingerprint=knownRuntimeFingerprint??await fingerprintRuntime(machine,profile);
    if(!profile.validation?.runtimeFingerprint)throw new Error(`Profile “${profile.name}” has no validated runtime fingerprint. Revalidate it on this workstation before rendering.`);
    if(profile.validation.runtimeFingerprint!==runtimeFingerprint.environmentSha256)throw new Error(`Profile “${profile.name}” was validated against a different local AI runtime. Revalidate it before rendering.`);
    const now=new Date().toISOString();
    return{id:randomUUID(),shotId:shot.id,createdAt:now,updatedAt:now,status:'queued',progress:0,message:'Waiting',modelFamily:shot.generation.modelFamily,workflowProfileId:profile.id,outputs:[],spec:{shot:structuredClone(shot),workflowProfile:structuredClone(profile),effectivePrompt:buildPrompt(project,shot),queuedProjectUpdatedAt:project.updatedAt,workflowSha256,assetFingerprints,runtimeFingerprint,modelFingerprint:profile.modelFingerprint}};
  }

  private assertExecutionEnvironment(machine:AppMachineSettings,profile:WorkflowProfile,probe:SystemProbe):void{
    if(!probe.ffmpeg.available||!probe.ffmpeg.ffprobeAvailable)throw new Error('FFmpeg and FFprobe must be available before queueing because every video output is technically QC-checked.');
    if(probe.disk&&probe.disk.freeBytes<5*1024*1024*1024)throw new Error('Less than 5 GB free on the project volume. Free disk space before rendering.');
    const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(runtime==='wangp'){
      if(!probe.wangp.available)throw new Error(`WanGP is unavailable: ${probe.wangp.error||'not configured'}`);
      if(machine.wangp.executionMode==='docker'){if(!probe.docker?.available)throw new Error(`Docker is unavailable for the selected WanGP runtime: ${probe.docker?.error||'not running'}`);if(probe.docker.gpuAccessible===false)throw new Error('Docker is running but no NVIDIA GPU runtime is available to WanGP.');}
    }else{
      if(!machine.comfy.dedicatedInstance)throw new Error('Production ComfyUI jobs require a dedicated CineForge instance.');
      if(!probe.comfy.reachable)throw new Error(`ComfyUI is unavailable: ${probe.comfy.error||machine.comfy.url}`);
    }
  }

  private async fingerprintAssets(project:FilmProject,shot:Shot):Promise<AssetFingerprint[]>{
    const ids=collectReferencedAssetIds(shot);const out:AssetFingerprint[]=[];
    for(const assetId of ids){
      const asset=project.assets.find(a=>a.id===assetId);if(!asset)throw new Error(`Referenced asset not found: ${assetId}`);
      const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
      out.push({assetId,projectPath:asset.projectPath,sha256:await sha256File(path)});
    }
    return out;
  }

  private async commitQueuedJobs(jobs:RenderJob[]):Promise<void>{
    if(!jobs.length)return;
    await this.projects.mutate(project=>{project.renderJobs.unshift(...[...jobs].reverse());for(const job of jobs){const shot=project.shots.find(s=>s.id===job.shotId);if(shot)shot.status='queued';}});
    const root=this.requireProject().rootPath;
    for(const job of jobs){this.liveJobs.set(job.id,structuredClone(job));await this.journal.write(root,job);this.pending.push(job.id);}
    this.emitSnapshot();void this.pump();
  }

  private async pump():Promise<void>{
    if(this.runningJobId||!this.pending.length)return;
    const jobId=this.pending.shift()!;if(this.cancelled.has(jobId)){this.cancelled.delete(jobId);return void this.pump();}
    this.runningJobId=jobId;this.emitSnapshot();
    try{await this.run(jobId);}
    catch(error){
      if(!this.cancelled.has(jobId)){
        const message=error instanceof Error?error.message:String(error);
        await this.updateJob(jobId,{status:'failed',progress:0,message:'Failed',error:message},true,true);
        const current=this.projects.getCurrent(),job=current?.renderJobs.find(j=>j.id===jobId);
        if(job)await this.projects.mutate(p=>{const shot=p.shots.find(s=>s.id===job.shotId);if(shot)shot.status='failed';});
      }
    }finally{
      this.wanGpProcesses.delete(jobId);this.cancelled.delete(jobId);this.runningJobId=undefined;this.emitSnapshot();void this.pump();
    }
  }

  private async run(jobId:string):Promise<void>{
    const project=this.requireProject(),job=this.snapshot().jobs.find(j=>j.id===jobId);if(!job?.spec)throw new Error('Render job has no immutable spec.');
    const currentShot=project.shots.find(s=>s.id===job.shotId);if(!currentShot)throw new Error('Shot not found.');
    await this.verifyImmutableSpec(project,job);
    const runtime=job.spec.workflowProfile.runtime??(job.spec.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(runtime==='wangp')await this.runWanGp(project,job);
    else await this.runComfy(project,job);
  }

  private async verifyImmutableSpec(project:FilmProject,job:RenderJob):Promise<void>{
    const spec=job.spec!;const workflowPath=await assertExistingPathInside(join(project.rootPath,'workflows'),spec.workflowProfile.workflowPath,`workflow path for ${spec.workflowProfile.name}`);
    if(await sha256File(workflowPath)!==spec.workflowSha256)throw new Error(`Workflow changed after this job was queued (${spec.workflowProfile.name}). Queue a new render or restore the original file.`);
    for(const fp of spec.assetFingerprints){
      const asset=project.assets.find(a=>a.id===fp.assetId);if(!asset)throw new Error(`Referenced asset was removed after queue: ${fp.assetId}`);
      if(asset.projectPath!==fp.projectPath)throw new Error(`Referenced asset path changed after queue: ${asset.name}`);
      const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
      if(await sha256File(path)!==fp.sha256)throw new Error(`Referenced asset changed after queue: ${asset.name}. Queue a new render to use the new file.`);
    }
    const runtime=await fingerprintRuntime(this.settings.get(),spec.workflowProfile);
    if(runtime.environmentSha256!==spec.runtimeFingerprint.environmentSha256)throw new Error('Local AI runtime changed after this job was queued. Queue a new render to accept the new runtime.');
    const currentProfile=project.settings.workflowProfiles.find(p=>p.id===spec.workflowProfile.id);
    if((currentProfile?.modelFingerprint||undefined)!==(spec.modelFingerprint||undefined))throw new Error('Model/checkpoint fingerprint changed after queue. Queue a new render.');
  }

  private baseValues(job:RenderJob):WorkflowValues{
    const shot=job.spec!.shot;return{prompt:job.spec!.effectivePrompt,negativePrompt:shot.generation.negativePrompt,width:shot.generation.width,height:shot.generation.height,resolution:`${shot.generation.width}x${shot.generation.height}`,frames:shot.generation.frames,fps:shot.generation.fps,steps:shot.generation.steps,cfg:shot.generation.cfg,seed:shot.generation.seed,filenamePrefix:`cineforge/${shot.id}/${job.id}`};
  }

  private async populateLocalReferencePaths(project:FilmProject,shot:Shot,profile:WorkflowProfile,values:WorkflowValues):Promise<void>{
    const path=async(id:string)=>{const asset=project.assets.find(a=>a.id===id);if(!asset)throw new Error(`Referenced asset not found: ${id}`);return assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);};
    const keys=new Set(profile.bindings.map(binding=>binding.key));
    if(shot.startFrameAssetId&&keys.has('startImage'))values.startImage=await path(shot.startFrameAssetId);
    if(shot.endFrameAssetId&&keys.has('endImage'))values.endImage=await path(shot.endFrameAssetId);
    const plan=planShotReferences(shot,profile);
    if(plan.locationId)values.locationImage=await path(plan.locationId);
    for(const[index,id]of plan.characterIds.entries())if(id)Object.assign(values,{[`characterImage${index+1}`]:await path(id)});
    for(const[index,id]of plan.propIds.entries())if(id)Object.assign(values,{[`propImage${index+1}`]:await path(id)});
    const genericPaths=await Promise.all(plan.genericIds.map(id=>path(id)));
    if(plan.genericArray)values.referenceImages=genericPaths;
    else for(const[index,key]of plan.genericBindingKeys.entries())Object.assign(values,{[key]:genericPaths[index]});
    if(shot.referenceVideoAssetId&&keys.has('inputVideo'))values.inputVideo=await path(shot.referenceVideoAssetId);
    if(shot.audioAssetId&&keys.has('inputAudio'))values.inputAudio=await path(shot.audioAssetId);
  }

  private async runWanGp(project:FilmProject,job:RenderJob):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot,profile=job.spec!.workflowProfile;
    await this.updateJob(job.id,{status:'preparing',progress:.05,message:`Preparing WanGP · ${profile.name}`},true,true);
    const values=this.baseValues(job);await this.populateLocalReferencePaths(project,shot,profile,values);
    let compiled=await compileWanGpProfile(profile,values);compiled=mapJsonHostPathsForWanGp(project,machine,compiled);
    const cacheDir=join(project.rootPath,'cache','wangp'),outputDir=join(project.rootPath,'renders',shot.id,job.id);
    await Promise.all([mkdir(cacheDir,{recursive:true}),mkdir(outputDir,{recursive:true})]);
    const settingsPath=await assertSafeWritePath(cacheDir,join(cacheDir,`${job.id}.json`),'WanGP job settings');
    await writeFile(settingsPath,JSON.stringify(compiled,null,2),'utf8');

    if(machine.wangp.dryRunBeforeRender){
      await this.updateJob(job.id,{status:'preparing',progress:.08,message:'WanGP dry-run validation'},true,true);
      const dry=startWanGp(project,machine,{settingsPath,outputDir,dryRun:true,runId:job.id});if(dry.pid)await this.updateJob(job.id,{backendPid:dry.pid},false,true);
      await waitWanGp(dry);if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
    }

    let lastLogAt=0;
    const child=startWanGp(project,machine,{settingsPath,outputDir,runId:job.id,onLog:line=>{
      const now=Date.now();if(now-lastLogAt<1000)return;lastLogAt=now;
      void this.updateJob(job.id,{status:'running',progress:.35,message:`WanGP · ${line.slice(0,180)}`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
    }});
    this.wanGpProcesses.set(job.id,child);
    await this.updateJob(job.id,{status:'submitted',progress:.15,message:'Submitted to WanGP',backendPid:child.pid,lastHeartbeatAt:new Date().toISOString()},true,true);
    await waitWanGp(child);if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
    await this.updateJob(job.id,{status:'downloading',progress:.92,message:'Indexing and QC-checking WanGP outputs'},true,true);
    const files=await collectWanGpOutputs(outputDir);if(!files.length)throw new Error(`WanGP completed but no media outputs were found in ${outputDir}.`);
    await this.finalizeWanGpFiles(project,this.snapshot().jobs.find(j=>j.id===job.id)??job,files);
  }

  private async finalizeWanGpFiles(project:FilmProject,job:RenderJob,files:string[]):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot;const outputs:RenderOutput[]=[];
    for(const path of files){
      const mediaType=outputMediaType(path);const output:RenderOutput={id:randomUUID(),jobId:job.id,shotId:shot.id,path,filename:basename(path),mediaType,createdAt:new Date().toISOString(),comfyMeta:{runtime:'wangp',profile:job.spec!.workflowProfile.name}};
      if(mediaType==='video')output.technicalQc=await technicalQcVideo(machine,path,shot);
      outputs.push(output);
    }
    await this.commitOutputs(job,outputs);
  }

  private async runComfy(project:FilmProject,job:RenderJob):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot,profile=job.spec!.workflowProfile,client=new ComfyClient(machine.comfy.url,true);
    await this.updateJob(job.id,{status:'preparing',progress:.05,message:`Preparing ComfyUI · ${profile.name}`},true,true);
    const ping=await client.ping();if(!ping.reachable)throw new Error(`ComfyUI unavailable at ${machine.comfy.url}: ${ping.error||'unknown error'}`);
    const values=this.baseValues(job);await this.updateJob(job.id,{status:'uploading',progress:.1,message:'Staging continuity references'},true,true);
    const stagedImages=new Map<string,string>(),keys=new Set(profile.bindings.map(binding=>binding.key)),plan=planShotReferences(shot,profile);
    const stageImage=async(id:string)=>{const cached=stagedImages.get(id);if(cached)return cached;const staged=await this.stageComfyAsset(project,id,client,'image');stagedImages.set(id,staged);return staged;};
    if(shot.startFrameAssetId&&keys.has('startImage'))values.startImage=await stageImage(shot.startFrameAssetId);
    if(shot.endFrameAssetId&&keys.has('endImage'))values.endImage=await stageImage(shot.endFrameAssetId);
    if(plan.locationId)values.locationImage=await stageImage(plan.locationId);
    for(const[index,id]of plan.characterIds.entries())if(id)Object.assign(values,{[`characterImage${index+1}`]:await stageImage(id)});
    for(const[index,id]of plan.propIds.entries())if(id)Object.assign(values,{[`propImage${index+1}`]:await stageImage(id)});
    const genericPaths=await Promise.all(plan.genericIds.map(id=>stageImage(id)));
    if(plan.genericArray)values.referenceImages=genericPaths;
    else for(const[index,key]of plan.genericBindingKeys.entries())Object.assign(values,{[key]:genericPaths[index]});
    if(shot.referenceVideoAssetId&&keys.has('inputVideo'))values.inputVideo=await this.stageComfyAsset(project,shot.referenceVideoAssetId,client,'file');
    if(shot.audioAssetId&&keys.has('inputAudio'))values.inputAudio=await this.stageComfyAsset(project,shot.audioAssetId,client,'file');
    if(this.cancelled.has(job.id))throw new Error('Job cancelled.');

    const prompt=await compileProfile(profile,values);const queued=await client.queuePrompt(prompt,{cineforge:{projectId:project.id,shotId:shot.id,jobId:job.id,modelFamily:shot.generation.modelFamily}});
    await this.updateJob(job.id,{status:'submitted',progress:.15,message:'Submitted to ComfyUI',comfyPromptId:queued.prompt_id,lastHeartbeatAt:new Date().toISOString()},true,true);
    let history:any;
    try{history=await waitForComfyCompletion(client,queued.prompt_id,{cancelled:()=>this.cancelled.has(job.id),onTick:elapsed=>this.updateJob(job.id,{status:'running',progress:.35,message:`ComfyUI · ${elapsed}s`,lastHeartbeatAt:new Date().toISOString()},false)});}
    catch(error){if(error instanceof Error&&/timed out/i.test(error.message))await client.interrupt().catch(()=>undefined);throw error;}
    if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
    await this.finalizeComfyHistory(project,this.snapshot().jobs.find(j=>j.id===job.id)??job,client,history);
  }

  private async finalizeComfyHistory(project:FilmProject,job:RenderJob,client:ComfyClient,history:any):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot;
    await this.updateJob(job.id,{status:'downloading',progress:.92,message:'Saving and QC-checking ComfyUI outputs'},true,true);
    const refs=uniqueComfyFileRefs(collectComfyFileRefs(history?.outputs||history));if(!refs.length)throw new Error('ComfyUI finished but no downloadable output files were found in history.');
    const outputDir=join(project.rootPath,'renders',shot.id,job.id);await mkdir(outputDir,{recursive:true});const outputs:RenderOutput[]=[];
    for(const ref of refs){
      const bytes=await client.download(ref);const safeLeaf=ref.filename.replace(/[\\/]/g,'_').replace(/[^a-zA-Z0-9._-]+/g,'_');const safeSub=(ref.subfolder||'').replace(/[\\/]+/g,'_').replace(/[^a-zA-Z0-9._-]+/g,'_');
      const destination=await assertSafeWritePath(outputDir,join(outputDir,`${String(outputs.length).padStart(2,'0')}-${safeSub?`${safeSub}-`:''}${safeLeaf}`),'ComfyUI output');
      await writeFile(destination,bytes);const mediaType=inferMediaType(ref.filename);const output:RenderOutput={id:randomUUID(),jobId:job.id,shotId:shot.id,path:destination,filename:ref.filename,mediaType,createdAt:new Date().toISOString(),comfyMeta:{...ref,runtime:'comfyui'}};
      if(mediaType==='video')output.technicalQc=await technicalQcVideo(machine,destination,shot);outputs.push(output);
    }
    await this.commitOutputs(job,outputs);
  }

  private async commitOutputs(job:RenderJob,outputs:RenderOutput[]):Promise<void>{
    const videos=outputs.filter(o=>o.mediaType==='video'),passing=videos.find(o=>o.technicalQc?.passed);
    const expectsVideo=(job.spec?.workflowProfile.purpose??'video')==='video';
    const qcFailed=expectsVideo&&(!videos.length||!passing);const now=new Date().toISOString();
    await this.projects.mutate(p=>{
      for(const output of outputs)if(!p.renderOutputs.some(existing=>existing.id===output.id))p.renderOutputs.push(output);
      const target=p.renderJobs.find(j=>j.id===job.id);const shot=p.shots.find(s=>s.id===job.shotId);
      if(target){target.outputs=outputs;target.updatedAt=now;target.backendPid=undefined;target.lastHeartbeatAt=now;if(qcFailed){target.status='failed';target.progress=1;target.message='Rendered but failed technical QC';target.error=videos.length?videos.flatMap(v=>v.technicalQc?.issues??[]).join(' | '):'Video workflow completed without producing a video output.';}else{target.status='done';target.progress=1;target.message='Done';target.error=undefined;}}
      if(shot){if(qcFailed)shot.status='failed';else{shot.status='rendered';shot.latestRenderId=(passing??videos[0]??outputs[0])?.id;}}
      const profile=p.settings.workflowProfiles.find(item=>item.id===job.spec?.workflowProfile.id);if(profile&&!qcFailed){profile.validation={...(profile.validation??{structuralStatus:'valid'}),structuralStatus:'valid',sourceSha256:job.spec?.workflowSha256,lastSuccessfulRenderAt:now};}
    });
    const current=this.projects.getCurrent()?.renderJobs.find(j=>j.id===job.id);if(current){this.liveJobs.set(job.id,structuredClone(current));await this.journal.write(this.requireProject().rootPath,current);}
    this.emitSnapshot();
  }

  private async stageComfyAsset(project:FilmProject,assetId:string,client:ComfyClient,kind:'image'|'file'):Promise<string>{
    const asset=project.assets.find(a=>a.id===assetId);if(!asset)throw new Error(`Referenced asset not found: ${assetId}`);
    const absolute=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`),machine=this.settings.get();
    if(machine.comfy.inputDir){
      const subfolder=join('cineforge',project.id),targetDir=join(machine.comfy.inputDir,subfolder);await mkdir(targetDir,{recursive:true});
      const safeName=`${asset.id}-${basename(asset.projectPath).replace(/[^a-zA-Z0-9._-]+/g,'_')}`;await copyFile(absolute,join(targetDir,safeName));return`${subfolder.replace(/\\/g,'/')}/${safeName}`;
    }
    if(kind==='image'){const uploaded=await client.uploadImage(absolute);return uploaded.subfolder?`${uploaded.subfolder}/${uploaded.filename}`:uploaded.filename;}
    throw new Error('Audio/video input requires the local ComfyUI input directory in Machine Settings.');
  }

  private async updateJob(jobId:string,patch:Partial<RenderJob>,persistSummary=false,forceJournal=false):Promise<void>{
    const project=this.requireProject(),base=this.liveJobs.get(jobId)??project.renderJobs.find(j=>j.id===jobId);if(!base)return;
    const next={...structuredClone(base),...patch,updatedAt:new Date().toISOString()} as RenderJob;this.liveJobs.set(jobId,next);
    const now=Date.now(),last=this.lastJournalWrite.get(jobId)??0;
    if(forceJournal||now-last>=1500){this.lastJournalWrite.set(jobId,now);await this.journal.write(project.rootPath,next);}
    if(persistSummary)await this.projects.mutate(p=>{const target=p.renderJobs.find(j=>j.id===jobId);if(target)Object.assign(target,next);const shot=p.shots.find(s=>s.id===next.shotId);if(shot&&['preparing','uploading','submitted','running','recovering','stalled','downloading'].includes(next.status))shot.status='rendering';});
    this.emitSnapshot();
  }

  private emitSnapshot():void{this.emit('snapshot',this.snapshot());}
}

function collectReferencedAssetIds(shot:Shot):string[]{return[...new Set([...shot.characterAssetIds,...shot.propAssetIds,...(shot.referenceAssetIds??[]),shot.locationAssetId,shot.startFrameAssetId,shot.endFrameAssetId,shot.referenceVideoAssetId,shot.audioAssetId].filter((v):v is string=>Boolean(v)))];}
function assetLine(asset:Asset|undefined,label:string):string{if(!asset)return'';return`${label}: ${asset.name}${asset.notes.trim()?` — ${asset.notes.trim()}`:''}`;}
function buildPrompt(project:FilmProject,shot:Shot):string{const characters=shot.characterAssetIds.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[],refs=(shot.referenceAssetIds??[]).map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[],props=shot.propAssetIds.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[],location=shot.locationAssetId?project.assets.find(a=>a.id===shot.locationAssetId):undefined;return[shot.prompt.trim(),shot.camera.trim()?`Camera: ${shot.camera.trim()}`:'',shot.action.trim()?`Action: ${shot.action.trim()}`:'',shot.dialogue.trim()?`Dialogue/audio: ${shot.dialogue.trim()}`:'',location?assetLine(location,'Location continuity'):'',...characters.map(a=>assetLine(a,'Character continuity')),...refs.map(a=>assetLine(a,'Visual reference')),...props.map(a=>assetLine(a,'Prop / wardrobe continuity')),shot.continuityNotes.trim()?`Continuity: ${shot.continuityNotes.trim()}`:''].filter(Boolean).join('\n');}
function sleep(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
