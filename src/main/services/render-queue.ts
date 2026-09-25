import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Asset, FilmProject, QueueSnapshot, RenderBatchRequest, RenderJob, RenderJobSpec, RenderOutput, RenderRequest, Shot, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { ComfyClient } from './comfy-client';
import { compileProfile, type WorkflowValues } from './workflow-engine';
import { compileWanGpProfile } from './wangp-engine';
import { collectWanGpOutputs, outputMediaType, startWanGp, waitWanGp } from './wangp-runner';
import { routeWorkflow } from './model-router';
import { collectComfyFileRefs, inferMediaType, uniqueComfyFileRefs } from './comfy-output';
import { waitForComfyCompletion } from './comfy-runner';
import { assertPathInside, assertRelativeProjectPath } from './path-safety';

export class RenderQueueService extends EventEmitter {
  private pending: string[] = [];
  private runningJobId?: string;
  private cancelled = new Set<string>();
  private wanGpProcesses = new Map<string, ChildProcess>();

  constructor(private projects: ProjectService) { super(); }

  snapshot(): QueueSnapshot {
    const project = this.projects.getCurrent();
    return { runningJobId: this.runningJobId, jobs: project?.renderJobs ?? [] };
  }

  isBusy(): boolean { return Boolean(this.runningJobId || this.pending.length); }

  async enqueue(request: RenderRequest): Promise<QueueSnapshot> {
    const project = this.requireProject();
    if (project.rootPath !== request.projectRoot) throw new Error('Render request does not match the open project.');
    const shot = project.shots.find(s => s.id === request.shotId);
    if (!shot) throw new Error('Shot not found.');
    const profile = routeWorkflow(project, shot, request.forceWorkflowProfileId);
    const job = await this.createJob(project, shot, profile);
    await this.commitQueuedJobs([job]);
    return this.snapshot();
  }

  async enqueueBatch(request: RenderBatchRequest): Promise<QueueSnapshot> {
    const project = this.requireProject();
    if (project.rootPath !== request.projectRoot) throw new Error('Batch render request does not match the open project.');
    const ids = [...new Set(request.shotIds)];
    if (ids.length === 0) return this.snapshot();
    const jobs: RenderJob[] = [];
    for (const id of ids) {
      const shot = project.shots.find(s => s.id === id);
      if (!shot) throw new Error(`Shot not found: ${id}`);
      if (request.skipIfRendered && shot.latestRenderId) continue;
      if (this.hasActiveJobForShot(project, shot.id)) continue;
      const profile = routeWorkflow(project, shot);
      jobs.push(await this.createJob(project, shot, profile));
    }
    if (jobs.length) await this.commitQueuedJobs(jobs);
    return this.snapshot();
  }

  async retry(jobId: string): Promise<QueueSnapshot> {
    const project = this.requireProject();
    const prior = project.renderJobs.find(j => j.id === jobId);
    if (!prior) throw new Error('Render job not found.');
    if (prior.spec) {
      const now = new Date().toISOString();
      const retry: RenderJob = {
        id: randomUUID(), shotId: prior.shotId, createdAt: now, updatedAt: now,
        status: 'queued', progress: 0, message: `Retry of ${prior.id.slice(0, 8)} · immutable snapshot`,
        modelFamily: prior.spec.shot.generation.modelFamily, workflowProfileId: prior.spec.workflowProfile.id,
        outputs: [], spec: structuredClone(prior.spec)
      };
      await this.commitQueuedJobs([retry]);
      return this.snapshot();
    }
    return this.enqueue({ projectRoot: project.rootPath, shotId: prior.shotId, forceWorkflowProfileId: prior.workflowProfileId });
  }

  async cancel(jobId: string): Promise<QueueSnapshot> {
    const project = this.requireProject();
    const job = project.renderJobs.find(j => j.id === jobId);
    if (!job) throw new Error('Render job not found.');
    if (['done', 'failed', 'cancelled'].includes(job.status)) return this.snapshot();

    this.cancelled.add(jobId);
    this.pending = this.pending.filter(id => id !== jobId);
    const wasRunning = this.runningJobId === jobId;
    if (wasRunning) {
      const runtime = job.spec?.workflowProfile.runtime ?? 'comfyui';
      if (runtime === 'wangp') {
        this.wanGpProcesses.get(jobId)?.kill('SIGINT');
      } else {
        await new ComfyClient(project.settings.comfyUrl, project.settings.localOnly).interrupt().catch(() => undefined);
      }
    }

    await this.projects.mutate(p => {
      const target = p.renderJobs.find(j => j.id === jobId);
      if (target) Object.assign(target, { status: 'cancelled', progress: 0, message: 'Cancelled', updatedAt: new Date().toISOString() });
      const shot = p.shots.find(s => s.id === job.shotId);
      if (shot) shot.status = shot.latestRenderId ? 'rendered' : 'draft';
    });
    if (!wasRunning) this.cancelled.delete(jobId);
    this.emitSnapshot();
    if (!wasRunning) void this.pump();
    return this.snapshot();
  }

