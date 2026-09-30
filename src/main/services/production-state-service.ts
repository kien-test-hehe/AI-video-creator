import { randomUUID } from 'node:crypto';
import type {
  CharacterContinuityState, CreateHumanTaskRequest, FilmProject, HumanTask, PropContinuityState,
  PromoteCanonicalTakeRequest, QcIssue, RecordObservedFinalStateRequest, RecordShotQcRequest,
  ResolveHumanTaskRequest, ShotQcResult, ShotState
} from '../../shared/types';
import {
  canonicalTakeReadiness, invalidateObservedFinalState, latestShotQcResult, propagateObservedFinalState,
  currentProductionInputKeyForOutput, refreshCanonicalRender, renderOutputProductionInputKey, shotQcInputKey, shotStateFingerprint
} from '../../shared/production-state';
import { ProjectService } from './project-service';

const HUMAN_TASK_LIMIT=100_000;
const QC_RESULT_LIMIT=300_000;
const SHOT_STATE_LIMIT=200_000;

export async function recordObservedFinalState(projects:ProjectService,request:RecordObservedFinalStateRequest):Promise<FilmProject>{
  requireString(request.projectRoot,4096,'project root');
  requireString(request.shotId,256,'shot id');
  requireString(request.renderOutputId,256,'render output id');
  return projects.mutate(project=>{
    assertProject(project,request.projectRoot);
    if(project.shotStates.length>=SHOT_STATE_LIMIT)throw new Error(`Shot-state history would exceed the ${SHOT_STATE_LIMIT}-item safety limit.`);
    const shot=project.shots.find(item=>item.id===request.shotId);if(!shot)throw new Error('Shot not found.');
    const output=project.renderOutputs.find(item=>item.id===request.renderOutputId&&item.shotId===shot.id&&item.mediaType==='video');
    if(!output)throw new Error('Observed final state must reference a video output from the same shot.');
    if(!output.technicalQc?.passed)throw new Error('Observed final state cannot become current until the source video passes technical QC.');
    const recordedInputKey=renderOutputProductionInputKey(project,output),currentInputKey=currentProductionInputKeyForOutput(project,shot,output);
    if(!recordedInputKey||recordedInputKey!==currentInputKey)throw new Error('Observed final state cannot be recorded from a stale or provenance-unknown render output.');
    const requiredLayers:Array<'visual'|'semantic'|'continuity'>=['visual','semantic'];
    if(project.shotDependencies.some(edge=>edge.toShotId===shot.id&&edge.relation!=='parallel'&&edge.propagate.length>0))requiredLayers.push('continuity');
    for(const layer of requiredLayers){
      const expected=shotQcInputKey(project,shot.id,output.id,layer);
      const result=latestShotQcResult(project,shot.id,output.id,layer,expected);
      if(!result||result.status!=='pass')throw new Error(`Observed final state requires current ${layer} QC PASS before it can propagate continuity.`);
    }

    const frameAssetId=request.frameAssetId?requireAsset(project,request.frameAssetId,new Set(['image','reference','keyframe']),'observed-final frame').id:undefined;
    const characters=normalizeCharacters(project,request.characters);
    const props=normalizeProps(project,request.props);
    const environment={
      locationAssetId:request.environment.locationAssetId?requireAsset(project,request.environment.locationAssetId,new Set(['location']),'observed environment location').id:undefined,
      timeOfDay:optionalText(request.environment.timeOfDay,1000,'environment time of day'),
      lighting:optionalText(request.environment.lighting,10_000,'environment lighting'),
      weather:optionalText(request.environment.weather,5000,'environment weather'),
      notes:optionalText(request.environment.notes,10_000,'environment notes')
    };
    const lens=request.camera.lensMm;
    if(lens!=null&&(!Number.isFinite(lens)||lens<1||lens>1000))throw new Error('Camera lensMm must be between 1 and 1000.');
    const camera={
      shotSize:optionalText(request.camera.shotSize,1000,'camera shot size'),
      angle:optionalText(request.camera.angle,2000,'camera angle'),
      screenDirection:optionalText(request.camera.screenDirection,2000,'camera screen direction'),
      movement:optionalText(request.camera.movement,5000,'camera movement'),
      lensMm:lens,
      notes:optionalText(request.camera.notes,10_000,'camera notes')
    };
    const confidence=request.confidence;
    if(confidence!=null&&(!Number.isFinite(confidence)||confidence<0||confidence>1))throw new Error('Observed-state confidence must be between 0 and 1.');

    invalidateObservedFinalState(project,shot.id,'Superseded by a newer observed final state.');
    const state:ShotState={
      id:randomUUID(),shotId:shot.id,role:'observed-final',source:'generated',status:'current',
      frameAssetId,sourceRenderOutputId:output.id,characters,props,environment,camera,
      actionPhase:requireString(request.actionPhase??'',20_000,'action phase'),
      dialogueState:requireString(request.dialogueState??'',20_000,'dialogue state'),
      confidence,createdAt:new Date().toISOString()
    };
    state.fingerprint=shotStateFingerprint(state);
    project.shotStates.push(state);
    shot.observedFinalStateId=state.id;
    propagateObservedFinalState(project,shot.id,state.createdAt);
    refreshCanonicalRender(project,shot.id);
  });
}

