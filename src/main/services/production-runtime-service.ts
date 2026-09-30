import { EventEmitter } from 'node:events';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AutomationRunRequest, AutomationStatus, FilmProject, HumanTaskType, QcLayer, RenderOutput, Shot } from '../../shared/types';
import { OBSERVED_STATE_CONFIDENCE_TASK_PREFIX, canonicalTakeReadiness, currentActualStartFrameAssetId, currentProductionInputKeyForOutput, invalidateObservedFinalState, isApprovedObservedStateReview, productionShotOrder, renderOutputProductionInputKey, shotQcInputKey } from '../../shared/production-state';
import { ProjectService } from './project-service';
import { AppSettingsService } from './app-settings-service';
import { RenderQueueService } from './render-queue';
import { preflightProject } from './preflight-service';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertSafeWritePath } from './path-safety';
import { sampleVideoFrames, type SampledVideoFrames } from './media-analysis';
import { evaluateContinuityQc, evaluateSemanticQc, evaluateVisualQc, extractObservedStateDraft, selectStableFinalFrame } from './automatic-qc-service';
import { createHumanTask, recordObservedFinalState, recordShotQc } from './production-state-service';
import { ensurePrevizPlan } from './previz-service';
import { releaseLocalVisionModel } from './local-vision-service';
import { AutomationJournal } from './automation-journal';
import { KeyframeLeaseStore } from './keyframe-lease';
import { generateKeyframe } from './keyframe-service';
import { provisionRecommendedWanGpProfiles } from './wangp-catalog-service';

const ACTIVE_RENDER=new Set(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);