  private requireProject(): FilmProject {
    const project = this.projects.getCurrent();
    if (!project) throw new Error('Open a project first.');
    return project;
  }

  private async createJob(project: FilmProject, shot: Shot, profile: WorkflowProfile): Promise<RenderJob> {
    const now = new Date().toISOString();
    const workflowPath = assertPathInside(join(project.rootPath, 'workflows'), profile.workflowPath, `workflow path for ${profile.name}`);
    const workflowSha256 = sha256(await readFile(workflowPath));
    const spec: RenderJobSpec = {
      shot: structuredClone(shot), workflowProfile: structuredClone(profile), effectivePrompt: buildPrompt(project, shot),
      queuedProjectUpdatedAt: project.updatedAt, workflowSha256
    };
    return {
      id: randomUUID(), shotId: shot.id, createdAt: now, updatedAt: now, status: 'queued', progress: 0,
      message: 'Waiting', modelFamily: shot.generation.modelFamily, workflowProfileId: profile.id, outputs: [], spec
    };
  }

  private async commitQueuedJobs(jobs: RenderJob[]): Promise<void> {
    if (!jobs.length) return;
    await this.projects.mutate(project => {
      project.renderJobs.unshift(...[...jobs].reverse());
      for (const job of jobs) {
        const shot = project.shots.find(s => s.id === job.shotId);
        if (shot) shot.status = 'queued';
      }
    });
    this.pending.push(...jobs.map(j => j.id));
    this.emitSnapshot();
    void this.pump();
  }

  private hasActiveJobForShot(project: FilmProject, shotId: string): boolean {
    return project.renderJobs.some(j => j.shotId === shotId && ['queued','preparing','uploading','submitted','running','downloading'].includes(j.status));
  }

  private async pump(): Promise<void> {
    if (this.runningJobId || this.pending.length === 0) return;
    const jobId = this.pending.shift()!;
    if (this.cancelled.has(jobId)) { this.cancelled.delete(jobId); return void this.pump(); }
    this.runningJobId = jobId;
    this.emitSnapshot();
    try {
      await this.run(jobId);
    } catch (error) {
      if (!this.cancelled.has(jobId)) {
        await this.updateJob(jobId, { status: 'failed', progress: 0, message: 'Failed', error: error instanceof Error ? error.message : String(error) });
        const current = this.projects.getCurrent();
        const job = current?.renderJobs.find(j => j.id === jobId);
        if (job) await this.projects.mutate(p => { const shot = p.shots.find(s => s.id === job.shotId); if (shot) shot.status = 'failed'; });
      }
    } finally {
      this.wanGpProcesses.delete(jobId);
      this.cancelled.delete(jobId);
      this.runningJobId = undefined;
      this.emitSnapshot();
      void this.pump();
    }
  }

  private async run(jobId: string): Promise<void> {
    const project = this.requireProject();
    const job = project.renderJobs.find(j => j.id === jobId);
    if (!job) throw new Error('Render job disappeared.');
    const currentShot = project.shots.find(s => s.id === job.shotId);
    if (!currentShot) throw new Error('Shot not found.');
    const shot = job.spec?.shot ?? currentShot;
    const profile = job.spec?.workflowProfile ?? routeWorkflow(project, currentShot, job.workflowProfileId);

    await this.verifyImmutableWorkflow(project, job, profile);
    const runtime = profile.runtime ?? (profile.workflowFormat === 'wangp-settings' ? 'wangp' : 'comfyui');
    if (runtime === 'wangp') await this.runWanGp(project, jobId, shot, profile);
    else await this.runComfy(project, jobId, shot, profile);
  }

