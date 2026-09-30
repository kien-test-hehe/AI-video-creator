import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  AppMachineSettings, Asset, AssetFingerprint, FilmProject, QueueSnapshot, RenderBatchRequest, RenderJob, RenderOutput, RenderRuntimeFingerprint,
  RenderRequest, Shot, SystemProbe, WorkflowBindingKey, WorkflowProfile
} from '../../shared/types';
import { ProjectService } from './project-service';
import { AppSettingsService } from './app-settings-service';
import { ComfyClient, cineforgePromptIdentities, hasActiveComfyPrompts, historyWasInterrupted, promptQueueState } from './comfy-client';
import { compileProfile, type WorkflowValues } from './workflow-engine';
import { compileWanGpProfile } from './wangp-engine';
import { collectWanGpOutputs, isWanGpDockerRunning, outputMediaType, startWanGp, stopWanGpDocker, waitWanGp } from './wangp-runner';
import { routeWorkflow } from './model-router';
import { collectComfyHistoryOutputRefs, inferMediaType } from './comfy-output';
import { waitForComfyCompletion, waitForComfyPromptRelease } from './comfy-runner';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertPathInside, assertSafeWritePath, ensureSafeDirectory } from './path-safety';
import { fingerprintRuntime, sha256File } from './runtime-fingerprint';
import { mapJsonHostPathsForWanGp } from './runtime-path-mapper';
import { JobJournal } from './job-journal';
import { technicalQcVideo } from './technical-qc';
import { findExpectedProcessPids, isProcessAlive, killProcessTree } from './process-utils';
import { probeSystem } from './system-probe';
import { planShotReferences } from './reference-plan';
import { canRefreshProfileValidationFromRender, currentGenerationState, shotRenderInputKey, workflowExecutionKey } from '../../shared/shot-signature';
import { currentProductionInputKeyForOutput, renderOutputProductionInputKey, shotProductionInputKey } from '../../shared/production-state';
import { selectRecoveryJob, shotStatusAfterJobSettlement } from '../../shared/recovery-policy';
import { stageWorkflowProfileSnapshot } from './workflow-snapshot';
import { RenderLeaseStore } from './render-lease';
import { AdmissionGate } from './admission-gate';

const ACTIVE = new Set(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);
const TERMINAL = new Set(['done','failed','cancelled','orphaned']);

export class RenderQueueService extends EventEmitter {
  private pending:string[]=[];
  private recoveryPending:string[]=[];
  private runningJobId?:string;
  private pumping=false;
  private recoveryBlockedError?:string;
  private cancelled=new Set<string>();
  private wanGpProcesses=new Map<string,ChildProcess>();
  private comfyCancelPromises=new Map<string,Promise<void>>();
  private liveJobs=new Map<string,RenderJob>();
  private lastJournalWrite=new Map<string,number>();
  private admission=new AdmissionGate();
  private journal:JobJournal;

  constructor(private projects:ProjectService,private settings:AppSettingsService,private renderLeases:RenderLeaseStore){
    super();
    this.journal=new JobJournal(settings.getJournalKey());
  }

  snapshot():QueueSnapshot{
    const project=this.projects.getCurrent();
    const jobs=(project?.renderJobs??[]).map(job=>structuredClone(this.liveJobs.get(job.id)??job));
    for(const live of this.liveJobs.values())if(!jobs.some(j=>j.id===live.id))jobs.push(structuredClone(live));
    jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return{runningJobId:this.runningJobId,blockedReason:this.recoveryBlockedError,jobs};
  }

  isBusy():boolean{return Boolean(this.admission.busy||this.recoveryBlockedError||this.runningJobId||this.pending.length||this.recoveryPending.length||this.snapshot().jobs.some(j=>ACTIVE.has(j.status)));}

  async enqueue(request:RenderRequest):Promise<QueueSnapshot>{return this.admission.run(()=>this.enqueueInternal(request));}

  private async enqueueInternal(request:RenderRequest):Promise<QueueSnapshot>{
    this.assertRecoveryOperational();const project=this.requireProject();
    if(project.rootPath!==request.projectRoot)throw new Error('Render request does not match the open project.');
    const shot=project.shots.find(s=>s.id===request.shotId);if(!shot)throw new Error('Shot not found.');
    if(this.hasActiveJobForShot(shot.id))throw new Error(`An active render already exists for ${shot.title}.`);
    const profile=routeWorkflow(project,shot,request.forceWorkflowProfileId);
    const machine=this.settings.get(),probe=await probeSystem(project,machine);
    this.assertExecutionEnvironment(machine,profile,probe,shot);
    const job=await this.createJob(project,shot,profile,machine);
    await this.commitQueuedJobs([job]);return this.snapshot();
  }

  async enqueueBatch(request:RenderBatchRequest):Promise<QueueSnapshot>{return this.admission.run(()=>this.enqueueBatchInternal(request));}

  private async enqueueBatchInternal(request:RenderBatchRequest):Promise<QueueSnapshot>{
    this.assertRecoveryOperational();const project=this.requireProject();if(project.rootPath!==request.projectRoot)throw new Error('Batch render request does not match the open project.');
    const jobs:RenderJob[]=[];
    const machine=this.settings.get(),probe=await probeSystem(project,machine),runtimeFingerprints=new Map<string,Promise<RenderRuntimeFingerprint>>();
    const fingerprintFor=(profile:WorkflowProfile)=>{
      const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
      const key=runtime==='wangp'?`wangp:${machine.wangp.executionMode}`:'comfyui';
      let pending=runtimeFingerprints.get(key);if(!pending){pending=fingerprintRuntime(machine,profile);runtimeFingerprints.set(key,pending);}return pending;
    };
    for(const id of [...new Set(request.shotIds)]){
      const shot=project.shots.find(s=>s.id===id);if(!shot)throw new Error(`Shot not found: ${id}`);
      if(request.skipIfRendered&&shot.latestRenderId){
        const preferred=project.renderOutputs.find(output=>output.id===shot.latestRenderId&&output.shotId===shot.id&&output.mediaType==='video');
        const currentInputKey=preferred?currentProductionInputKeyForOutput(project,shot,preferred):undefined;
        if(preferred&&currentInputKey&&renderOutputProductionInputKey(project,preferred)===currentInputKey){
          try{await assertExistingPathInside(join(project.rootPath,'renders'),preferred.path,`preferred render for ${shot.title}`);continue;}
          catch(error:any){if(error?.code!=='ENOENT')throw error;}
        }
      }
      if(this.hasActiveJobForShot(shot.id))continue;
      const profile=routeWorkflow(project,shot);
      this.assertExecutionEnvironment(machine,profile,probe,shot);
      jobs.push(await this.createJob(project,shot,profile,machine,await fingerprintFor(profile)));
    }
    if(jobs.length)await this.commitQueuedJobs(jobs);return this.snapshot();
  }

  async retry(jobId:string):Promise<QueueSnapshot>{return this.admission.run(()=>this.retryInternal(jobId));}

  private async retryInternal(jobId:string):Promise<QueueSnapshot>{
    this.assertRecoveryOperational();const prior=this.snapshot().jobs.find(j=>j.id===jobId);if(!prior)throw new Error('Render job not found.');
    if(ACTIVE.has(prior.status))throw new Error('Cannot retry an active job.');
    if(this.hasActiveJobForShot(prior.shotId))throw new Error('Cannot retry this snapshot while another render for the same shot is active.');
    if(!prior.spec)return this.enqueueInternal({projectRoot:this.requireProject().rootPath,shotId:prior.shotId,forceWorkflowProfileId:prior.workflowProfileId});
    if(prior.spec.shot.id!==prior.shotId)throw new Error('Render job immutable spec shot identity does not match the job shot. Refusing unsafe exact retry.');
    const project=this.requireProject(),machine=this.settings.get(),probe=await probeSystem(project,machine);
    this.assertExecutionEnvironment(machine,prior.spec.workflowProfile,probe,prior.spec.shot);
    await this.verifyImmutableSpec(project,prior);
    const now=new Date().toISOString();
    const retry:RenderJob={id:randomUUID(),shotId:prior.shotId,createdAt:now,updatedAt:now,status:'queued',progress:0,message:`Retry of ${prior.id.slice(0,8)} · immutable snapshot`,modelFamily:prior.spec.shot.generation.modelFamily,workflowProfileId:prior.spec.workflowProfile.id,outputs:[],spec:structuredClone(prior.spec)};
    await this.commitQueuedJobs([retry]);return this.snapshot();
  }