export async function recordShotQc(projects:ProjectService,request:RecordShotQcRequest):Promise<FilmProject>{
  return projects.mutate(project=>{
    assertProject(project,request.projectRoot);
    if(project.qcResults.length>=QC_RESULT_LIMIT)throw new Error(`QC history would exceed the ${QC_RESULT_LIMIT}-item safety limit.`);
    const shot=project.shots.find(item=>item.id===request.shotId);if(!shot)throw new Error('Shot not found.');
    const output=project.renderOutputs.find(item=>item.id===request.renderOutputId&&item.shotId===shot.id&&item.mediaType==='video');
    if(!output)throw new Error('QC must reference a video output from the same shot.');
    if(!['visual','semantic','continuity'].includes(request.layer))throw new Error('Only visual, semantic, or continuity QC can be recorded through the production-state API.');
    if(!['pass','fail','unknown','human-verify'].includes(request.status))throw new Error('Invalid QC status.');
    const recordedInputKey=renderOutputProductionInputKey(project,output),currentInputKey=currentProductionInputKeyForOutput(project,shot,output);
    if(!recordedInputKey||recordedInputKey!==currentInputKey)throw new Error('QC cannot be recorded against a stale or provenance-unknown render output. Queue a render for the current shot inputs first.');
    const issues=normalizeIssues(request.issues);
    if(request.status==='pass'&&issues.some(issue=>issue.severity==='major'||issue.severity==='blocker'))throw new Error('QC PASS cannot contain major or blocker issues. Use human-verify or fail.');
    const inputKey=shotQcInputKey(project,shot.id,output.id,request.layer);
    requireString(request.inputKey,512,'QC input key');
    if(request.inputKey!==inputKey)throw new Error('QC input key is stale or does not match the current shot/output/state graph.');
    const result:ShotQcResult={
      id:randomUUID(),shotId:shot.id,renderOutputId:output.id,layer:request.layer,status:request.status,
      issues,inputKey,createdAt:new Date().toISOString()
    };
    project.qcResults.push(result);
    if(request.status==='human-verify'){
      const existingReview=[...project.qcResults].reverse().find(item=>
        item.id!==result.id&&item.shotId===shot.id&&item.renderOutputId===output.id&&item.layer===request.layer&&item.inputKey===inputKey&&item.humanOverrideTaskId&&
        project.humanTasks.some(task=>task.id===item.humanOverrideTaskId&&task.status==='open')
      );
      const task=existingReview?.humanOverrideTaskId
        ? project.humanTasks.find(item=>item.id===existingReview.humanOverrideTaskId)!
        : createHumanTaskRecord(project,{
            projectRoot:project.rootPath,
            type:request.layer==='continuity'?'verify-continuity':'manual-qc',
            shotId:shot.id,
            title:`${request.layer[0].toUpperCase()+request.layer.slice(1)} QC needs review · ${shot.title}`,
            reason:issues.map(issue=>issue.message).filter(Boolean).join(' | ')||`${request.layer} QC returned an uncertain result.`,
            recommendedAction:'Inspect the rendered take against its shot contract and references, then record a PASS or FAIL verdict with a review note.',
            relatedRenderOutputIds:[output.id]
          });
      if(existingReview){
        task.title=`${request.layer[0].toUpperCase()+request.layer.slice(1)} QC needs review · ${shot.title}`;
        task.reason=issues.map(issue=>issue.message).filter(Boolean).join(' | ')||`${request.layer} QC returned an uncertain result.`;
        task.recommendedAction='Inspect the rendered take against its shot contract and references, then record a PASS or FAIL verdict with a review note.';
      }
      result.humanOverrideTaskId=task.id;
    }
    refreshCanonicalRender(project,shot.id);
  });
}

export async function createHumanTask(projects:ProjectService,request:CreateHumanTaskRequest):Promise<FilmProject>{
  return projects.mutate(project=>{assertProject(project,request.projectRoot);createHumanTaskRecord(project,request);});
}