export class ProductionRuntimeService extends EventEmitter{
  private status:AutomationStatus={running:false,paused:false,phase:'idle',message:'Automation is idle.',updatedAt:new Date().toISOString(),completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]};
  private targetShotIds:string[]=[];
  private maxAutoRetries=2;
  private buildTimeline=true;
  private advancing=false;
  private advanceAgain=false;
  private journal=new AutomationJournal();
  private journalTail:Promise<void>=Promise.resolve();

  constructor(private projects:ProjectService,private queue:RenderQueueService,private settings:AppSettingsService,private keyframeLeases:KeyframeLeaseStore){
    super();
    this.queue.on('snapshot',()=>this.wake());
  }

  snapshot():AutomationStatus{return structuredClone(this.status);}
  async flush():Promise<void>{await this.journalTail;}

  async reconcileAfterProjectOpen():Promise<AutomationStatus>{
    const project=this.projects.getCurrent();
    if(!project){
      this.targetShotIds=[];
      this.status={running:false,paused:false,phase:'idle',message:'Automation is idle.',updatedAt:new Date().toISOString(),completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]};
      this.emitStatus();return this.snapshot();
    }
    const saved=await this.journal.read(project);
    if(!saved){
      this.targetShotIds=[];
      this.status={running:false,paused:false,phase:'idle',projectRoot:project.rootPath,message:'Automation is idle.',updatedAt:new Date().toISOString(),completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]};
      this.emitStatus();return this.snapshot();
    }
    this.targetShotIds=saved.targetShotIds;
    this.maxAutoRetries=saved.maxAutoRetries;
    this.buildTimeline=saved.buildTimeline;
    this.status={...saved.status,projectRoot:project.rootPath,updatedAt:new Date().toISOString()};
    if(this.status.running){
      this.status.phase=this.status.paused?'paused':'planning';
      this.status.message=this.status.paused?'Recovered paused autonomous production run.':'Recovered autonomous production run; re-evaluating current project state.';
    }
    this.emitStatus();this.persistLater();
    if(this.status.running&&!this.status.paused)this.wake();
    return this.snapshot();
  }

  async start(request:AutomationRunRequest):Promise<AutomationStatus>{
    if(this.status.running)throw new Error('Autonomous production is already running.');
    const project=this.projects.getCurrent();if(!project)throw new Error('Open a project first.');
    if(project.rootPath!==request.projectRoot)throw new Error('Automation request does not match the open project.');
    const ordered=productionShotOrder(project);
    const requested=request.shotIds?.length?new Set(request.shotIds):undefined;
    this.targetShotIds=ordered.filter(shot=>!requested||requested.has(shot.id)).map(shot=>shot.id);
    if(requested&&this.targetShotIds.length!==requested.size)throw new Error('Automation request contains an unknown shot id.');
    if(!this.targetShotIds.length)throw new Error('There are no shots to automate.');
    assertExternalDependenciesReady(project,new Set(this.targetShotIds));
    this.maxAutoRetries=Math.max(0,Math.min(5,Math.trunc(request.maxAutoRetries??2)));
    this.buildTimeline=request.buildTimeline!==false;
    this.status={running:true,paused:false,phase:'preflight',projectRoot:project.rootPath,message:'Preparing local production routes…',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]};
    this.emitStatus();
    await this.ensureAutomationProfiles();
    const current=this.projects.getCurrent();if(!current){this.fail('Project closed while preparing local production routes.');return this.snapshot();}
    const report=await preflightProject(current,this.settings.get());
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
        const currentShotId=shot.id;
        this.setStatus({currentShotId,blockedHumanTaskIds:[]});
        await this.ensureShotPreviz(currentShotId);
        project=this.projects.getCurrent();
        if(!project){this.fail('Project closed while preparing previz.');break;}
        shot=project.shots.find(item=>item.id===currentShotId);
        if(!shot){this.fail('Current shot disappeared while preparing previz.');break;}

        const blockers=project.humanTasks.filter(task=>task.status==='open'&&task.shotId===currentShotId);
        if(blockers.length){
          this.setStatus({phase:'waiting-human',message:`Human review required for ${shot.title}.`,blockedHumanTaskIds:blockers.map(task=>task.id)});
          break;
        }
        if(shot.previz?.requirement==='required'&&shot.previz.status!=='ready'){
          await this.ensureHumanTask(shot,'verify-previz','3D previz required',`Shot “${shot.title}” is marked as requiring previz before generation.`,'Create or approve the Blender previz, attach its reference/preview, then mark previz ready.');
          const fresh=this.projects.getCurrent();
          const ids=fresh?.humanTasks.filter(task=>task.status==='open'&&task.shotId===currentShotId).map(task=>task.id)??[];
          this.setStatus({phase:'waiting-human',message:`Previz is required for ${shot.title}.`,blockedHumanTaskIds:ids});break;
        }

        const queueSnapshot=this.queue.snapshot();
        if(queueSnapshot.jobs.some(job=>job.shotId===currentShotId&&ACTIVE_RENDER.has(job.status))){
          this.setStatus({phase:'waiting-render',message:`Waiting for ${shot.title} render to finish.`});break;
        }

        const currentOutput=findCurrentPassingTake(project,shot);
        if(currentOutput){
          this.setStatus({phase:'qc',message:`Extracting actual state and QC for ${shot.title}.`});
          await this.processTake(currentShotId,currentOutput.id);
          const fresh=this.projects.getCurrent();if(!fresh)break;
          const freshShot=fresh.shots.find(item=>item.id===currentShotId);
          if(freshShot?.canonicalRenderId&&canonicalTakeReadiness(fresh,currentShotId,freshShot.canonicalRenderId).ready){
            if(!this.status.completedShotIds.includes(currentShotId))this.status.completedShotIds.push(currentShotId);
            this.setStatus({phase:'planning',message:`${shot.title} approved. Advancing to the next shot.`});
            this.advanceAgain=true;continue;
          }
          const human=fresh.humanTasks.filter(task=>task.status==='open'&&task.shotId===currentShotId);
          if(human.length){this.setStatus({phase:'waiting-human',message:`QC for ${shot.title} needs human review.`,blockedHumanTaskIds:human.map(task=>task.id)});break;}
          const failed=latestCurrentFailure(fresh,currentShotId,currentOutput.id);
          if(failed){
            if(await this.retryShot(freshShot??shot,failed)){break;}
            await this.ensureHumanTask(freshShot??shot,'manual-qc','Automatic retries exhausted',`Shot “${shot.title}” still fails ${failed.layer} QC after ${this.status.retryCounts[currentShotId]??0} automatic retries.`, 'Review the failed take, adjust references/prompt/previz if needed, then render again.');
            const after=this.projects.getCurrent();this.setStatus({phase:'waiting-human',message:`Automatic retries exhausted for ${shot.title}.`,blockedHumanTaskIds:after?.humanTasks.filter(task=>task.status==='open'&&task.shotId===currentShotId).map(task=>task.id)??[]});break;
          }
          this.setStatus({phase:'waiting-human',message:`${shot.title} is not canonical-ready and needs review.`});break;
        }

        await this.ensureShotGenerationInputs(currentShotId);
        project=this.projects.getCurrent();
        if(!project){this.fail('Project closed while preparing shot generation inputs.');break;}
        shot=project.shots.find(item=>item.id===currentShotId);
        if(!shot){this.fail('Current shot disappeared while preparing shot generation inputs.');break;}
        const preparationBlockers=project.humanTasks.filter(task=>task.status==='open'&&task.shotId===currentShotId);
        if(preparationBlockers.length){
          this.setStatus({phase:'waiting-human',message:`Generation inputs for ${shot.title} need human action.`,blockedHumanTaskIds:preparationBlockers.map(task=>task.id)});break;
        }
        const preparedReport=await preflightProject(project,this.settings.get());
        const preparedErrors=preparedReport.issues.filter(issue=>issue.level==='error'&&issue.shotId===currentShotId);
        if(preparedErrors.length){
          await this.ensureHumanTask(shot,'route-unsupported','Workflow input mismatch',preparedErrors.map(issue=>`${issue.code}: ${issue.message}`).join(' | '),'Open Settings / Shot Workshop, fix or re-route the video workflow bindings for the prepared start/end/reference inputs, then resume AUTO RUN.');
          const fresh=this.projects.getCurrent();
          this.setStatus({phase:'waiting-human',message:`Prepared inputs for ${shot.title} do not match its video workflow.`,blockedHumanTaskIds:fresh?.humanTasks.filter(task=>task.status==='open'&&task.shotId===currentShotId).map(task=>task.id)??[]});break;
        }

        const failedJob=[...project.renderJobs].filter(job=>job.shotId===currentShotId&&['failed','orphaned'].includes(job.status)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
        if(failedJob){
          const count=this.status.retryCounts[currentShotId]??0;
          if(count<this.maxAutoRetries){
            this.status.retryCounts[currentShotId]=count+1;this.setStatus({phase:'retrying',message:`Retrying failed render for ${shot.title} (${count+1}/${this.maxAutoRetries}).`});
            await this.queue.retry(failedJob.id);break;
          }
        }

        this.setStatus({phase:'waiting-render',message:`Queueing ${shot.title}.`});
        await this.queue.enqueue({projectRoot:project.rootPath,shotId:currentShotId});
        break;
      }while(this.advanceAgain);
    }catch(error){this.fail(error instanceof Error?error.message:String(error));}
    finally{this.advancing=false;if(this.advanceAgain&&this.status.running&&!this.status.paused)this.wake();}
  }

  private nextIncompleteShot(project:FilmProject):Shot|undefined{
    const targets=new Set(this.targetShotIds);
    assertExternalDependenciesReady(project,targets);
    for(const shot of productionShotOrder(project)){
      if(!targets.has(shot.id))continue;
      if(shot.canonicalRenderId&&canonicalTakeReadiness(project,shot.id,shot.canonicalRenderId).ready){
        if(!this.status.completedShotIds.includes(shot.id))this.status.completedShotIds.push(shot.id);
        continue;
      }
      return shot;
    }
    return undefined;
  }

  private async processTake(shotId:string,outputId:string):Promise<void>{
    try{
    let project=this.projects.getCurrent();if(!project)throw new Error('Project closed during QC.');
    let shot=project.shots.find(item=>item.id===shotId),output=project.renderOutputs.find(item=>item.id===outputId);
    if(!shot||!output)throw new Error('Shot/output disappeared during QC.');
    const outputPath=await assertExistingPathInside(join(project.rootPath,'renders'),output.path,`render output ${output.filename}`);
    const frameDir=join(project.rootPath,'cache','qc',output.id);
    const frames=await sampleVideoFrames(this.settings.get(),outputPath,frameDir);
    const stableFinalFrame=await selectStableFinalFrame(this.settings.get(),frames.finalCandidates);

    await this.ensureQcLayer(shotId,outputId,'visual',frames);
    await this.ensureQcLayer(shotId,outputId,'semantic',frames);
    project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;
    if(!hasCurrentQcPass(project,shotId,outputId,'visual')||!hasCurrentQcPass(project,shotId,outputId,'semantic'))return;

    const needsContinuity=project.shotDependencies.some(edge=>edge.toShotId===shotId&&edge.relation!=='parallel'&&edge.propagate.length>0);
    if(needsContinuity){
      await this.ensureQcLayer(shotId,outputId,'continuity',frames);
      project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;
      if(!hasCurrentQcPass(project,shotId,outputId,'continuity'))return;
    }

    const observed=shot.observedFinalStateId?project.shotStates.find(state=>state.id===shot!.observedFinalStateId&&state.status==='current'&&state.sourceRenderOutputId===outputId):undefined;
    if(!observed){
      const frameAssetId=await this.ensureObservedFrameAsset(output,stableFinalFrame);
      project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;
      const draft=await extractObservedStateDraft(this.settings.get(),project,shot,stableFinalFrame);
      const confidenceReviewTitle=`${OBSERVED_STATE_CONFIDENCE_TASK_PREFIX}${shot.title}`;
      const confidenceApproved=project.humanTasks.some(task=>isApprovedObservedStateReview(task,shotId,confidenceReviewTitle,outputId));
      if(draft.confidence<0.6&&!confidenceApproved){
        await this.ensureHumanTask(
          shot,'manual-qc',confidenceReviewTitle,
          `Automatic final-state extraction confidence is ${Math.round(draft.confidence*100)}%, below the 60% auto-propagation threshold.`,
          'Inspect the extracted final frame and rendered take. Use the explicit Approve observed state action only if the extracted facts are visibly correct; otherwise dismiss the task and adjust/re-render the shot.',
          [outputId]
        );
        return;
      }
      await recordObservedFinalState(this.projects,{projectRoot:project.rootPath,shotId,renderOutputId:outputId,frameAssetId,...draft});
    }
    }finally{await releaseLocalVisionModel(this.settings.get());}
  }

  private async ensureQcLayer(shotId:string,outputId:string,layer:Exclude<QcLayer,'technical'>,frames:SampledVideoFrames):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    const shot=project.shots.find(item=>item.id===shotId);if(!shot)return;
    const key=shotQcInputKey(project,shotId,outputId,layer);
    const existing=project.qcResults.filter(result=>result.shotId===shotId&&result.renderOutputId===outputId&&result.layer===layer&&result.inputKey===key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
    if(existing&&['pass','fail','human-verify'].includes(existing.status))return;
    let evaluation;
    if(layer==='visual')evaluation=await evaluateVisualQc(this.settings.get(),shot,frames.contactFrames);
    else if(layer==='semantic')evaluation=await evaluateSemanticQc(this.settings.get(),project,shot,frames.contactFrames);
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

  private async ensureAutomationProfiles():Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    const usable=(purpose:'video'|'image')=>project.settings.workflowProfiles.some(profile=>profile.enabled&&(profile.purpose??'video')===purpose&&Boolean(profile.workflowPath)&&profile.validation?.structuralStatus==='valid'&&Boolean(profile.validation.sourceSha256)&&Boolean(profile.validation.runtimeFingerprint));
    const targetShots=project.shots.filter(shot=>this.targetShotIds.includes(shot.id));
    const needsImage=targetShots.some(shot=>(shot.generation.mode==='i2v'&&!shot.startFrameAssetId)||(shot.generation.mode==='flf2v'&&(!shot.startFrameAssetId||!shot.endFrameAssetId)));
    if(usable('video')&&(!needsImage||usable('image')))return;
    const machine=this.settings.get();
    if(machine.wangp.executionMode!=='native'||!machine.wangp.rootPath.trim()){
      if(!usable('video'))throw new Error('No validated local video workflow is available. Configure WanGP native mode or validate a video workflow in Settings.');
      return;
    }
    this.setStatus({phase:'preflight',message:'Auto-provisioning recommended WanGP video/image profiles for this project…'});
    try{await provisionRecommendedWanGpProfiles(this.projects,this.settings);}
    catch(error){
      const current=this.projects.getCurrent();
      const videoReady=current?.settings.workflowProfiles.some(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.validation?.structuralStatus==='valid');
      if(!videoReady)throw error;
      console.warn('Automatic keyframe-profile provisioning was unavailable; AUTO RUN can fall back to Human Tasks for missing keyframes.',error);
    }
  }

  private async ensureShotGenerationInputs(shotId:string):Promise<void>{
    let project=this.projects.getCurrent();if(!project)return;
    let shot=project.shots.find(item=>item.id===shotId);if(!shot)return;
    await this.reconcilePreparationTasks(shot);
    project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;

    if(shot.generation.mode==='v2v'){
      if(!shot.referenceVideoAssetId)await this.ensureHumanTask(shot,'route-unsupported','Reference video required',`Shot “${shot.title}” uses V2V but has no reference video.`,'Attach a reference video in Shot Workshop, then resume AUTO RUN.');
      return;
    }
    const needsStart=shot.generation.mode==='i2v'||shot.generation.mode==='flf2v';
    const needsEnd=shot.generation.mode==='flf2v';

    if(needsStart&&!shot.startFrameAssetId){
      const propagatedFrameAssetId=currentActualStartFrameAssetId(project,shot);
      if(propagatedFrameAssetId){
        await this.projects.mutate(next=>{const target=next.shots.find(item=>item.id===shotId);if(target&&!target.startFrameAssetId){target.startFrameAssetId=propagatedFrameAssetId;target.latestRenderId=undefined;target.canonicalRenderId=undefined;invalidateObservedFinalState(next,target.id,'Approved/current propagated start frame became the generation start reference.');}});
      }else{
        const profile=selectImageProfile(project);
        if(profile){
          this.setStatus({phase:'keyframes',message:`Generating start keyframe for ${shot.title}.`});
          try{await generateKeyframe(this.projects,this.settings.get(),{projectRoot:project.rootPath,shotId,role:'start',workflowProfileId:profile.id},this.keyframeLeases);}
          catch(error){await this.ensureHumanTask(shot,'verify-keyframe','Automatic start keyframe failed',`Automatic start-keyframe generation failed: ${error instanceof Error?error.message:String(error)}`,'Inspect the image workflow/model, then generate or import a start keyframe in Shot Workshop and resume AUTO RUN.');return;}
        }else await this.ensureHumanTask(shot,'verify-keyframe','Start keyframe required',`Shot “${shot.title}” uses ${shot.generation.mode} and has no start frame or validated local image workflow.`,'Use Shot Workshop to generate/import and attach a start keyframe, then resume AUTO RUN.');
      }
    }

    project=this.projects.getCurrent()!;shot=project.shots.find(item=>item.id===shotId)!;
    if(needsEnd&&!shot.endFrameAssetId){
      const profile=selectImageProfile(project);
      if(profile){
        this.setStatus({phase:'keyframes',message:`Generating target end keyframe for ${shot.title}.`});
        try{await generateKeyframe(this.projects,this.settings.get(),{projectRoot:project.rootPath,shotId,role:'end',workflowProfileId:profile.id},this.keyframeLeases);}
        catch(error){await this.ensureHumanTask(shot,'verify-keyframe','Automatic end keyframe failed',`Automatic end-keyframe generation failed: ${error instanceof Error?error.message:String(error)}`,'Inspect the image workflow/model, then generate or import a target end keyframe in Shot Workshop and resume AUTO RUN.');return;}
      }else await this.ensureHumanTask(shot,'verify-keyframe','End keyframe required',`Shot “${shot.title}” uses FLF2V and has no end keyframe or validated local image workflow.`,'Use Shot Workshop to generate/import and attach a target end keyframe, then resume AUTO RUN.');
    }
    await this.reconcilePreparationTasks(this.projects.getCurrent()!.shots.find(item=>item.id===shotId)!);
  }

  private async reconcilePreparationTasks(shot:Shot):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    const now=new Date().toISOString();
    const satisfied=(taskTitle:string)=>{
      if(taskTitle==='Start keyframe required'||taskTitle==='Automatic start keyframe failed')return Boolean(shot.startFrameAssetId);
      if(taskTitle==='End keyframe required'||taskTitle==='Automatic end keyframe failed')return Boolean(shot.endFrameAssetId);
      if(taskTitle==='Reference video required')return Boolean(shot.referenceVideoAssetId);
      return false;
    };
    const closable=project.humanTasks.filter(task=>task.status==='open'&&task.shotId===shot.id&&['verify-keyframe','route-unsupported'].includes(task.type)&&satisfied(task.title));
    if(!closable.length)return;
    await this.projects.mutate(next=>{for(const task of next.humanTasks){if(!closable.some(item=>item.id===task.id))continue;task.status='resolved';task.resolvedAt=now;task.resolution='Automatically resolved because the required generation input is now attached.';}});
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

  private async ensureHumanTask(shot:Shot,type:HumanTaskType,title:string,reason:string,recommendedAction:string,relatedRenderOutputIds:string[]=[]):Promise<void>{
    const project=this.projects.getCurrent();if(!project)return;
    if(project.humanTasks.some(task=>task.status==='open'&&task.shotId===shot.id&&task.type===type&&task.title===title&&relatedRenderOutputIds.every(id=>task.relatedRenderOutputIds.includes(id))))return;
    await createHumanTask(this.projects,{projectRoot:project.rootPath,type,shotId:shot.id,title,reason,recommendedAction,relatedRenderOutputIds});
  }

  private async finish():Promise<void>{
    if(this.buildTimeline){
      this.setStatus({phase:'building-timeline',currentShotId:undefined,message:'Building canonical timeline without replacing human edits.'});
      await this.projects.mutate(next=>{buildAutomationTimelineIfEmpty(next);});
    }
    this.status.running=false;this.status.paused=false;
    this.setStatus({phase:'complete',currentShotId:undefined,message:`Autonomous production complete: ${this.status.completedShotIds.length}/${this.targetShotIds.length} shots canonical.`,blockedHumanTaskIds:[]});
  }

  private fail(message:string):void{this.status.running=false;this.status.paused=false;this.setStatus({phase:'error',message,lastError:message});}
  private setStatus(patch:Partial<AutomationStatus>):void{this.status={...this.status,...patch,updatedAt:new Date().toISOString()};this.emitStatus();this.persistLater();}
  private emitStatus():void{this.emit('status',this.snapshot());}
  private persistLater():void{
    const project=this.projects.getCurrent();
    if(!project||this.status.projectRoot!==project.rootPath)return;
    const snapshot=this.snapshot(),targetShotIds=[...this.targetShotIds],maxAutoRetries=this.maxAutoRetries,buildTimeline=this.buildTimeline;
    this.journalTail=this.journalTail.then(()=>this.journal.write(project,{schemaVersion:1,projectId:project.id,projectRoot:project.rootPath,targetShotIds,maxAutoRetries,buildTimeline,status:snapshot})).catch(error=>{console.warn('Could not persist autonomous production journal:',error);});
  }
}