  private async verifyImmutableWorkflow(project: FilmProject, job: RenderJob, profile: WorkflowProfile): Promise<void> {
    if (!job.spec?.workflowSha256) return;
    const path = assertPathInside(join(project.rootPath, 'workflows'), profile.workflowPath, `workflow path for ${profile.name}`);
    if (sha256(await readFile(path)) !== job.spec.workflowSha256) {
      throw new Error(`Workflow changed after this job was queued (${profile.name}). Queue a new render or restore the original file before retrying.`);
    }
  }

  private baseValues(project: FilmProject, jobId: string, shot: Shot): WorkflowValues {
    const job = project.renderJobs.find(j=>j.id===jobId);
    return {
      prompt: job?.spec?.effectivePrompt ?? buildPrompt(project, shot), negativePrompt: shot.generation.negativePrompt,
      width: shot.generation.width, height: shot.generation.height, frames: shot.generation.frames, fps: shot.generation.fps,
      steps: shot.generation.steps, cfg: shot.generation.cfg, seed: shot.generation.seed,
      filenamePrefix: `cineforge/${shot.id}/${jobId}`
    };
  }

  private localAssetPath(project: FilmProject, assetId: string): string {
    const asset = project.assets.find(a=>a.id===assetId);
    if (!asset) throw new Error(`Referenced asset not found: ${assetId}`);
    return assertRelativeProjectPath(project.rootPath, asset.projectPath, 'assets', `asset path for ${asset.name}`);
  }

  private populateLocalReferencePaths(project: FilmProject, shot: Shot, values: WorkflowValues): void {
    if (shot.startFrameAssetId) values.startImage = this.localAssetPath(project, shot.startFrameAssetId);
    if (shot.endFrameAssetId) values.endImage = this.localAssetPath(project, shot.endFrameAssetId);
    if (shot.locationAssetId) values.locationImage = this.localAssetPath(project, shot.locationAssetId);
    shot.characterAssetIds.slice(0,4).forEach((id,i)=>Object.assign(values,{[`characterImage${i+1}`]:this.localAssetPath(project,id)}));
    shot.propAssetIds.slice(0,2).forEach((id,i)=>Object.assign(values,{[`propImage${i+1}`]:this.localAssetPath(project,id)}));
    collectReferenceAssets(project,shot).slice(0,4).forEach((a,i)=>Object.assign(values,{[`referenceImage${i+1}`]:this.localAssetPath(project,a.id)}));
    if (shot.referenceVideoAssetId) values.inputVideo = this.localAssetPath(project, shot.referenceVideoAssetId);
    if (shot.audioAssetId) values.inputAudio = this.localAssetPath(project, shot.audioAssetId);
  }

  private async runWanGp(project: FilmProject, jobId: string, shot: Shot, profile: WorkflowProfile): Promise<void> {
    if (!project.settings.wangp.rootPath.trim()) throw new Error('WanGP root path is not configured in Settings.');
    await this.updateJob(jobId,{status:'preparing',progress:0.05,message:`Preparing WanGP · ${profile.name}`});
    const values = this.baseValues(project,jobId,shot);
    this.populateLocalReferencePaths(project,shot,values);
    const compiled = await compileWanGpProfile(profile,values);
    const cacheDir = join(project.rootPath,'cache','wangp');
    const outputDir = join(project.rootPath,'renders',shot.id,jobId);
    await Promise.all([mkdir(cacheDir,{recursive:true}),mkdir(outputDir,{recursive:true})]);
    const settingsPath = join(cacheDir,`${jobId}.json`);
    await writeFile(settingsPath,JSON.stringify(compiled,null,2),'utf8');

    if (project.settings.wangp.dryRunBeforeRender) {
      await this.updateJob(jobId,{status:'preparing',progress:0.08,message:'WanGP dry-run validation'});
      const dry = startWanGp(project,{settingsPath,outputDir,dryRun:true});
      this.wanGpProcesses.set(jobId,dry);
      await waitWanGp(dry);
      if (this.cancelled.has(jobId)) throw new Error('Job cancelled.');
    }

    let lastLog = '';
    const child = startWanGp(project,{settingsPath,outputDir,onLog:line=>{lastLog=line.slice(0,180); void this.updateJob(jobId,{status:'running',progress:0.35,message:`WanGP · ${lastLog}`}).catch(()=>undefined);}});
    this.wanGpProcesses.set(jobId,child);
    await this.updateJob(jobId,{status:'submitted',progress:0.15,message:'Submitted to WanGP headless runtime'});
    await waitWanGp(child);
    if (this.cancelled.has(jobId)) throw new Error('Job cancelled.');
    await this.updateJob(jobId,{status:'downloading',progress:0.92,message:'Indexing WanGP outputs'});
    const files = await collectWanGpOutputs(outputDir);
    if (!files.length) throw new Error(`WanGP completed but no media outputs were found in ${outputDir}.`);
    const outputs: RenderOutput[] = files.map(path=>({
      id:randomUUID(),jobId,shotId:shot.id,path,filename:basename(path),mediaType:outputMediaType(path),createdAt:new Date().toISOString(),
      comfyMeta:{runtime:'wangp',profile:profile.name}
    }));
    await this.completeJob(jobId,shot.id,outputs);
  }