export async function resolveHumanTask(projects:ProjectService,request:ResolveHumanTaskRequest):Promise<FilmProject>{
  return projects.mutate(project=>{
    assertProject(project,request.projectRoot);
    const task=project.humanTasks.find(item=>item.id===request.taskId);if(!task)throw new Error('Human task not found.');
    if(task.status!=='open')throw new Error(`Human task is already ${task.status} and cannot be resolved again.`);
    if(!['resolved','dismissed'].includes(request.status))throw new Error('Human task can only be resolved or dismissed.');
    let linkedQc:ShotQcResult|undefined;
    for(const result of project.qcResults){
      if(result.humanOverrideTaskId!==task.id)continue;
      if(!linkedQc||result.createdAt>linkedQc.createdAt||result.createdAt===linkedQc.createdAt)linkedQc=result;
    }
    if(linkedQc){
      if(!linkedQc.renderOutputId||linkedQc.layer==='technical'||!linkedQc.inputKey)throw new Error('QC review task has incomplete provenance and cannot be closed safely.');
      const currentKey=shotQcInputKey(project,linkedQc.shotId,linkedQc.renderOutputId,linkedQc.layer);
      if(currentKey!==linkedQc.inputKey)throw new Error('QC review task became stale because its shot/output/state inputs changed.');
      const verdict=latestShotQcResult(project,linkedQc.shotId,linkedQc.renderOutputId,linkedQc.layer,linkedQc.inputKey);
      const verdictIsAfterReview=Boolean(verdict&&verdict.id!==linkedQc.id&&verdict.createdAt>=linkedQc.createdAt);
      if(!verdictIsAfterReview||!verdict||!['pass','fail'].includes(verdict.status))throw new Error('QC review tasks require a current PASS or FAIL verdict before they can be closed.');
    }
    if(request.status==='resolved'&&task.type==='verify-keyframe'&&task.shotId&&/^Review generated (start|end) keyframe$/.test(task.title)){
      const shot=project.shots.find(item=>item.id===task.shotId);if(!shot)throw new Error('Generated keyframe review references a missing shot.');
      const expectedRole=task.title.includes(' start ')?'start':'end';
      const selectedId=expectedRole==='start'?shot.startFrameAssetId:shot.endFrameAssetId;
      if(!selectedId||!task.relatedAssetIds.includes(selectedId))throw new Error(`Generated ${expectedRole} keyframe review can only be resolved after that exact candidate is attached to the ${expectedRole} frame slot. Dismiss the task if you intentionally chose another frame.`);
    }
    task.status=request.status;
    task.resolution=requireString(request.resolution,20_000,'human task resolution');
    task.resolvedAt=new Date().toISOString();
    if(task.type==='verify-previz'&&task.shotId){
      const shot=project.shots.find(item=>item.id===task.shotId);
      if(shot?.previz){
        shot.previz.status=request.status==='resolved'?'ready':'human-verify';
        shot.previz.reason=request.status==='resolved'
          ?`Human override: previz approved. ${task.resolution}`
          :`Human override: previz review dismissed. ${task.resolution}`;
        shot.previz.updatedAt=task.resolvedAt;
      }
    }
    if(linkedQc)refreshCanonicalRender(project,linkedQc.shotId);
  });
}

export async function promoteCanonicalTake(projects:ProjectService,request:PromoteCanonicalTakeRequest):Promise<FilmProject>{
  return projects.mutate(project=>{
    assertProject(project,request.projectRoot);
    const shot=project.shots.find(item=>item.id===request.shotId);if(!shot)throw new Error('Shot not found.');
    const readiness=canonicalTakeReadiness(project,shot.id,request.renderOutputId);
    if(!readiness.ready)throw new Error(`Take cannot become canonical: ${readiness.blockers.join(' ')}`);
    shot.canonicalRenderId=request.renderOutputId;
  });
}

function createHumanTaskRecord(project:FilmProject,request:CreateHumanTaskRequest):HumanTask{
  if(project.humanTasks.length>=HUMAN_TASK_LIMIT)throw new Error(`Human-task history would exceed the ${HUMAN_TASK_LIMIT}-item safety limit.`);
  const allowedTypes=new Set(['create-asset','approve-asset','verify-keyframe','verify-previz','verify-continuity','choose-take','manual-qc','route-unsupported']);
  if(!allowedTypes.has(request.type))throw new Error('Invalid human task type.');
  if(request.shotId&&!project.shots.some(item=>item.id===request.shotId))throw new Error('Human task references an unknown shot.');
  const relatedAssetIds=dedupeBounded(request.relatedAssetIds??[],64,'human task assets').map(id=>requireAsset(project,id,undefined,'human task asset').id);
  const relatedRenderOutputIds=dedupeBounded(request.relatedRenderOutputIds??[],64,'human task render outputs').map(id=>{
    const output=project.renderOutputs.find(item=>item.id===id);if(!output)throw new Error(`Human task references unknown render output: ${id}`);
    if(request.shotId&&output.shotId!==request.shotId)throw new Error(`Human task for shot ${request.shotId} cannot reference render output ${id} from shot ${output.shotId}.`);
    return output.id;
  });
  const task:HumanTask={
    id:randomUUID(),type:request.type,status:'open',shotId:request.shotId,
    title:requireString(request.title,2000,'human task title'),
    reason:requireString(request.reason,20_000,'human task reason'),
    recommendedAction:optionalText(request.recommendedAction,20_000,'human task recommended action'),
    relatedAssetIds,relatedRenderOutputIds,createdAt:new Date().toISOString()
  };
  project.humanTasks.push(task);return task;
}

