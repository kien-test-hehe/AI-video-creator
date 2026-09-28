import { EventEmitter } from 'node:events';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AutomationRunRequest, AutomationStatus, FilmProject, QcLayer, RenderOutput, Shot } from '../../shared/types';
import { canonicalTakeReadiness, currentProductionInputKeyForOutput, invalidateObservedFinalState, renderOutputProductionInputKey, shotQcInputKey } from '../../shared/production-state';
import { ProjectService } from './project-service';
import { AppSettingsService } from './app-settings-service';
import { RenderQueueService } from './render-queue';
import { preflightProject } from './preflight-service';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertSafeWritePath } from './path-safety';
import { sampleVideoFrames, type SampledVideoFrames } from './media-analysis';
import { evaluateContinuityQc, evaluateSemanticQc, evaluateVisualQc, extractObservedStateDraft } from './automatic-qc-service';
import { createHumanTask, recordObservedFinalState, recordShotQc } from './production-state-service';
import { ensurePrevizPlan } from './previz-service';

const ACTIVE_RENDER=new Set(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);

export class ProductionRuntimeService extends EventEmitter{
  private status:AutomationStatus={running:false,paused:false,phase:'idle',message:'Automation is idle.',updatedAt:new Date().toISOString(),completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]};
  private targetShotIds:string[]=[];
  private maxAutoRetries=2;
  private buildTimeline=true;
  private advancing=false;
  private advanceAgain=false;

  constructor(private projects:ProjectService,private queue:RenderQueueService,private settings:AppSettingsService){
    super();
    this.queue.on('snapshot',()=>this.wake());
  }

  snapshot():AutomationStatus{return structuredClone(this.status);}

  async start(request:AutomationRunRequest):Promise<AutomationStatus>{
    if(this.status.running)throw new Error('Autonomous production is already running.');
    const project=this.projects.getCurrent();if(!project)throw new Error('Open a project first.');
    if(project.rootPath!==request.projectRoot)throw new Error('Automation request does not match the open project.');
    const ordered=orderedShots(project);
    const requested=request.shotIds?.length?new Set(request.shotIds):undefined;
    this.targetShotIds=ordered.filter(shot=>!requested||requested.has(shot.id)).map(shot=>shot.id);
    if(requested&&this.targetShotIds.length!==requested.size)throw new Error('Automation request contains an unknown shot id.');
    if(!this.targetShotIds.length)throw new Error('There are no shots to automate.');
    this.maxAutoRetries=Math.max(0,Math.min(5,Math.trunc(request.maxAutoRetries??2)));
    this.buildTimeline=request.buildTimeline!==false;
    this.status={running:true,paused:false,phase:'preflight',projectRoot:project.rootPath,message:'Running production preflight…',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]};
    this.emitStatus();
    const report=await preflightProject(project,this.settings.get());
    if(!report.ready){
      const detail=report.issues.filter(issue=>issue.level==='error').slice(0,8).map(issue=>`${issue.code}: ${issue.message}`).join(' | ');
      this.fail(`Preflight blocked autonomous production. ${detail}`);
      return this.snapshot();
    }
    this.setStatus({phase:'planning',message:'Preflight passed. Advancing the production graph.'});
    this.wake();return this.snapshot();
  }

  pause():AutomationStatus{
    if(!this.status.running)return this.snapshot();
    this.status.paused=true;this.setStatus({phase:'paused',message:'Automation paused after the current atomic operation.'});
    return this.snapshot();
  }

  resume():AutomationStatus{
    if(!this.status.running)throw new Error('No autonomous production run is active.');
    this.status.paused=false;this.setStatus({phase:'planning',message:'Automation resumed.'});this.wake();return this.snapshot();
  }

  stop():AutomationStatus{
    this.status.running=false;this.status.paused=false;this.targetShotIds=[];
    this.setStatus({phase:'idle',currentShotId:undefined,message:'Automation stopped.',blockedHumanTaskIds:[]});
    return this.snapshot();
  }

  wake():void{
    if(!this.status.running||this.status.paused)return;
    if(this.advancing){this.advanceAgain=true;return;}
    queueMicrotask(()=>void this.advance());
  }

  private async advance():Promise<void>{
    if(this.advancing||!this.status.running||this.status.paused)return;
    this.advancing=true;
    try{
      do{
        this.advanceAgain=false;
        if(!this.status.running||this.status.paused)break;
        let project=this.projects.getCurrent();
        if(!project||project.rootPath!==this.status.projectRoot){this.fail('The open project changed while automation was running.');break;}
        let shot=this.nextIncompleteShot(project);
        if(!shot){await this.finish();break;}
        this.setStatus({currentShotId:shot.id,blockedHumanTaskIds:[]});
        await this.ensureShotPreviz(shot.id);
        project=this.projects.getCurrent();
        if(!project){this.fail('Project closed while preparing previz.');break;}
        shot=project.shots.find(item=>item.id===shot!.id);
        if(!shot){this.fail('Current shot disappeared while preparing previz.');break;}

        const blockers=project.humanTasks.filter(task=>task.status==='open'&&task.shotId===shot.id);
        if(blockers.length){
          this.setStatus({phase:'waiting-human',message:`Human review required for ${shot.title}.`,blockedHumanTaskIds:blockers.map(task=>task.id)});
          break;
        }
        if(shot.previz?.requirement==='required'&&shot.previz.status!=='ready'){
          await this.ensureHumanTask(shot,'verify-previz','3D previz required',`Shot “${shot.title}” is marked as requiring previz before generation.`,'Create or approve the Blender previz, attach its reference/preview, then mark previz ready.');
          const fresh=this.projects.getCurrent();
          const ids=fresh?.humanTasks.filter(task=>task.status==='open'&&task.shotId===shot.id).map(task=>task.id)??[];
          this.setStatus({phase:'waiting-human',message:`Previz is required for ${shot.title}.`,blockedHumanTaskIds:ids});break;
        }

        const queueSnapshot=this.queue.snapshot();
        if(queueSnapshot.jobs.some(job=>job.shotId===shot.id&&ACTIVE_RENDER.has(job.status))){
          this.setStatus({phase:'waiting-render',message:`Waiting for ${shot.title} render to finish.`});break;
        }

        const currentOutput=findCurrentPassingTake(project,shot);
        if(currentOutput){
          this.setStatus({phase:'qc',message:`Extracting actual state and QC for ${shot.title}.`});
          await this.processTake(shot.id,currentOutput.id);
          const fresh=this.projects.getCurrent();if(!fresh)break;
          const freshShot=fresh.shots.find(item=>item.id===shot.id);
          if(freshShot?.canonicalRenderId&&canonicalTakeReadiness(fresh,shot.id,freshShot.canonicalRenderId).ready){
            if(!this.status.completedShotIds.includes(shot.id))this.status.completedShotIds.push(shot.id);
            this.setStatus({phase:'planning',message:`${shot.title} approved. Advancing to the next shot.`});
            this.advanceAgain=true;continue;
          }
          const human=fresh.humanTasks.filter(task=>task.status==='open'&&task.shotId===shot.id);
          if(human.length){this.setStatus({phase:'waiting-human',message:`QC for ${shot.title} needs human review.`,blockedHumanTaskIds:human.map(task=>task.id)});break;}
          const failed=latestCurrentFailure(fresh,shot.id,currentOutput.id);
          if(failed){
            if(await this.retryShot(freshShot??shot,failed)){break;}
            await this.ensureHumanTask(freshShot??shot,'manual-qc','Automatic retries exhausted',`Shot “${shot.title}” still fails ${failed.layer} QC after ${this.status.retryCounts[shot.id]??0} automatic retries.`, 'Review the failed take, adjust references/prompt/previz if needed, then render again.');
            const after=this.projects.getCurrent();this.setStatus({phase:'waiting-human',message:`Automatic retries exhausted for ${shot.title}.`,blockedHumanTaskIds:after?.humanTasks.filter(task=>task.status==='open'&&task.shotId===shot.id).map(task=>task.id)??[]});break;
          }
          this.setStatus({phase:'waiting-human',message:`${shot.title} is not canonical-ready and needs review.`});break;
        }

        const failedJob=[...project.renderJobs].filter(job=>job.shotId===shot.id&&['failed','orphaned'].includes(job.status)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
        if(failedJob){
          const count=this.status.retryCounts[shot.id]??0;
          if(count<this.maxAutoRetries){
            this.status.retryCounts[shot.id]=count+1;this.setStatus({phase:'retrying',message:`Retrying failed render for ${shot.title} (${count+1}/${this.maxAutoRetries}).`});
            await this.queue.retry(failedJob.id);break;
          }
        }

        this.setStatus({phase:'waiting-render',message:`Queueing ${shot.title}.`});
        await this.queue.enqueue({projectRoot:project.rootPath,shotId:shot.id});
        break;
      }while(this.advanceAgain);
    }catch(error){this.fail(error instanceof Error?error.message:String(error));}
    finally{this.advancing=false;if(this.advanceAgain&&this.status.running&&!this.status.paused)this.wake();}
  }

  private nextIncompleteShot(project:FilmProject):Shot|undefined{
    for(const id of this.targetShotIds){
      const shot=project.shots.find(item=>item.id===id);if(!shot)continue;
      if(shot.canonicalRenderId&&canonicalTakeReadiness(project,shot.id,shot.canonicalRenderId).ready){
        if(!this.status.completedShotIds.includes(shot.id))this.status.completedShotIds.push(shot.id);
        continue;
      }
      return shot;
    }
    return undefined;
  }

  private async processTake(shotId:string,outputId:string):Promise<void>{
    let project=this.projects.getCurrent();if(!project)throw new Error('Project closed during QC.');
    let shot=project.shots.find(item=>item.id===shotId),output=project.renderOutputs.find(item=>item.id===outputId);
    if(!shot||!output)throw new Error('Shot/output disappeared during QC.');
    const outputPath=await assertExistingPathInside(join(project.rootPath,'renders'),output.path,`render output ${output.filename}`);
    const frameDir=join(project.rootPath,'cache','qc',output.id);
    const frames=await sampleVideoFrames(this.settings.get(),outputPath,frameDir);

    const observed=shot.observedFinalStateId?project.shotStates.find(state=>state.id===shot!.observedFinalStateId&&state.status==='current'&&state.sourceRenderOutputId===outputId):undefined;
    if(!observed){
      const frameAssetId=await this.ensureObservedFrameAsset(output,frames.finalFrame);
      project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;
      const draft=await extractObservedStateDraft(this.settings.get(),project,shot,frames.finalFrame);
      await recordObservedFinalState(this.projects,{projectRoot:project.rootPath,shotId,renderOutputId:outputId,frameAssetId,...draft});
    }

    await this.ensureQcLayer(shotId,outputId,'visual',frames);
    await this.ensureQcLayer(shotId,outputId,'semantic',frames);
    project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;
    if(project.shotDependencies.some(edge=>edge.toShotId===shotId&&edge.relation!=='parallel'&&edge.propagate.length>0))await this.ensureQcLayer(shotId,outputId,'continuity',frames);
  }

  private async ensureQcLayer(shotId:string,outputId:string,layer:Exclude<QcLayer,'technical'>,frames:SampledVideoFrames):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;
    const key=shotQcInputKey(project,shotId,outputId,layer);
    const existing=project.qcResults.filter(result=>result.shotId===shotId&&result.renderOutputId===outputId&&result.layer===layer&&result.inputKey===key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
    if(existing&&['pass','fail','human-verify'].includes(existing.status))return;
    let evaluation;
    if(layer==='visual')evaluation=await evaluateVisualQc(this.settings.get(),shot,frames.contactFrames);
    else if(layer==='semantic')evaluation=await evaluateSemanticQc(this.settings.get(),shot,frames.contactFrames);
    else{
      const incoming=project.shotDependencies.filter(edge=>edge.toShotId===shotId&&edge.relation!=='parallel'&&edge.propagate.length>0);
      let previousPath:string|undefined;
      if(incoming.length===1){
        const prior=project.shots.find(item=>item.id===incoming[0].fromShotId);
        const state=prior?.observedFinalStateId?project.shotStates.find(item=>item.id===prior.observedFinalStateId&&item.status==='current'):undefined;
        const asset=state?.frameAssetId?project.assets.find(item=>item.id===state.frameAssetId):undefined;
        if(asset)previousPath=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`observed final frame for ${prior?.title||'previous shot'}`).catch(()=>undefined);
      }
      evaluation=await evaluateContinuityQc(this.settings.get(),project,shot,previousPath,frames.firstFrame);
    }
    const fresh=this.projects.getCurrent();if(!fresh)return;
    const freshKey=shotQcInputKey(fresh,shotId,outputId,layer);
    await recordShotQc(this.projects,{projectRoot:fresh.rootPath,shotId,renderOutputId:outputId,layer,status:evaluation.status,issues:evaluation.issues,inputKey:freshKey});
  }

  private async ensureObservedFrameAsset(output:RenderOutput,framePath:string):Promise<string>{
    const project=this.projects.getCurrent();if(!project)throw new Error('Project closed during observed-frame registration.');
    const tag=`observed-output:${output.id}`;
    const existing=project.assets.find(asset=>asset.kind==='keyframe'&&asset.tags.includes(tag));
    if(existing)return existing.id;
    const id=randomUUID(),relative=join('assets','keyframe',`${id}-observed-final.jpg`);
    const target=await assertSafeWritePath(join(project.rootPath,'assets'),join(project.rootPath,relative),'observed final frame asset');
    await mkdir(join(project.rootPath,'assets','keyframe'),{recursive:true});await copyFile(framePath,target);
    await this.projects.mutate(next=>{if(!next.assets.some(asset=>asset.id===id))next.assets.push({id,kind:'keyframe',name:`Observed final · ${basename(output.filename)}`,sourcePath:basename(framePath),projectPath:relative,mimeType:'image/jpeg',tags:['system:observed-final',tag],notes:'Automatically extracted stable final frame from the rendered take.',createdAt:new Date().toISOString()});});
    return id;
  }

  private async retryShot(shot:Shot,failure:{layer:string}):Promise<boolean>{
    const count=this.status.retryCounts[shot.id]??0;
    if(count>=this.maxAutoRetries)return false;
    this.status.retryCounts[shot.id]=count+1;
    await this.projects.mutate(project=>{
      const current=project.shots.find(item=>item.id===shot.id);if(!current)return;
      current.generation.seed=Math.abs((current.generation.seed+104729+(count+1)*8191)%2147483647);
      current.latestRenderId=undefined;current.canonicalRenderId=undefined;current.status='ready';
      invalidateObservedFinalState(project,current.id,`Automatic retry after ${failure.layer} QC failure.`);
    });
    const project=this.projects.getCurrent()!;
    this.setStatus({phase:'retrying',message:`Retrying ${shot.title} after ${failure.layer} QC failure (${count+1}/${this.maxAutoRetries}).`});
    await this.queue.enqueue({projectRoot:project.rootPath,shotId:shot.id});
    return true;
  }

  private async ensureShotPreviz(shotId:string):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;
    const current=shot.previz;
    if(current?.reason?.startsWith('Human override:')&&current.requirement==='none')return;
    const plan=await ensurePrevizPlan(project,shot);
    const requirement=plan.advice.requirement;
    const reason=current?.reason?.startsWith('Human override:')?current.reason:`Auto previz advisor · score ${plan.advice.score}: ${plan.advice.reasons.join('; ')||'no complex spatial trigger'}`;
    const nextStatus=requirement==='none'?'not-needed':current?.status==='ready'?'ready':current?.status==='human-verify'?'human-verify':'pending';
    if(current?.requirement===requirement&&current.status===nextStatus&&current.reason===reason&&current.manifestPath===plan.manifestPath)return;
    await this.projects.mutate(next=>{
      const target=next.shots.find(item=>item.id===shotId);if(!target)return;
      target.previz={requirement,status:nextStatus,reason,manifestPath:plan.manifestPath,previewAssetId:target.previz?.previewAssetId,createdAt:target.previz?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()};
    });
  }

  private async ensureHumanTask(shot:Shot,type:'verify-previz'|'manual-qc',title:string,reason:string,recommendedAction:string):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    if(project.humanTasks.some(task=>task.status==='open'&&task.shotId===shot.id&&task.type===type&&task.title===title))return;
    await createHumanTask(this.projects,{projectRoot:project.rootPath,type,shotId:shot.id,title,reason,recommendedAction});
  }

  private async finish():Promise<void>{
    if(this.buildTimeline){
      this.setStatus({phase:'building-timeline',currentShotId:undefined,message:'Building canonical timeline.'});
      await this.projects.mutate(next=>{
        const ordered=orderedShots(next).filter(shot=>this.targetShotIds.includes(shot.id));
        const selected=ordered.flatMap(shot=>{
          if(!shot.canonicalRenderId||!canonicalTakeReadiness(next,shot.id,shot.canonicalRenderId).ready)return[];
          return[{id:randomUUID(),shotId:shot.id,renderOutputId:shot.canonicalRenderId,track:0,order:0,trimInSec:0,volume:1,approval:'canonical' as const}];
        });
        selected.forEach((clip,index)=>clip.order=index);
        next.timeline=selected;
      });
    }
    this.status.running=false;this.status.paused=false;
    this.setStatus({phase:'complete',currentShotId:undefined,message:`Autonomous production complete: ${this.status.completedShotIds.length}/${this.targetShotIds.length} shots canonical.`,blockedHumanTaskIds:[]});
  }

  private fail(message:string):void{this.status.running=false;this.status.paused=false;this.setStatus({phase:'error',message,lastError:message});}
  private setStatus(patch:Partial<AutomationStatus>):void{this.status={...this.status,...patch,updatedAt:new Date().toISOString()};this.emitStatus();}
  private emitStatus():void{this.emit('status',this.snapshot());}
}

function orderedShots(project:FilmProject):Shot[]{
  return[...project.shots].sort((a,b)=>{const sceneA=project.scenes.find(scene=>scene.id===a.sceneId)?.index??0,sceneB=project.scenes.find(scene=>scene.id===b.sceneId)?.index??0;return sceneA-sceneB||a.index-b.index||a.id.localeCompare(b.id);});
}

function findCurrentPassingTake(project:FilmProject,shot:Shot):RenderOutput|undefined{
  return[...project.renderOutputs].filter(output=>output.shotId===shot.id&&output.mediaType==='video'&&output.technicalQc?.passed).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).find(output=>{const current=currentProductionInputKeyForOutput(project,shot,output),recorded=renderOutputProductionInputKey(project,output);return Boolean(current&&recorded===current);});
}

function latestCurrentFailure(project:FilmProject,shotId:string,outputId:string):{layer:string}|undefined{
  for(const layer of ['visual','semantic','continuity'] as const){
    const key=shotQcInputKey(project,shotId,outputId,layer);
    const result=project.qcResults.filter(item=>item.shotId===shotId&&item.renderOutputId===outputId&&item.layer===layer&&item.inputKey===key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
    if(result?.status==='fail')return{layer};
  }
  return undefined;
}