export function assertExternalDependenciesReady(project:FilmProject,targetShotIds:ReadonlySet<string>):void{
  const blockers:string[]=[];
  for(const edge of project.shotDependencies){
    if(edge.relation==='parallel'||!targetShotIds.has(edge.toShotId)||targetShotIds.has(edge.fromShotId))continue;
    const upstream=project.shots.find(shot=>shot.id===edge.fromShotId);
    const ready=Boolean(upstream?.canonicalRenderId&&canonicalTakeReadiness(project,upstream.id,upstream.canonicalRenderId).ready);
    if(!ready)blockers.push(`${edge.fromShotId} → ${edge.toShotId}`);
  }
  if(blockers.length)throw new Error(`Requested AUTO RUN subset has unresolved upstream dependencies outside the selection: ${blockers.slice(0,16).join(', ')}. Render/canonicalize the upstream shots or include them in the run.`);
}

export function buildAutomationTimelineIfEmpty(project:FilmProject):boolean{
  if(project.timeline.length)return false;
  const selected=editorialOrderedShots(project).flatMap(shot=>{
    if(!shot.canonicalRenderId||!canonicalTakeReadiness(project,shot.id,shot.canonicalRenderId).ready)return[];
    return[{id:randomUUID(),shotId:shot.id,renderOutputId:shot.canonicalRenderId,track:0,order:0,trimInSec:0,volume:1,approval:'canonical' as const}];
  });
  selected.forEach((clip,index)=>clip.order=index);
  project.timeline=selected;
  return true;
}