  private async runComfy(project: FilmProject, jobId: string, shot: Shot, profile: WorkflowProfile): Promise<void> {
    const client = new ComfyClient(project.settings.comfyUrl, project.settings.localOnly);
    await this.updateJob(jobId,{status:'preparing',progress:0.05,message:`Preparing ComfyUI · ${profile.name}`});
    const ping = await client.ping();
    if (!ping.reachable) throw new Error(`ComfyUI unavailable at ${project.settings.comfyUrl}: ${ping.error || 'unknown error'}`);
    const values = this.baseValues(project,jobId,shot);
    await this.updateJob(jobId,{status:'uploading',progress:0.1,message:'Staging continuity references'});
    if (shot.startFrameAssetId) values.startImage=await this.stageComfyAsset(project,shot.startFrameAssetId,client,'image');
    if (shot.endFrameAssetId) values.endImage=await this.stageComfyAsset(project,shot.endFrameAssetId,client,'image');
    if (shot.locationAssetId) values.locationImage=await this.stageComfyAsset(project,shot.locationAssetId,client,'image');
    for (const [i,id] of shot.characterAssetIds.slice(0,4).entries()) Object.assign(values,{[`characterImage${i+1}`]:await this.stageComfyAsset(project,id,client,'image')});
    for (const [i,id] of shot.propAssetIds.slice(0,2).entries()) Object.assign(values,{[`propImage${i+1}`]:await this.stageComfyAsset(project,id,client,'image')});
    for (const [i,a] of collectReferenceAssets(project,shot).slice(0,4).entries()) Object.assign(values,{[`referenceImage${i+1}`]:await this.stageComfyAsset(project,a.id,client,'image')});
    if (shot.referenceVideoAssetId) values.inputVideo=await this.stageComfyAsset(project,shot.referenceVideoAssetId,client,'file');
    if (shot.audioAssetId) values.inputAudio=await this.stageComfyAsset(project,shot.audioAssetId,client,'file');
    if (this.cancelled.has(jobId)) throw new Error('Job cancelled.');

    const prompt = await compileProfile(profile,values);
    const queued = await client.queuePrompt(prompt,{cineforge:{projectId:project.id,shotId:shot.id,jobId,modelFamily:shot.generation.modelFamily}});
    await this.updateJob(jobId,{status:'submitted',progress:0.15,message:'Submitted to ComfyUI',comfyPromptId:queued.prompt_id});
    const history=await waitForComfyCompletion(client,queued.prompt_id,{cancelled:()=>this.cancelled.has(jobId),onTick:elapsed=>this.cancelled.has(jobId)?undefined:this.updateJob(jobId,{status:'running',progress:0.35,message:`ComfyUI · ${elapsed}s`})});
    if (this.cancelled.has(jobId)) throw new Error('Job cancelled.');
    await this.updateJob(jobId,{status:'downloading',progress:0.92,message:'Saving ComfyUI outputs'});
    const refs=uniqueComfyFileRefs(collectComfyFileRefs(history?.outputs||history));
    if (!refs.length) throw new Error('ComfyUI finished but no downloadable output files were found in history.');
    const outputDir=join(project.rootPath,'renders',shot.id,jobId); await mkdir(outputDir,{recursive:true});
    const outputs:RenderOutput[]=[];
    for (const ref of refs) {
      const bytes=await client.download(ref);
      const safeLeaf=ref.filename.replace(/[\\/]/g,'_').replace(/[^a-zA-Z0-9._-]+/g,'_');
      const safeSubfolder=(ref.subfolder||'').replace(/[\\/]+/g,'_').replace(/[^a-zA-Z0-9._-]+/g,'_');
      const destination=join(outputDir,`${String(outputs.length).padStart(2,'0')}-${safeSubfolder?`${safeSubfolder}-`:''}${safeLeaf}`);
      await writeFile(destination,bytes);
      outputs.push({id:randomUUID(),jobId,shotId:shot.id,path:destination,filename:ref.filename,mediaType:inferMediaType(ref.filename),createdAt:new Date().toISOString(),comfyMeta:{...ref,runtime:'comfyui'}});
    }
    await this.completeJob(jobId,shot.id,outputs);
  }