function normalizeCharacters(project:FilmProject,input:CharacterContinuityState[]):CharacterContinuityState[]{
  if(!Array.isArray(input)||input.length>32)throw new Error('Observed character state exceeds the 32-item safety limit.');
  return input.map((item,index)=>{
    const characterAssetId=item.characterAssetId?requireAsset(project,item.characterAssetId,new Set(['character']),`character state ${index}`).id:undefined;
    const wardrobeAssetId=item.wardrobeAssetId?requireAsset(project,item.wardrobeAssetId,new Set(['wardrobe']),`wardrobe state ${index}`).id:undefined;
    const heldPropAssetIds=dedupeBounded(item.heldPropAssetIds??[],32,'held prop assets').map(id=>requireAsset(project,id,new Set(['prop']),'held prop').id);
    const positions=new Set(['left','center','right','offscreen','unknown']);
    if(item.screenPosition&&!positions.has(item.screenPosition))throw new Error('Invalid character screen position.');
    return{
      characterAssetId,label:optionalText(item.label,1000,'character label'),visible:typeof item.visible==='boolean'?item.visible:undefined,
      screenPosition:item.screenPosition,pose:optionalText(item.pose,5000,'character pose'),facing:optionalText(item.facing,2000,'character facing'),
      gaze:optionalText(item.gaze,2000,'character gaze'),expression:optionalText(item.expression,5000,'character expression'),
      wardrobeAssetId,heldPropAssetIds,notes:optionalText(item.notes,10_000,'character notes')
    };
  });
}

function normalizeProps(project:FilmProject,input:PropContinuityState[]):PropContinuityState[]{
  if(!Array.isArray(input)||input.length>64)throw new Error('Observed prop state exceeds the 64-item safety limit.');
  return input.map((item,index)=>({
    propAssetId:item.propAssetId?requireAsset(project,item.propAssetId,new Set(['prop']),`prop state ${index}`).id:undefined,
    label:optionalText(item.label,1000,'prop label'),
    holderCharacterAssetId:item.holderCharacterAssetId?requireAsset(project,item.holderCharacterAssetId,new Set(['character']),'prop holder').id:undefined,
    position:optionalText(item.position,5000,'prop position'),state:optionalText(item.state,5000,'prop state'),notes:optionalText(item.notes,10_000,'prop notes')
  }));
}

function normalizeIssues(input:QcIssue[]):QcIssue[]{
  if(!Array.isArray(input)||input.length>128)throw new Error('QC issues exceed the 128-item safety limit.');
  const severities=new Set(['info','warning','major','blocker']);
  return input.map(issue=>{
    if(!severities.has(issue.severity))throw new Error('Invalid QC issue severity.');
    return{code:requireString(issue.code,256,'QC issue code'),severity:issue.severity,message:requireString(issue.message,4096,'QC issue message'),expected:optionalText(issue.expected,4096,'QC expected value'),observed:optionalText(issue.observed,4096,'QC observed value')};
  });
}

function requireAsset(project:FilmProject,id:string,kinds:Set<string>|undefined,label:string){
  requireString(id,256,`${label} id`);
  const asset=project.assets.find(item=>item.id===id);if(!asset)throw new Error(`${label} references unknown asset: ${id}`);
  if(kinds&&!kinds.has(asset.kind))throw new Error(`${label} has incompatible asset kind ${asset.kind}.`);
  return asset;
}

function assertProject(project:FilmProject,root:string):void{
  if(project.rootPath!==root)throw new Error('Production-state request does not match the open project.');
}

function dedupeBounded(values:string[],max:number,label:string):string[]{
  if(!Array.isArray(values)||values.length>max)throw new Error(`${label} exceed the ${max}-item safety limit.`);
  return[...new Set(values.map(value=>requireString(value,256,`${label} id`)))];
}

function requireString(value:unknown,max:number,label:string):string{
  if(typeof value!=='string')throw new Error(`${label} must be a string.`);
  if(value.length>max)throw new Error(`${label} exceeds the ${max}-character safety limit.`);
  return value;
}

function optionalText(value:unknown,max:number,label:string):string|undefined{
  if(value==null||value==='')return undefined;
  return requireString(value,max,label);
}