function selectImageProfile(project:FilmProject){
  return[...project.settings.workflowProfiles]
    .filter(profile=>profile.enabled&&(profile.purpose??'video')==='image'&&Boolean(profile.workflowPath)&&profile.validation?.structuralStatus==='valid'&&Boolean(profile.validation.sourceSha256)&&Boolean(profile.validation.runtimeFingerprint))
    .sort((a,b)=>Number(Boolean(b.validation?.lastSuccessfulRenderAt))-Number(Boolean(a.validation?.lastSuccessfulRenderAt))||(b.validation?.lastSuccessfulRenderAt??'').localeCompare(a.validation?.lastSuccessfulRenderAt??'')||a.id.localeCompare(b.id))[0];
}

function editorialOrderedShots(project:FilmProject):Shot[]{
  return[...project.shots].sort((a,b)=>{const sceneA=project.scenes.find(scene=>scene.id===a.sceneId)?.index??0,sceneB=project.scenes.find(scene=>scene.id===b.sceneId)?.index??0;return sceneA-sceneB||a.index-b.index||a.id.localeCompare(b.id);});
}

function findCurrentPassingTake(project:FilmProject,shot:Shot):RenderOutput|undefined{
  return[...project.renderOutputs].filter(output=>output.shotId===shot.id&&output.mediaType==='video'&&output.technicalQc?.passed).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).find(output=>{const current=currentProductionInputKeyForOutput(project,shot,output),recorded=renderOutputProductionInputKey(project,output);return Boolean(current&&recorded===current);});
}

function hasCurrentQcPass(project:FilmProject,shotId:string,outputId:string,layer:'visual'|'semantic'|'continuity'):boolean{
  const key=shotQcInputKey(project,shotId,outputId,layer);
  const result=project.qcResults.filter(item=>item.shotId===shotId&&item.renderOutputId===outputId&&item.layer===layer&&item.inputKey===key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
  return result?.status==='pass';
}

function latestCurrentFailure(project:FilmProject,shotId:string,outputId:string):{layer:string}|undefined{
  for(const layer of ['visual','semantic','continuity'] as const){
    const key=shotQcInputKey(project,shotId,outputId,layer);
    const result=project.qcResults.filter(item=>item.shotId===shotId&&item.renderOutputId===outputId&&item.layer===layer&&item.inputKey===key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
    if(result?.status==='fail')return{layer};
  }
  return undefined;
}