  private async completeJob(jobId:string,shotId:string,outputs:RenderOutput[]):Promise<void>{
    await this.projects.mutate(p=>{
      const j=p.renderJobs.find(x=>x.id===jobId); const s=p.shots.find(x=>x.id===shotId);
      if(j){j.status='done';j.progress=1;j.message='Done';j.outputs=outputs;j.updatedAt=new Date().toISOString();}
      p.renderOutputs.push(...outputs);
      if(s){s.status='rendered'; const video=outputs.find(o=>o.mediaType==='video')||outputs[0]; s.latestRenderId=video?.id;}
    });
  }

  private async stageComfyAsset(project: FilmProject, assetId: string, client: ComfyClient, kind: 'image' | 'file'): Promise<string> {
    const asset = project.assets.find(a => a.id === assetId);
    if (!asset) throw new Error(`Referenced asset not found: ${assetId}`);
    const absolute = assertRelativeProjectPath(project.rootPath, asset.projectPath, 'assets', `asset path for ${asset.name}`);
    if (project.settings.comfyInputDir) {
      const subfolder = join('cineforge', project.id); const targetDir = join(project.settings.comfyInputDir, subfolder); await mkdir(targetDir,{recursive:true});
      const safeName=`${asset.id}-${basename(asset.projectPath).replace(/[^a-zA-Z0-9._-]+/g,'_')}`; await copyFile(absolute,join(targetDir,safeName));
      return `${subfolder.replace(/\\/g,'/')}/${safeName}`;
    }
    if(kind==='image'){const uploaded=await client.uploadImage(absolute);return uploaded.subfolder?`${uploaded.subfolder}/${uploaded.filename}`:uploaded.filename;}
    throw new Error('Audio/video input requires the local ComfyUI input directory in Settings.');
  }

  private async updateJob(jobId:string,patch:Partial<RenderJob>):Promise<void>{
    await this.projects.mutate(project=>{const job=project.renderJobs.find(j=>j.id===jobId);if(!job)return;Object.assign(job,patch,{updatedAt:new Date().toISOString()});const shot=project.shots.find(s=>s.id===job.shotId);if(shot&&['preparing','uploading','submitted','running','downloading'].includes(job.status))shot.status='rendering';});
    this.emitSnapshot();
  }
  private emitSnapshot():void{this.emit('snapshot',this.snapshot());}
}

function sha256(value:Uint8Array):string{return createHash('sha256').update(value).digest('hex');}
function assetLine(asset:Asset|undefined,label:string):string{if(!asset)return '';return `${label}: ${asset.name}${asset.notes.trim()?` — ${asset.notes.trim()}`:''}`;}
function buildPrompt(project:FilmProject,shot:Shot):string{
  const characters=shot.characterAssetIds.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[];
  const props=shot.propAssetIds.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean) as Asset[];
  const location=shot.locationAssetId?project.assets.find(a=>a.id===shot.locationAssetId):undefined;
  return [shot.prompt.trim(),shot.camera.trim()?`Camera: ${shot.camera.trim()}`:'',shot.action.trim()?`Action: ${shot.action.trim()}`:'',shot.dialogue.trim()?`Dialogue/audio: ${shot.dialogue.trim()}`:'',location?assetLine(location,'Location continuity'):'',...characters.map(a=>assetLine(a,'Character continuity')),...props.map(a=>assetLine(a,'Prop continuity')),shot.continuityNotes.trim()?`Continuity: ${shot.continuityNotes.trim()}`:''].filter(Boolean).join('\n');
}
function collectReferenceAssets(project:FilmProject,shot:Shot):Asset[]{const ids=new Set<string>([...shot.characterAssetIds,...shot.propAssetIds]);if(shot.locationAssetId)ids.add(shot.locationAssetId);if(shot.startFrameAssetId)ids.add(shot.startFrameAssetId);if(shot.endFrameAssetId)ids.add(shot.endFrameAssetId);return [...ids].map(id=>project.assets.find(a=>a.id===id)).filter((a):a is Asset=>Boolean(a));}