  async cancel(jobId:string):Promise<QueueSnapshot>{
    this.assertRecoveryOperational();this.requireProject();const job=this.snapshot().jobs.find(j=>j.id===jobId);if(!job)throw new Error('Render job not found.');if(TERMINAL.has(job.status))return this.snapshot();
    const wasRunning=this.runningJobId===jobId;
    if(this.recoveryPending.includes(jobId))throw new Error('This backend-active job is waiting for serialized recovery. Let it become the active recovery job before cancelling so CineForge can confirm the backend stop safely.');
    const runtime=job.spec?.workflowProfile.runtime??(job.spec?.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(wasRunning&&runtime==='comfyui'&&!this.settings.get().comfy.dedicatedInstance)throw new Error('Safe cancellation is disabled for a shared ComfyUI instance. Configure a dedicated CineForge ComfyUI instance first.');
    this.pending=this.pending.filter(id=>id!==jobId);
    if(wasRunning){
      if(runtime==='wangp'){
        const machine=this.settings.get(),child=this.wanGpProcesses.get(jobId);
        if(machine.wangp.executionMode==='docker'){
          if(!await isWanGpDockerRunning(machine,job.id))throw new Error('WanGP container is no longer running; wait for output finalization instead of marking the job cancelled.');
          await stopWanGpDocker(machine,job.id);
          if(child?.pid&&isProcessAlive(child.pid))await killProcessTree(child.pid);
        }else if(child?.pid&&isProcessAlive(child.pid))await killProcessTree(child.pid);
        else{
          const matches=await findExpectedProcessPids([job.id,'wgp.py']);
          if(!matches.length)throw new Error('WanGP process is no longer running; wait for output finalization instead of marking the job cancelled.');
          for(const pid of matches)if(isProcessAlive(pid))await killProcessTree(pid);
        }
        this.cancelled.add(jobId);
      }else{
        const machine=this.settings.get(),client=new ComfyClient(machine.comfy.url,true);
        let promptId=job.comfyPromptId;
        if(!promptId){
          this.cancelled.add(jobId);
          try{promptId=await this.waitForComfyPromptOrExit(jobId);}
          catch(error){this.cancelled.delete(jobId);throw error;}
        }
        if(promptId){
          try{await this.confirmComfyCancellation(jobId,client,promptId);}
          catch(error){this.cancelled.delete(jobId);throw new Error(`ComfyUI did not confirm cancellation for ${promptId}: ${error instanceof Error?error.message:String(error)}`);}
        }
        this.cancelled.add(jobId);
      }
    }else this.cancelled.add(jobId);
    await this.updateJob(jobId,{status:'cancelled',progress:0,message:'Cancelled'},true,true);
    await this.projects.mutate(p=>{const shot=p.shots.find(s=>s.id===job.shotId);if(!shot)return;const currentSpec=this.isCurrentJobSpec(p,job,shot);shot.status=shotStatusAfterJobSettlement(shot.status,Boolean(shot.latestRenderId),currentSpec,job.spec?.shot.status,'cancelled');});
    if(!wasRunning){this.cancelled.delete(jobId);void this.pump();}
    return this.snapshot();
  }

  async reconcileAfterProjectOpen():Promise<void>{
    this.recoveryBlockedError=undefined;
    try{
      this.pending=[];this.recoveryPending=[];this.runningJobId=undefined;this.liveJobs.clear();this.cancelled.clear();
      const project=this.projects.getCurrent();if(!project)return;
    const activeLease=await this.renderLeases.read();
    if(activeLease&&(activeLease.projectId!==project.id||activeLease.projectRoot!==project.rootPath))throw new Error('A signed active-render lease belongs to a different project. Open/recover that project before starting any new GPU work.');
    if(activeLease&&!project.renderJobs.some(job=>job.id===activeLease.jobId))throw new Error(`Signed active-render lease references missing job ${activeLease.jobId}. GPU ownership is uncertain; do not start new generation until the prior backend work is stopped and the lease is cleared deliberately.`);
    const journalIds=new Set(project.renderJobs.filter(job=>!TERMINAL.has(job.status)).map(job=>job.id));if(activeLease)journalIds.add(activeLease.jobId);
    const journals=await this.journal.readAll(project.rootPath,journalIds),byId=new Map(journals.map(j=>[j.id,j]));
    if(activeLease&&!byId.has(activeLease.jobId))throw new Error(`Signed active-render lease exists for ${activeLease.jobId}, but its signed project journal is missing or invalid. Recovery is blocked to avoid releasing an unknown GPU backend.`);
    const selections=project.renderJobs.map(projectJob=>selectRecoveryJob(projectJob,byId.get(projectJob.id),activeLease?.jobId===projectJob.id)).sort((a,b)=>{
      if(activeLease){if(a.job.id===activeLease.jobId)return-1;if(b.job.id===activeLease.jobId)return 1;}
      return a.job.createdAt.localeCompare(b.job.createdAt);
    });
    let recoveryStarted=false;
    for(const selection of selections){
      const job=selection.job,signed=selection.signed;
      this.liveJobs.set(job.id,structuredClone(job));
      if(TERMINAL.has(job.status)){
        if(selection.persistTerminal){
          await this.projects.mutate(p=>{
            const target=p.renderJobs.find(item=>item.id===job.id);if(target)Object.assign(target,structuredClone(job));
            const shot=p.shots.find(item=>item.id===job.shotId);
            if(shot&&['queued','rendering'].includes(shot.status)){
              const currentSpec=this.isCurrentJobSpec(p,job,shot);
              if(job.status==='failed'||job.status==='cancelled'||job.status==='orphaned')shot.status=shotStatusAfterJobSettlement(shot.status,Boolean(shot.latestRenderId),currentSpec,job.spec?.shot.status,job.status);
              else shot.status=shot.latestRenderId?'rendered':'ready';
            }
          });
        }
        continue;
      }
      if(!signed){
        if(activeLease?.jobId===job.id)throw new Error(`Signed active-render lease exists for ${job.id}, but its signed project journal is missing or invalid. Recovery is blocked to avoid releasing an unknown GPU backend.`);
        await this.updateJob(job.id,{status:'orphaned',progress:0,message:'Untrusted runtime state was not resumed',error:'No valid installation-signed job journal exists for this active job. Queue a new render explicitly.'},true,false);
        await this.restoreShotAfterOrphan(job);
        continue;
      }
      if(['queued','preparing','uploading'].includes(job.status)){
        await this.updateJob(job.id,{status:'queued',progress:0,message:'Recovered after restart · queued again'},true,true);
        this.pending.push(job.id);continue;
      }
      if(['submitted','running','recovering','stalled','downloading'].includes(job.status)){
        if(!recoveryStarted){
          recoveryStarted=true;this.runningJobId=job.id;
          await this.acquireRecoveryRenderLease(project,job.id);
          void this.recoverActiveJob(job.id);continue;
        }
        await this.updateJob(job.id,{status:'recovering',message:'Waiting for serialized backend recovery; no new GPU work will start before this backend identity is resolved.'},true,true);
        this.recoveryPending.push(job.id);continue;
      }
      await this.updateJob(job.id,{status:'queued',progress:0,message:'Recovered after restart · queued again'},true,true);
      this.pending.push(job.id);
    }
      if(!this.runningJobId&&activeLease)await this.releaseRenderLease(activeLease.jobId);
      this.emitSnapshot();if(!this.runningJobId)void this.pump();
    }catch(error){
      this.recoveryBlockedError=error instanceof Error?error.message:String(error);
      this.emitSnapshot();
      throw error;
    }
  }

  private async recoverActiveJob(jobId:string):Promise<void>{
    let recoveredJob:RenderJob|undefined,releaseAllowed=false;
    try{
      const project=this.requireProject(),job=this.snapshot().jobs.find(j=>j.id===jobId);
      if(!job)throw new Error('Recovered job is missing from the project queue.');
      recoveredJob=job;
      if(!job.spec)throw new Error('Recovered active job has no immutable spec, so its backend runtime cannot be identified safely.');
      const runtime=job.spec.workflowProfile.runtime??(job.spec.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
      await this.updateJob(jobId,{status:'recovering',message:`Recovering ${runtime} job after restart`},true,true);
      if(runtime==='wangp')await this.recoverWanGp(project,job);
      else await this.recoverComfy(project,job);
      releaseAllowed=true;
    }catch(error){
      if(this.cancelled.has(jobId)){
        await this.updateJob(jobId,{status:'cancelled',progress:0,message:'Cancelled',error:undefined},true,true);
        releaseAllowed=true;
      }else{
        try{
          if(!recoveredJob)throw new Error('Recovered job identity is unavailable, so backend cleanup cannot be confirmed.');
          await this.cleanupRejectedRecovery(recoveredJob);
          await this.updateJob(jobId,{status:'orphaned',progress:0,message:'Recovery failed',error:error instanceof Error?error.message:String(error)},true,true);
          await this.restoreShotAfterOrphan(recoveredJob);
          releaseAllowed=true;
        }catch(cleanupError){
          const reason=`Recovery failed and backend cleanup could not be confirmed for ${jobId}: ${cleanupError instanceof Error?cleanupError.message:String(cleanupError)}`;
          this.recoveryBlockedError=reason;
          await this.updateJob(jobId,{status:'stalled',message:'Recovery cleanup is unconfirmed; GPU ownership remains locked',error:reason},true,true).catch(updateError=>console.warn('Could not persist blocked recovery state:',updateError));
          this.emitSnapshot();
        }
      }
    }finally{
      this.comfyCancelPromises.delete(jobId);
      if(!releaseAllowed){
        this.runningJobId=jobId;
        this.emitSnapshot();
        return;
      }
      await this.cleanupJobSnapshots(jobId);
      this.cancelled.delete(jobId);this.runningJobId=undefined;
      const nextRecovery=this.recoveryPending.shift();
      if(nextRecovery){
        const project=this.requireProject();await this.acquireRecoveryRenderLease(project,nextRecovery);
        this.runningJobId=nextRecovery;this.emitSnapshot();void this.recoverActiveJob(nextRecovery);
      }else{
        await this.releaseRenderLease(jobId);
        this.emitSnapshot();void this.pump();
      }
    }
  }

  private async restoreShotAfterOrphan(job:RenderJob):Promise<void>{
    await this.projects.mutate(project=>{
      const shot=project.shots.find(item=>item.id===job.shotId);if(!shot)return;
      const currentSpec=this.isCurrentJobSpec(project,job,shot);
      shot.status=shotStatusAfterJobSettlement(shot.status,Boolean(shot.latestRenderId),currentSpec,job.spec?.shot.status,'orphaned');
    });
  }

  private async cleanupRejectedRecovery(job:RenderJob):Promise<void>{
    const latest=this.snapshot().jobs.find(item=>item.id===job.id)??job;
    if(!latest.spec)throw new Error('Cannot clean up recovered backend safely because the immutable job spec/runtime identity is missing.');
    const runtime=latest.spec.workflowProfile.runtime??(latest.spec.workflowProfile.workflowFormat==='wangp-settings'?'wangp':'comfyui'),machine=this.settings.get();
    if(runtime==='comfyui'){
      let promptId=latest.comfyPromptId;
      if(!promptId){
        const client=new ComfyClient(machine.comfy.url,true);
        promptId=await this.resolveComfyPromptIdentity(latest,client);
        if(!promptId)return;
        try{await this.confirmComfyCancellation(latest.id,client,promptId);}
        catch{await waitForComfyPromptRelease(client,promptId,{onTick:message=>this.updateJob(latest.id,{status:'stalled',message},false).catch(()=>undefined)});}
        return;
      }
      const client=new ComfyClient(machine.comfy.url,true);
      try{await this.confirmComfyCancellation(latest.id,client,promptId);}
      catch{await waitForComfyPromptRelease(client,promptId,{onTick:message=>this.updateJob(latest.id,{status:'stalled',message},false).catch(()=>undefined)});}
      return;
    }
    if(machine.wangp.executionMode==='docker'){
      while(true){
        try{if(!await isWanGpDockerRunning(machine,latest.id))return;await stopWanGpDocker(machine,latest.id);}
        catch(error){await this.updateJob(job.id,{status:'stalled',message:`WanGP Docker cleanup is unconfirmed; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);await sleep(2000);}
      }
    }
    let pids:number[];
    while(true){
      try{pids=await findExpectedProcessPids([latest.id,'wgp.py']);break;}
      catch(error){await this.updateJob(latest.id,{status:'stalled',message:`WanGP process discovery is unavailable; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);await sleep(2000);}
    }
    for(const pid of pids)while(isProcessAlive(pid)){
      try{await killProcessTree(pid);}
      catch(error){await this.updateJob(latest.id,{status:'stalled',message:`WanGP process stop is unconfirmed for PID ${pid}; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);await sleep(2000);}
    }
  }

  private async recoverWanGp(project:FilmProject,job:RenderJob):Promise<void>{
    const outputDir=join(project.rootPath,'renders',job.shotId,job.id),machine=this.settings.get();
    const started=Date.now();let stalled=false;
    if(machine.wangp.executionMode==='docker'){
      while(true){
        let running:boolean;
        try{running=await isWanGpDockerRunning(machine,job.id);}
        catch(error){await this.updateJob(job.id,{status:'stalled',message:`Cannot inspect recovered WanGP Docker state; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);await sleep(5000);continue;}
        if(!running)break;
        if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
        if(Date.now()-started>12*60*60_000&&!stalled){stalled=true;await this.updateJob(job.id,{status:'stalled',message:'Recovered WanGP Docker job has exceeded 12 hours; GPU slot remains reserved until it ends or is cancelled.'},true,true);}
        if(!stalled)await this.updateJob(job.id,{status:'recovering',progress:Math.max(job.progress,0.35),message:'WanGP Docker container is still running · recovered by container identity',lastHeartbeatAt:new Date().toISOString()},false);
        await sleep(5000);
      }
    }else{
      let matches:number[]=[];
      while(true){
        try{matches=await findExpectedProcessPids([job.id,'wgp.py']);break;}
        catch(error){await this.updateJob(job.id,{status:'stalled',message:`Cannot inspect recovered WanGP process state; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);await sleep(5000);}
      }
      if(matches.length>1)throw new Error(`Multiple WanGP processes match recovered job ${job.id}; refusing ambiguous attachment.`);
      const pid=matches[0];
      if(pid){
        await this.persistBackendIdentity(job.id,{backendPid:pid,status:'recovering',message:'Recovered WanGP process by command-line run identity'});
        while(isProcessAlive(pid)){
          if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
          if(Date.now()-started>12*60*60_000&&!stalled){stalled=true;await this.updateJob(job.id,{status:'stalled',message:'Recovered WanGP process has exceeded 12 hours; GPU slot remains reserved until it ends or is cancelled.'},true,true);}
          if(!stalled)await this.updateJob(job.id,{status:'recovering',progress:Math.max(job.progress,0.35),message:'WanGP process is still running · recovered by run identity',lastHeartbeatAt:new Date().toISOString()},false);
          await sleep(5000);
        }
      }
    }
    const files=await collectWanGpOutputs(outputDir);if(!files.length)throw new Error('WanGP process ended or was not found, and no media output was found.');
    await this.finalizeWanGpFiles(project,job,files);
  }

  private async recoverComfy(project:FilmProject,job:RenderJob):Promise<void>{
    const client=new ComfyClient(this.settings.get().comfy.url,true);
    const promptId=job.comfyPromptId??await this.resolveComfyPromptIdentity(job,client);
    if(!promptId)throw new Error('Recovered ComfyUI submission has no matching CineForge prompt in queue/history.');
    let history=await client.history(promptId);
    if(!history){
      const queue=await client.queue();
      if(promptQueueState(queue,promptId)==='absent')throw new Error('ComfyUI no longer has this prompt in history or queue.');
      history=await this.waitForComfyWithSafeTimeout(client,job,promptId,true);
    }
    await this.finalizeComfyHistory(project,{...job,comfyPromptId:promptId},client,history);
  }

  private async resolveComfyPromptIdentity(job:RenderJob,client:ComfyClient):Promise<string|undefined>{
    let successfulEmptyScans=0;
    while(successfulEmptyScans<3){
      try{
        const [queue,history]=await Promise.all([client.queue(),client.historyAll()]);
        const matches=cineforgePromptIdentities(queue,history,job.id);
        if(matches.length>1){
          for(const match of matches.filter(item=>item.state!=='history')){
            try{await this.confirmComfyCancellation(job.id,client,match.promptId);}
            catch{await waitForComfyPromptRelease(client,match.promptId,{onTick:message=>this.updateJob(job.id,{status:'stalled',message},false).catch(()=>undefined)});}
          }
          throw new Error(`Multiple ComfyUI prompts match CineForge job ${job.id}; active duplicates were stopped and the job requires explicit retry.`);
        }
        if(matches.length===1){
          const promptId=matches[0].promptId;
          await this.persistBackendIdentity(job.id,{comfyPromptId:promptId,status:'recovering',message:`Recovered ComfyUI prompt ${promptId} by CineForge job identity`});
          return promptId;
        }
        if(hasActiveComfyPrompts(queue)){
          successfulEmptyScans=0;
          await this.updateJob(job.id,{status:'stalled',message:'Dedicated ComfyUI still has active work but no exact CineForge prompt identity match yet; GPU slot remains reserved.',lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
          await sleep(2000);continue;
        }
        successfulEmptyScans+=1;
        if(successfulEmptyScans<3)await sleep(500);
      }catch(error){
        if(error instanceof Error&&/Multiple ComfyUI prompts/.test(error.message))throw error;
        await this.updateJob(job.id,{status:'stalled',message:`ComfyUI submission identity is unresolved; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
        await sleep(2000);
      }
    }
    return undefined;
  }

  private async persistBackendIdentity(jobId:string,patch:Partial<RenderJob>):Promise<void>{
    while(true){
      try{await this.updateJob(jobId,patch,true,true);return;}
      catch(error){console.warn('Backend identity persistence failed; retaining GPU ownership until durable state is restored.',error);await sleep(2000);}
    }
  }

  private async cleanupJobSnapshots(jobId:string):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    for(const path of [
      join(project.rootPath,'cache','workflow-inputs',jobId),
      join(project.rootPath,'cache','wangp-inputs',jobId),
      join(project.rootPath,'cache','comfy-inputs',jobId)
    ])await rm(path,{recursive:true,force:true}).catch(error=>console.warn(`Could not remove completed job cache: ${path}`,error));
  }

  private async acquireRenderLease(project:FilmProject,jobId:string):Promise<void>{
    await this.renderLeases.write({version:1,projectId:project.id,projectRoot:project.rootPath,jobId,createdAt:new Date().toISOString()});
  }

  private async acquireRecoveryRenderLease(project:FilmProject,jobId:string):Promise<void>{
    while(true){
      try{await this.acquireRenderLease(project,jobId);return;}
      catch(error){
        await this.updateJob(jobId,{status:'stalled',message:`Cannot persist machine GPU ownership for recovered job; GPU remains locked · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);
        this.emitSnapshot();await sleep(2000);
      }
    }
  }

  private async releaseRenderLease(jobId:string):Promise<void>{
    while(true){
      try{await this.renderLeases.clearIfJob(jobId);return;}
      catch(error){console.warn('Active-render lease could not be cleared; GPU queue remains locked.',error);await sleep(2000);}
    }
  }

  private assertRecoveryOperational():void{
    if(this.recoveryBlockedError)throw new Error(`Render queue is blocked because recovery or durable queue state is uncertain: ${this.recoveryBlockedError}. Resolve the underlying storage/backend problem and restart/reopen the project before queueing, retrying, or cancelling renders.`);
  }

  private requireProject():FilmProject{const project=this.projects.getCurrent();if(!project)throw new Error('Open a project first.');return project;}

  private hasActiveJobForShot(shotId:string):boolean{return this.snapshot().jobs.some(j=>j.shotId===shotId&&ACTIVE.has(j.status));}

  private confirmComfyCancellation(jobId:string,client:ComfyClient,promptId:string):Promise<void>{
    const existing=this.comfyCancelPromises.get(jobId);if(existing)return existing;
    let pending:Promise<void>;
    pending=client.cancelPrompt(promptId).catch(error=>{if(this.comfyCancelPromises.get(jobId)===pending)this.comfyCancelPromises.delete(jobId);throw error;});
    this.comfyCancelPromises.set(jobId,pending);return pending;
  }

  private async waitForComfyPromptOrExit(jobId:string,timeoutMs=35_000):Promise<string>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const live=this.snapshot().jobs.find(job=>job.id===jobId);
      if(live?.comfyPromptId)return live.comfyPromptId;
      if(this.runningJobId!==jobId)throw new Error('ComfyUI job left the active submission state before its prompt identity was durably confirmed. Cancellation cannot be claimed safely; refresh/recover the queue state.');
      await sleep(100);
    }
    throw new Error('ComfyUI submission is still unresolved; cancellation was not confirmed, so the GPU slot remains reserved.');
  }

  private async waitForComfyWithSafeTimeout(client:ComfyClient,job:RenderJob,promptId:string,recovering:boolean):Promise<any>{
    try{
      return await waitForComfyCompletion(client,promptId,{cancelled:()=>this.cancelled.has(job.id),onTick:elapsed=>this.updateJob(job.id,{status:recovering?'recovering':'running',progress:recovering?Math.max(job.progress,.35):.35,message:`${recovering?'ComfyUI recovered':'ComfyUI'} · ${elapsed}s`,lastHeartbeatAt:new Date().toISOString()},false).catch(error=>console.warn('Comfy progress journal update failed; retaining GPU ownership.',error))});
    }catch(error){
      if(this.cancelled.has(job.id))throw error;
      if(error instanceof Error&&/timed out/i.test(error.message)){
        try{await this.confirmComfyCancellation(job.id,client,promptId);}
        catch(cancelError){
          await this.updateJob(job.id,{status:'stalled',message:`ComfyUI timed out; cancellation is unconfirmed, so the GPU slot remains reserved · ${cancelError instanceof Error?cancelError.message:String(cancelError)}`,lastHeartbeatAt:new Date().toISOString()},true,true).catch(()=>undefined);
          return this.waitForComfyResolutionAfterTimeout(client,job,promptId);
        }
        throw new Error(`${error.message} Backend cancellation was confirmed.`);
      }
      await this.updateJob(job.id,{status:'stalled',message:`ComfyUI polling failed; GPU slot remains reserved until backend release · ${error instanceof Error?error.message:String(error)}`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
      await waitForComfyPromptRelease(client,promptId,{onTick:message=>this.updateJob(job.id,{status:'stalled',message},false).catch(()=>undefined)});
      throw error;
    }
  }

  private async waitForComfyResolutionAfterTimeout(client:ComfyClient,job:RenderJob,promptId:string):Promise<any>{
    while(true){
      if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
      let history:any|null;
      try{history=await client.history(promptId);}
      catch(error){
        await this.updateJob(job.id,{status:'stalled',message:`ComfyUI timeout recovery cannot read history; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
        await sleep(5000);continue;
      }
      if(history){
        if(historyWasInterrupted(history))throw new Error('ComfyUI prompt was interrupted after timeout.');
        if(history.status?.status_str==='error')throw new Error(`ComfyUI execution failed after timeout: ${JSON.stringify(history.status)}`);
        if((history.outputs&&Object.keys(history.outputs).length>0)||history.status?.completed)return history;
      }
      let state:'running'|'pending'|'absent';
      try{state=promptQueueState(await client.queue(),promptId);}
      catch(error){
        await this.updateJob(job.id,{status:'stalled',message:`ComfyUI timeout recovery cannot read queue state; GPU slot remains reserved · ${error instanceof Error?error.message:String(error)}`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
        await sleep(5000);continue;
      }
      if(state==='absent')throw new Error('ComfyUI prompt disappeared after timeout without terminal history; backend no longer owns the GPU slot.');
      await this.updateJob(job.id,{status:'stalled',message:`ComfyUI timed out but prompt is still ${state}; GPU slot remains reserved`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
      await sleep(5000);
    }
  }

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
    if(runtime==='comfyui'&&!machine.comfy.dedicatedInstance)throw new Error('Production ComfyUI jobs require a dedicated CineForge instance for workload isolation, deterministic recovery, and safe legacy cancellation fallback.');
    const assetFingerprints=await this.fingerprintAssets(project,shot);
    const runtimeFingerprint=knownRuntimeFingerprint??await fingerprintRuntime(machine,profile);
    if(!profile.validation?.runtimeFingerprint)throw new Error(`Profile “${profile.name}” has no validated runtime fingerprint. Revalidate it on this workstation before rendering.`);
    if(profile.validation.runtimeFingerprint!==runtimeFingerprint.environmentSha256)throw new Error(`Profile “${profile.name}” was validated against a different local AI runtime. Revalidate it before rendering.`);
    const now=new Date().toISOString();
    return{id:randomUUID(),shotId:shot.id,createdAt:now,updatedAt:now,status:'queued',progress:0,message:'Waiting',modelFamily:shot.generation.modelFamily,workflowProfileId:profile.id,outputs:[],spec:{shot:structuredClone(shot),workflowProfile:structuredClone(profile),effectivePrompt:buildRenderPrompt(project,shot),productionInputKey:shotProductionInputKey(project,shot,profile),queuedProjectUpdatedAt:project.updatedAt,workflowSha256,assetFingerprints,runtimeFingerprint,modelFingerprint:profile.modelFingerprint}};
  }

  private assertExecutionEnvironment(machine:AppMachineSettings,profile:WorkflowProfile,probe:SystemProbe,shot?:Shot):void{
    if(!probe.ffmpeg.available||!probe.ffmpeg.ffprobeAvailable)throw new Error('FFmpeg and FFprobe must be available before queueing because every video output is technically QC-checked.');
    if(probe.disk&&probe.disk.freeBytes<5*1024*1024*1024)throw new Error('Less than 5 GB free on the project volume. Free disk space before rendering.');
    if(probe.memory&&probe.memory.freeMb<6*1024)throw new Error(`Only ${(probe.memory.freeMb/1024).toFixed(1)} GB system RAM is free. Pause heavy applications before local generation.`);
    if(probe.gpu?.freeVramMb!=null&&probe.gpu.freeVramMb<4096)throw new Error(`Only ${(probe.gpu.freeVramMb/1024).toFixed(1)} GB GPU VRAM is free. Close GPU-heavy applications or wait for memory to be released before generation.`);
    if(shot?.generation.quality==='hero'&&probe.gpu?.freeVramMb!=null&&probe.gpu.freeVramMb<6144)throw new Error(`Hero-quality generation requires at least 6 GB currently free VRAM under the CineForge safety policy; only ${(probe.gpu.freeVramMb/1024).toFixed(1)} GB is free.`);
    const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
    if(runtime==='wangp'){
      if(!probe.wangp.available)throw new Error(`WanGP is unavailable: ${probe.wangp.error||'not configured'}`);
      if(machine.wangp.executionMode==='docker'){if(!probe.docker?.available)throw new Error(`Docker is unavailable for the selected WanGP runtime: ${probe.docker?.error||'not running'}`);if(probe.docker.gpuAccessible!==true)throw new Error('Docker NVIDIA GPU runtime could not be confirmed for WanGP.');}
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
    const current=this.requireProject();
    if(current.renderJobs.length+jobs.length>100_000)throw new Error('Render job history would exceed the 100000-job project safety limit. Remove/archive old project history before queueing more work.');
    const root=current.rootPath;
    for(const job of jobs)await this.journal.write(root,job);
    await this.projects.mutate(project=>{project.renderJobs.unshift(...[...jobs].reverse());for(const job of jobs){const shot=project.shots.find(s=>s.id===job.shotId);if(shot)shot.status='queued';}});
    for(const job of jobs){this.liveJobs.set(job.id,structuredClone(job));this.pending.push(job.id);}
    this.emitSnapshot();void this.pump();
  }

  private async pump():Promise<void>{
    if(this.pumping)return;
    this.pumping=true;
    try{
      if(this.recoveryBlockedError||this.runningJobId||this.recoveryPending.length||!this.pending.length)return;
      const jobId=this.pending[0];
      if(this.cancelled.has(jobId)){
        this.pending=this.pending.filter(id=>id!==jobId);this.cancelled.delete(jobId);return;
      }
      const project=this.requireProject();
      try{await this.acquireRenderLease(project,jobId);}
      catch(error){
        const cancelledWhileAcquiring=this.cancelled.has(jobId)||!this.pending.includes(jobId);
        this.pending=this.pending.filter(id=>id!==jobId);
        if(cancelledWhileAcquiring){this.cancelled.delete(jobId);this.emitSnapshot();return;}
        const message=`Render did not start because CineForge could not persist the machine GPU ownership lease: ${error instanceof Error?error.message:String(error)}`;
        const persistenceErrors:string[]=[];
        try{await this.updateJob(jobId,{status:'failed',progress:0,message:'Failed before GPU start',error:message},true,true);}
        catch(updateError){persistenceErrors.push(`job failure state: ${updateError instanceof Error?updateError.message:String(updateError)}`);}
        try{await this.projects.mutate(p=>{const job=p.renderJobs.find(item=>item.id===jobId),shot=job?p.shots.find(item=>item.id===job.shotId):undefined;if(shot&&job){const currentSpec=this.isCurrentJobSpec(p,job,shot);shot.status=shotStatusAfterJobSettlement(shot.status,Boolean(shot.latestRenderId),currentSpec,job.spec?.shot.status,'orphaned');}});}
        catch(updateError){persistenceErrors.push(`shot recovery state: ${updateError instanceof Error?updateError.message:String(updateError)}`);}
        if(persistenceErrors.length)this.recoveryBlockedError=`Render never reached the backend, but CineForge could not persist a trustworthy failure state (${persistenceErrors.join(' | ')}). Reopen the project after resolving storage errors before queueing more work.`;
        this.emitSnapshot();return;
      }
      if(this.cancelled.has(jobId)||!this.pending.includes(jobId)){
        await this.releaseRenderLease(jobId);this.pending=this.pending.filter(id=>id!==jobId);this.cancelled.delete(jobId);return;
      }
      this.pending=this.pending.filter(id=>id!==jobId);
      this.runningJobId=jobId;this.emitSnapshot();
      try{await this.run(jobId);}
      catch(error){
        if(!this.cancelled.has(jobId)){
          const message=error instanceof Error?error.message:String(error);
          await this.updateJob(jobId,{status:'failed',progress:0,message:'Failed',error:message},true,true);
          const current=this.projects.getCurrent(),job=current?.renderJobs.find(j=>j.id===jobId);
          const externalSpecCurrent=job&&current?await this.immutableFilesStillCurrent(current,job):false;
          if(job)await this.projects.mutate(p=>{const shot=p.shots.find(s=>s.id===job.shotId);if(!shot)return;const currentSpec=Boolean(externalSpecCurrent&&this.isCurrentJobSpec(p,job,shot));shot.status=shotStatusAfterJobSettlement(shot.status,Boolean(shot.latestRenderId),currentSpec,job.spec?.shot.status,'failed');});
        }
      }finally{
        await this.cleanupJobSnapshots(jobId);
        this.wanGpProcesses.delete(jobId);this.comfyCancelPromises.delete(jobId);this.cancelled.delete(jobId);
        await this.releaseRenderLease(jobId);
        this.runningJobId=undefined;this.emitSnapshot();
      }
    }finally{
      this.pumping=false;
      if(!this.recoveryBlockedError&&!this.runningJobId&&!this.recoveryPending.length&&this.pending.length)void this.pump();
    }
  }

  private async run(jobId:string):Promise<void>{
    const project=this.requireProject(),job=this.snapshot().jobs.find(j=>j.id===jobId);if(!job?.spec)throw new Error('Render job has no immutable spec.');
    if(job.spec.shot.id!==job.shotId)throw new Error('Render job immutable spec shot identity does not match the job shot.');
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

  private isCurrentJobSpec(project:FilmProject,job:RenderJob,shot:Shot):boolean{
    if(!job.spec)return false;
    let currentProfile:WorkflowProfile,currentPrompt:string;
    try{currentProfile=routeWorkflow(project,shot,job.spec.workflowProfile.id);currentPrompt=buildRenderPrompt(project,shot);}catch{return false;}
    if(job.spec.productionInputKey&&job.spec.productionInputKey!==shotProductionInputKey(project,shot,currentProfile))return false;
    return shotRenderInputKey(shot)===shotRenderInputKey(job.spec.shot)&&currentPrompt===job.spec.effectivePrompt&&workflowExecutionKey(currentProfile)===workflowExecutionKey(job.spec.workflowProfile);
  }

  private async immutableFilesStillCurrent(project:FilmProject,job:RenderJob):Promise<boolean>{
    const spec=job.spec;if(!spec)return false;
    try{
      const workflowPath=await assertExistingPathInside(join(project.rootPath,'workflows'),spec.workflowProfile.workflowPath,`workflow path for ${spec.workflowProfile.name}`);
      if(await sha256File(workflowPath)!==spec.workflowSha256)return false;
      for(const fingerprint of spec.assetFingerprints){
        const asset=project.assets.find(item=>item.id===fingerprint.assetId);if(!asset||asset.projectPath!==fingerprint.projectPath)return false;
        const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
        if(await sha256File(path)!==fingerprint.sha256)return false;
      }
      const runtime=await fingerprintRuntime(this.settings.get(),spec.workflowProfile);
      if(runtime.environmentSha256!==spec.runtimeFingerprint.environmentSha256)return false;
      return true;
    }catch{return false;}
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

  private async stageWanGpInputs(project:FilmProject,job:RenderJob,values:WorkflowValues):Promise<void>{
    const spec=job.spec;if(!spec)throw new Error('Render job has no immutable spec.');
    const expectedByPath=new Map<string,string>();
    for(const fingerprint of spec.assetFingerprints){
      const asset=project.assets.find(item=>item.id===fingerprint.assetId);if(!asset)throw new Error(`Referenced asset was removed after queue: ${fingerprint.assetId}`);
      const source=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
      expectedByPath.set(source,fingerprint.sha256);
    }
    const root=await ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','wangp-inputs',job.id),'WanGP immutable input directory');
    const staged=new Map<string,string>();let index=0;
    const stage=async(source:string):Promise<string>=>{
      const cached=staged.get(source);if(cached)return cached;
      const expected=expectedByPath.get(source);if(!expected)throw new Error(`WanGP input is not covered by the queued asset fingerprint set: ${source}`);
      const safeName=basename(source).replace(/[^a-zA-Z0-9._-]+/g,'_')||'input.bin';
      const target=await assertSafeWritePath(root,join(root,`${String(index++).padStart(2,'0')}-${safeName}`),'WanGP immutable input snapshot');
      await copyFile(source,target);
      if(await sha256File(target)!==expected)throw new Error(`Referenced asset changed while staging the immutable WanGP snapshot: ${basename(source)}. Queue a new render.`);
      staged.set(source,target);return target;
    };
    const scalarKeys=['startImage','endImage','locationImage','characterImage1','characterImage2','characterImage3','characterImage4','propImage1','propImage2','referenceImage1','referenceImage2','referenceImage3','referenceImage4','inputAudio','inputVideo'] as const;
    for(const key of scalarKeys){const value=values[key];if(value)values[key]=await stage(value);}
    if(values.referenceImages)values.referenceImages=await Promise.all(values.referenceImages.map(stage));
  }

  private async runWanGp(project:FilmProject,job:RenderJob):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot,profile=job.spec!.workflowProfile,workflowSnapshotRoot=join(project.rootPath,'cache','workflow-inputs',job.id);
    await this.updateJob(job.id,{status:'preparing',progress:.05,message:`Preparing WanGP · ${profile.name}`},true,true);
    const values=this.baseValues(job);await this.populateLocalReferencePaths(project,shot,profile,values);await this.stageWanGpInputs(project,job,values);
    const snapshotProfile=await stageWorkflowProfileSnapshot(project.rootPath,profile,job.spec!.workflowSha256,workflowSnapshotRoot);
    let compiled=await compileWanGpProfile(snapshotProfile,values);compiled=mapJsonHostPathsForWanGp(project,machine,compiled);
    await this.verifyImmutableSpec(this.requireProject(),job);
    const [cacheDir,outputDir]=await Promise.all([
      ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','wangp'),'WanGP cache directory'),
      ensureSafeDirectory(join(project.rootPath,'renders'),join(project.rootPath,'renders',shot.id,job.id),'WanGP render output directory')
    ]);
    const settingsPath=await assertSafeWritePath(cacheDir,join(cacheDir,`${job.id}.json`),'WanGP job settings');
    await writeFile(settingsPath,JSON.stringify(compiled,null,2),'utf8');

    if(machine.wangp.dryRunBeforeRender){
      await this.updateJob(job.id,{status:'submitted',progress:.08,message:'Submitting WanGP dry-run',backendPid:undefined},true,true);
      const dry=startWanGp(project,machine,{settingsPath,outputDir,dryRun:true,runId:job.id});if(dry.pid)await this.persistBackendIdentity(job.id,{backendPid:dry.pid,status:'submitted',message:'WanGP dry-run submitted'});
      await waitWanGp(dry);if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
      await this.updateJob(job.id,{status:'preparing',progress:.1,message:'WanGP dry-run passed; preparing render',backendPid:undefined},true,true);
      await this.verifyImmutableSpec(this.requireProject(),job);
    }

    let lastLogAt=0;
    await this.updateJob(job.id,{status:'submitted',progress:.12,message:'Submitting to WanGP',backendPid:undefined},true,true);
    const child=startWanGp(project,machine,{settingsPath,outputDir,runId:job.id,onLog:line=>{
      const now=Date.now();if(now-lastLogAt<1000)return;lastLogAt=now;
      void this.updateJob(job.id,{status:'running',progress:.35,message:`WanGP · ${line.slice(0,180)}`,lastHeartbeatAt:new Date().toISOString()},false).catch(()=>undefined);
    }});
    this.wanGpProcesses.set(job.id,child);
    if(child.pid)await this.persistBackendIdentity(job.id,{status:'submitted',progress:.15,message:'Submitted to WanGP',backendPid:child.pid,lastHeartbeatAt:new Date().toISOString()});
    else await this.updateJob(job.id,{status:'submitted',progress:.15,message:'Submitted to WanGP; process id unavailable, recovery will use run identity',lastHeartbeatAt:new Date().toISOString()},true,true);
    await waitWanGp(child);if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
    await this.updateJob(job.id,{status:'downloading',progress:.92,message:'Indexing and QC-checking WanGP outputs'},true,true);
    const files=await collectWanGpOutputs(outputDir);if(!files.length)throw new Error(`WanGP completed but no media outputs were found in ${outputDir}.`);
    await this.finalizeWanGpFiles(project,this.snapshot().jobs.find(j=>j.id===job.id)??job,files);
  }

  private async finalizeWanGpFiles(project:FilmProject,job:RenderJob,files:string[]):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot;const outputs:RenderOutput[]=[];
    for(const path of files){
      const mediaType=outputMediaType(path);const output:RenderOutput={id:randomUUID(),jobId:job.id,shotId:shot.id,path,filename:basename(path),mediaType,createdAt:new Date().toISOString(),productionInputKey:job.spec?.productionInputKey,comfyMeta:{runtime:'wangp',profile:job.spec!.workflowProfile.name}};
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
    const stageImage=async(id:string)=>{const cached=stagedImages.get(id);if(cached)return cached;const staged=await this.stageComfyAsset(project,job,id,client,'image');stagedImages.set(id,staged);return staged;};
    if(shot.startFrameAssetId&&keys.has('startImage'))values.startImage=await stageImage(shot.startFrameAssetId);
    if(shot.endFrameAssetId&&keys.has('endImage'))values.endImage=await stageImage(shot.endFrameAssetId);
    if(plan.locationId)values.locationImage=await stageImage(plan.locationId);
    for(const[index,id]of plan.characterIds.entries())if(id)Object.assign(values,{[`characterImage${index+1}`]:await stageImage(id)});
    for(const[index,id]of plan.propIds.entries())if(id)Object.assign(values,{[`propImage${index+1}`]:await stageImage(id)});
    const genericPaths=await Promise.all(plan.genericIds.map(id=>stageImage(id)));
    if(plan.genericArray)values.referenceImages=genericPaths;
    else for(const[index,key]of plan.genericBindingKeys.entries())Object.assign(values,{[key]:genericPaths[index]});
    if(shot.referenceVideoAssetId&&keys.has('inputVideo'))values.inputVideo=await this.stageComfyAsset(project,job,shot.referenceVideoAssetId,client,'file');
    if(shot.audioAssetId&&keys.has('inputAudio'))values.inputAudio=await this.stageComfyAsset(project,job,shot.audioAssetId,client,'file');
    if(this.cancelled.has(job.id))throw new Error('Job cancelled.');

    const snapshotProfile=await stageWorkflowProfileSnapshot(project.rootPath,profile,job.spec!.workflowSha256,join(project.rootPath,'cache','workflow-inputs',job.id));
    const prompt=await compileProfile(snapshotProfile,values);await this.verifyImmutableSpec(this.requireProject(),job);
    await this.updateJob(job.id,{status:'submitted',progress:.12,message:'Submitting to ComfyUI; backend identity not confirmed yet',comfyPromptId:undefined},true,true);
    let queued:{prompt_id:string};
    try{queued=await client.queuePrompt(prompt,{cineforge:{projectId:project.id,shotId:shot.id,jobId:job.id,modelFamily:shot.generation.modelFamily}});}
    catch(error){
      await this.updateJob(job.id,{status:'stalled',message:`ComfyUI submission response was not confirmed; resolving exact job identity before releasing GPU · ${error instanceof Error?error.message:String(error)}`},false).catch(()=>undefined);
      const promptId=await this.resolveComfyPromptIdentity(job,client);
      if(!promptId)throw error;
      queued={prompt_id:promptId};
    }
    await this.persistBackendIdentity(job.id,{status:'submitted',progress:.15,message:'Submitted to ComfyUI',comfyPromptId:queued.prompt_id,lastHeartbeatAt:new Date().toISOString()});
    if(this.cancelled.has(job.id)){
      try{await this.confirmComfyCancellation(job.id,client,queued.prompt_id);}
      catch(error){
        this.cancelled.delete(job.id);
        await this.updateJob(job.id,{status:'submitted',message:`Cancellation was not confirmed; render continues under the reserved GPU slot · ${error instanceof Error?error.message:String(error)}`},true,true);
      }
      if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
    }
    const history=await this.waitForComfyWithSafeTimeout(client,job,queued.prompt_id,false);
    if(this.cancelled.has(job.id))throw new Error('Job cancelled.');
    await this.finalizeComfyHistory(project,this.snapshot().jobs.find(j=>j.id===job.id)??job,client,history);
  }

  private async finalizeComfyHistory(project:FilmProject,job:RenderJob,client:ComfyClient,history:any):Promise<void>{
    const machine=this.settings.get(),shot=job.spec!.shot;
    await this.updateJob(job.id,{status:'downloading',progress:.92,message:'Saving and QC-checking ComfyUI outputs'},true,true);
    const refs=collectComfyHistoryOutputRefs(history);if(!refs.length)throw new Error('ComfyUI finished but no downloadable output files were found in history.outputs.');
    const outputDir=await ensureSafeDirectory(join(project.rootPath,'renders'),join(project.rootPath,'renders',shot.id,job.id),'ComfyUI render output directory');const outputs:RenderOutput[]=[];
    try{
      for(const ref of refs){
        const safeLeaf=ref.filename.replace(/[\\/]/g,'_').replace(/[^a-zA-Z0-9._-]+/g,'_');const safeSub=(ref.subfolder||'').replace(/[\\/]+/g,'_').replace(/[^a-zA-Z0-9._-]+/g,'_');
        const destination=await assertSafeWritePath(outputDir,join(outputDir,`${String(outputs.length).padStart(2,'0')}-${safeSub?`${safeSub}-`:''}${safeLeaf}`),'ComfyUI output');
        await client.downloadToFile(ref,destination);const mediaType=inferMediaType(ref.filename);const output:RenderOutput={id:randomUUID(),jobId:job.id,shotId:shot.id,path:destination,filename:ref.filename,mediaType,createdAt:new Date().toISOString(),productionInputKey:job.spec?.productionInputKey,comfyMeta:{...ref,runtime:'comfyui'}};
        if(mediaType==='video')output.technicalQc=await technicalQcVideo(machine,destination,shot);outputs.push(output);
      }
    }catch(error){
      await rm(outputDir,{recursive:true,force:true}).catch(cleanupError=>console.warn('Could not remove partial ComfyUI render outputs:',outputDir,cleanupError));
      throw error;
    }
    await this.commitOutputs(job,outputs);
  }

  private async commitOutputs(job:RenderJob,outputs:RenderOutput[]):Promise<void>{
    const currentProject=this.requireProject();
    const newOutputCount=outputs.filter(output=>!currentProject.renderOutputs.some(existing=>existing.id===output.id)).length;
    if(currentProject.renderOutputs.length+newOutputCount>100_000)throw new Error('Render outputs would exceed the 100000-output project safety limit. Remove/archive old takes before attaching more render media.');
    if(!currentProject.shots.some(shot=>shot.id===job.shotId)){
      const detached={...structuredClone(job),status:'orphaned' as const,progress:1,message:'Render completed after its shot was removed; media files were left on disk but were not attached to the project.',error:'The target shot no longer exists in the current project.',outputs:[],updatedAt:new Date().toISOString()};
      this.liveJobs.set(job.id,detached);await this.journal.write(currentProject.rootPath,detached);this.emitSnapshot();return;
    }
    const externalSpecCurrent=await this.immutableFilesStillCurrent(currentProject,job);
    const videos=outputs.filter(o=>o.mediaType==='video'),passing=selectPreferredTechnicalVideo(videos,job.spec?.shot);
    const expectsVideo=(job.spec?.workflowProfile.purpose??'video')==='video';
    const qcFailed=expectsVideo&&(!videos.length||!passing);const now=new Date().toISOString();
    await this.projects.mutate(p=>{
      for(const output of outputs){
        if(!p.renderOutputs.some(existing=>existing.id===output.id))p.renderOutputs.push(output);
        if(output.mediaType==='video'&&output.technicalQc){
          const qcId=`qc:${output.id}:technical`;
          const issues=[
            ...output.technicalQc.issues.map(message=>({code:'TECHNICAL_QC',severity:'major' as const,message})),
            ...(output.technicalQc.warnings??[]).map(message=>({code:'TECHNICAL_QC_WARNING',severity:'warning' as const,message}))
          ];
          const record={id:qcId,shotId:output.shotId,renderOutputId:output.id,layer:'technical' as const,status:output.technicalQc.passed?'pass' as const:'fail' as const,issues,createdAt:output.technicalQc.checkedAt};
          const existing=p.qcResults.find(item=>item.id===qcId);
          if(existing)Object.assign(existing,record);else p.qcResults.push(record);
        }
      }
      const target=p.renderJobs.find(j=>j.id===job.id);const shot=p.shots.find(s=>s.id===job.shotId);
      const currentSpec=Boolean(shot&&externalSpecCurrent&&this.isCurrentJobSpec(p,job,shot));
      if(target){target.outputs=outputs;target.updatedAt=now;target.backendPid=undefined;target.lastHeartbeatAt=now;if(qcFailed){target.status='failed';target.progress=1;target.message=currentSpec?'Rendered but failed technical QC':'Historical snapshot rendered but failed technical QC';target.error=videos.length?videos.flatMap(v=>v.technicalQc?.issues??[]).join(' | '):'Video workflow completed without producing a video output.';}else{target.status='done';target.progress=1;target.message=currentSpec?'Done':'Done · shot changed after queue; take kept as historical output';target.error=undefined;}}
      if(shot){
        const attempt=(passing??videos[0]??outputs[0])?.id;
        if(currentSpec&&attempt)shot.latestAttemptRenderId=attempt;
        if(!currentSpec){if(shot.latestRenderId)shot.status='rendered';else if(shot.status==='rendering'||shot.status==='rendered'||shot.status==='failed')shot.status='ready';}
        else if(qcFailed)shot.status='failed';
        else{shot.status='rendered';shot.latestRenderId=(passing??videos[0]??outputs[0])?.id;}
      }
      const profile=p.settings.workflowProfiles.find(item=>item.id===job.spec?.workflowProfile.id);if(!qcFailed&&canRefreshProfileValidationFromRender(profile,job.spec)){
        const wallSec=Math.max(0,(Date.parse(now)-Date.parse(job.createdAt))/1000);
        profile!.validation={
          ...profile!.validation!,
          lastSuccessfulRenderAt:now,
          successfulRenderCount:(profile!.validation?.successfulRenderCount??0)+1,
          lastRenderWallSec:Number.isFinite(wallSec)?wallSec:undefined,
          lastRenderWidth:job.spec?.shot.generation.width,
          lastRenderHeight:job.spec?.shot.generation.height,
          lastRenderFrames:job.spec?.shot.generation.frames
        };
      }
    });
    // The backend is already terminal and the project summary is durable. Clear the machine
    // GPU lease before the final signed-journal refresh so a crash here cannot make an older
    // active journal outrank this newer terminal project state solely because a stale lease survived.
    await this.releaseRenderLease(job.id);
    const current=this.projects.getCurrent()?.renderJobs.find(j=>j.id===job.id);if(current){this.liveJobs.set(job.id,structuredClone(current));await this.journal.write(this.requireProject().rootPath,current);}
    this.emitSnapshot();
  }

  private async stageComfyAsset(project:FilmProject,job:RenderJob,assetId:string,client:ComfyClient,kind:'image'|'file'):Promise<string>{
    const asset=project.assets.find(a=>a.id===assetId);if(!asset)throw new Error(`Referenced asset not found: ${assetId}`);
    const fingerprint=job.spec?.assetFingerprints.find(item=>item.assetId===assetId);
    if(!fingerprint||fingerprint.projectPath!==asset.projectPath)throw new Error(`ComfyUI input is not covered by the queued immutable asset snapshot: ${asset.name}`);
    const absolute=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`),machine=this.settings.get();
    const safeName=`${asset.id}-${basename(asset.projectPath).replace(/[^a-zA-Z0-9._-]+/g,'_')}`;
    if(machine.comfy.inputDir){
      const subfolder=join('cineforge',project.id),targetDir=await ensureSafeDirectory(machine.comfy.inputDir,join(machine.comfy.inputDir,subfolder),'ComfyUI input staging directory');
      const target=await assertSafeWritePath(machine.comfy.inputDir,join(targetDir,safeName),'ComfyUI input staging');
      await copyFile(absolute,target);
      if(await sha256File(target)!==fingerprint.sha256){await rm(target,{force:true}).catch(()=>undefined);throw new Error(`Referenced asset changed while staging the immutable ComfyUI snapshot: ${asset.name}. Queue a new render.`);}
      return`${subfolder.replace(/\\/g,'/')}/${safeName}`;
    }
    if(kind==='image'){
      const snapshotRoot=await ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','comfy-inputs',job.id),'ComfyUI immutable upload snapshot directory');
      const snapshot=await assertSafeWritePath(snapshotRoot,join(snapshotRoot,safeName),'ComfyUI immutable upload snapshot');
      try{
        await copyFile(absolute,snapshot);
        if(await sha256File(snapshot)!==fingerprint.sha256)throw new Error(`Referenced asset changed while staging the immutable ComfyUI snapshot: ${asset.name}. Queue a new render.`);
        const uploaded=await client.uploadImage(snapshot);return uploaded.subfolder?`${uploaded.subfolder}/${uploaded.filename}`:uploaded.filename;
      }finally{await rm(snapshot,{force:true}).catch(()=>undefined);}
    }
    throw new Error('Audio/video input requires the local ComfyUI input directory in Machine Settings.');
  }

  private async updateJob(jobId:string,patch:Partial<RenderJob>,persistSummary=false,forceJournal=false):Promise<void>{
    const project=this.requireProject(),base=this.liveJobs.get(jobId)??project.renderJobs.find(j=>j.id===jobId);if(!base)return;
    const normalizedPatch={...patch};
    if(typeof normalizedPatch.message==='string'&&normalizedPatch.message.length>10_000)normalizedPatch.message=normalizedPatch.message.slice(0,10_000);
    if(typeof normalizedPatch.error==='string'&&normalizedPatch.error.length>50_000)normalizedPatch.error=normalizedPatch.error.slice(0,50_000);
    const next={...structuredClone(base),...normalizedPatch,updatedAt:new Date().toISOString()} as RenderJob;
    const now=Date.now(),last=this.lastJournalWrite.get(jobId)??0,writeJournal=forceJournal||now-last>=1500;
    if(writeJournal){await this.journal.write(project.rootPath,next);this.lastJournalWrite.set(jobId,now);}
    this.liveJobs.set(jobId,next);
    if(persistSummary)await this.projects.mutate(p=>{const target=p.renderJobs.find(j=>j.id===jobId);if(target)Object.assign(target,next);const shot=p.shots.find(s=>s.id===next.shotId);if(shot&&['preparing','uploading','submitted','running','recovering','stalled','downloading'].includes(next.status))shot.status='rendering';});
    this.emitSnapshot();
  }

  private emitSnapshot():void{this.emit('snapshot',this.snapshot());}
}

function collectReferencedAssetIds(shot:Shot):string[]{return[...new Set([...shot.characterAssetIds,...shot.propAssetIds,...(shot.referenceAssetIds??[]),shot.locationAssetId,shot.startFrameAssetId,shot.endFrameAssetId,shot.referenceVideoAssetId,shot.audioAssetId].filter((v):v is string=>Boolean(v)))];}
function assetLine(asset:Asset|undefined,label:string):string{
  if(!asset)return'';
  const continuity=asset.continuity?JSON.stringify(asset.continuity):'';
  const bible=continuity?(continuity.length>20_000?continuity.slice(0,20_000):continuity):'';
  return`${label}: ${asset.name}${asset.notes.trim()?` — ${asset.notes.trim()}`:''}${bible?`\nStructured continuity bible: ${bible}`:''}`;
}
export function selectPreferredTechnicalVideo(videos:RenderOutput[],shot?:Shot):RenderOutput|undefined{
  const passing=videos.filter(output=>output.technicalQc?.passed===true);
  if(!passing.length)return undefined;
  const expectedDuration=shot?shot.generation.frames/Math.max(1,shot.generation.fps):undefined;
  return[...passing].sort((a,b)=>{
    const qa=a.technicalQc!,qb=b.technicalQc!;
    const warningDelta=(qa.warnings?.length??0)-(qb.warnings?.length??0);
    if(warningDelta)return warningDelta;
    if(expectedDuration!=null){
      const da=qa.durationSec==null?Number.POSITIVE_INFINITY:Math.abs(qa.durationSec-expectedDuration);
      const db=qb.durationSec==null?Number.POSITIVE_INFINITY:Math.abs(qb.durationSec-expectedDuration);
      if(da!==db)return da-db;
    }
    return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);
  })[0];
}

function stateLine(project:FilmProject,stateId:string|undefined,label:string):string{
  const state=currentGenerationState(project,stateId);
  if(!state)return'';
  const payload={
    characters:state.characters,props:state.props,environment:state.environment,camera:state.camera,
    actionPhase:state.actionPhase,dialogueState:state.dialogueState,confidence:state.confidence
  };
  const text=JSON.stringify(payload);
  return`${label}: ${text.length>30_000?text.slice(0,30_000):text}`;
}
export function buildRenderPrompt(project:FilmProject,shot:Shot):string{
  const characters=shot.characterAssetIds.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[];
  const refs=(shot.referenceAssetIds??[]).map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[];
  const props=shot.propAssetIds.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[];
  const location=shot.locationAssetId?project.assets.find(a=>a.id===shot.locationAssetId):undefined;
  const actualStart=stateLine(project,shot.actualStartStateId,'AUTHORITATIVE actual start state');
  const plannedStart=actualStart?'':stateLine(project,shot.plannedStartStateId,'Planned start state');
  const targetEnd=stateLine(project,shot.plannedEndStateId,'Target end state');
  const prompt=[
    shot.prompt.trim(),shot.camera.trim()?`Camera: ${shot.camera.trim()}`:'',shot.action.trim()?`Action: ${shot.action.trim()}`:'',
    shot.dialogue.trim()?`Dialogue/audio: ${shot.dialogue.trim()}`:'',location?assetLine(location,'Location continuity'):'',
    ...characters.map(a=>assetLine(a,'Character continuity')),...refs.map(a=>assetLine(a,'Visual reference')),...props.map(a=>assetLine(a,'Prop / wardrobe continuity')),
    actualStart,plannedStart,targetEnd,
    actualStart?'State precedence: the authoritative actual start state overrides any older/planned start state.':'',
    shot.continuityNotes.trim()?`Continuity: ${shot.continuityNotes.trim()}`:''
  ].filter(Boolean).join('\n');
  if(prompt.length>300_000)throw new Error(`Effective render prompt exceeds the 300000-character immutable job safety limit for ${shot.title}. Shorten shot text, structured continuity state, or attached asset notes before queueing.`);
  return prompt;
}
function sleep(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
