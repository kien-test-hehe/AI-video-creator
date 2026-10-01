import type { FilmProject, RenderJobSpec, Shot, WorkflowProfile } from './types';
import { workflowCapabilityErrors } from './workflow-capabilities';

export function shotRenderInputKey(shot:Shot):string{
  return JSON.stringify({
    prompt:shot.prompt,
    camera:shot.camera,
    action:shot.action,
    dialogue:shot.dialogue,
    continuityNotes:shot.continuityNotes,
    characterAssetIds:shot.characterAssetIds,
    locationAssetId:shot.locationAssetId,
    propAssetIds:shot.propAssetIds,
    referenceAssetIds:shot.referenceAssetIds??[],
    startFrameAssetId:shot.startFrameAssetId,
    endFrameAssetId:shot.endFrameAssetId,
    referenceVideoAssetId:shot.referenceVideoAssetId,
    audioAssetId:shot.audioAssetId,
    generation:shot.generation
  });
}

export function shotKeyframeInputKey(shot:Shot,role:'start'|'end'):string{
  return JSON.stringify({
    role,
    prompt:shot.prompt,
    camera:shot.camera,
    action:shot.action,
    continuityNotes:shot.continuityNotes,
    characterAssetIds:shot.characterAssetIds,
    locationAssetId:shot.locationAssetId,
    propAssetIds:shot.propAssetIds,
    referenceAssetIds:shot.referenceAssetIds??[],
    startFrameAssetId:role==='end'?shot.startFrameAssetId:undefined,
    generation:{
      modelFamily:shot.generation.modelFamily,
      width:shot.generation.width,
      height:shot.generation.height,
      steps:shot.generation.steps,
      cfg:shot.generation.cfg,
      seed:shot.generation.seed,
      negativePrompt:shot.generation.negativePrompt
    }
  });
}


export function currentGenerationState(project:Pick<FilmProject,'shotStates'>,stateId:string|undefined):FilmProject['shotStates'][number]|undefined{
  if(!stateId)return undefined;
  return project.shotStates.find(item=>item.id===stateId&&item.status==='current');
}

function stateRenderKey(project:FilmProject,stateId:string|undefined):unknown{
  if(!stateId)return undefined;
  const state=currentGenerationState(project,stateId);
  if(!state)return undefined;
  return{
    id:state.id,role:state.role,source:state.source,status:state.status,frameAssetId:state.frameAssetId,
    derivedFromStateId:state.derivedFromStateId,characters:state.characters,props:state.props,
    environment:state.environment,camera:state.camera,actionPhase:state.actionPhase,dialogueState:state.dialogueState,
    confidence:state.confidence,fingerprint:state.fingerprint
  };
}

export function keyframeProjectInputKey(project:FilmProject,shot:Shot,role:'start'|'end',profile:WorkflowProfile|undefined):string{
  const actualStart=role==='start'?currentGenerationState(project,shot.actualStartStateId):undefined;
  const effectiveState=role==='start'
    ? stateRenderKey(project,actualStart?.id??shot.plannedStartStateId)
    : stateRenderKey(project,shot.plannedEndStateId);
  return JSON.stringify({
    shot:shotKeyframeInputKey(shot,role),
    effectiveState,
    workflow:workflowExecutionKey(profile)
  });
}

export function workflowExecutionKey(profile:WorkflowProfile|undefined):string{
  if(!profile)return'none';
  return JSON.stringify({
    id:profile.id,
    runtime:profile.runtime,
    purpose:profile.purpose??'video',
    modelFamily:profile.modelFamily,
    mode:profile.mode,
    workflowPath:profile.workflowPath,
    workflowFormat:profile.workflowFormat,
    bindings:profile.bindings,
    capabilities:profile.capabilities,
    enabled:profile.enabled,
    modelFingerprint:profile.modelFingerprint
  });
}

export function workflowQualificationKey(profile:WorkflowProfile|undefined):string|undefined{
  const validation=profile?.validation;
  if(!profile||validation?.structuralStatus!=='valid'||!validation.sourceSha256||!validation.runtimeFingerprint)return undefined;
  return JSON.stringify({
    execution:workflowExecutionKey(profile),
    sourceSha256:validation.sourceSha256,
    runtimeFingerprint:validation.runtimeFingerprint,
    modelFingerprint:profile.modelFingerprint??null
  });
}

export function profileHasCurrentRuntimeQualification(profile:WorkflowProfile|undefined):boolean{
  const key=workflowQualificationKey(profile);
  return Boolean(
    key&&
    profile?.validation?.lastSuccessfulRenderAt&&
    profile.validation.lastSuccessfulQualificationKey===key
  );
}

export function clearRuntimeQualificationTelemetry(profile:WorkflowProfile):void{
  if(!profile.validation)return;
  profile.validation.lastSuccessfulRenderAt=undefined;
  profile.validation.lastSuccessfulQualificationKey=undefined;
  profile.validation.successfulRenderCount=undefined;
  profile.validation.lastRenderWallSec=undefined;
  profile.validation.lastRenderWidth=undefined;
  profile.validation.lastRenderHeight=undefined;
  profile.validation.lastRenderFrames=undefined;
}

export function canRefreshProfileValidationFromRender(profile:WorkflowProfile|undefined,spec:RenderJobSpec|undefined):boolean{
  if(!profile||!spec)return false;
  return workflowExecutionKey(profile)===workflowExecutionKey(spec.workflowProfile)
    &&profile.validation?.structuralStatus==='valid'
    &&profile.validation.sourceSha256===spec.workflowSha256
    &&profile.validation.runtimeFingerprint===spec.runtimeFingerprint.environmentSha256
    &&(profile.modelFingerprint||undefined)===(spec.modelFingerprint||undefined);
}

function effectiveWorkflowProfile(project:FilmProject,shot:Shot):WorkflowProfile|undefined{
  if(shot.generation.workflowProfileId){
    const explicit=project.settings.workflowProfiles.find(profile=>profile.id===shot.generation.workflowProfileId);
    if(!explicit||!explicit.enabled||(explicit.purpose??'video')!=='video'||!explicit.workflowPath||explicit.validation?.structuralStatus!=='valid'||workflowCapabilityErrors(explicit,shot).length)return undefined;
    return explicit;
  }
  const candidates=project.settings.workflowProfiles.filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.modelFamily===shot.generation.modelFamily&&profile.mode===shot.generation.mode&&Boolean(profile.workflowPath));
  const compatible=candidates
    .filter(profile=>profile.validation?.structuralStatus==='valid'&&workflowCapabilityErrors(profile,shot).length===0)
    .sort((a,b)=>
      Number(profileHasCurrentRuntimeQualification(b))-Number(profileHasCurrentRuntimeQualification(a))||
      (profileHasCurrentRuntimeQualification(b)?(b.validation?.successfulRenderCount??0):0)-(profileHasCurrentRuntimeQualification(a)?(a.validation?.successfulRenderCount??0):0)||
      (profileHasCurrentRuntimeQualification(b)?(b.validation?.lastSuccessfulRenderAt??''):'').localeCompare(profileHasCurrentRuntimeQualification(a)?(a.validation?.lastSuccessfulRenderAt??''):'')||
      a.id.localeCompare(b.id)
    );
  // Automatic routing truth must match main-process routeWorkflow(): an
  // incompatible or unvalidated profile is not an effective production route.
  return compatible[0];
}

export function shotProjectRenderInputKeyForProfile(project:FilmProject,shot:Shot,profile:WorkflowProfile|undefined):string{
  const ids=[...shot.characterAssetIds,...shot.propAssetIds,...(shot.referenceAssetIds??[]),shot.locationAssetId].filter((id):id is string=>Boolean(id));
  const promptAssets=[...new Set(ids)].map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({
    id:asset!.id,kind:asset!.kind,name:asset!.name,notes:asset!.notes,continuity:asset!.continuity
  })).sort((a,b)=>a.id.localeCompare(b.id));
  const actualStart=currentGenerationState(project,shot.actualStartStateId);
  return JSON.stringify({
    shot:shotRenderInputKey(shot),
    promptAssets,
    actualStartState:actualStart?stateRenderKey(project,actualStart.id):undefined,
    plannedStartState:actualStart?undefined:stateRenderKey(project,shot.plannedStartStateId),
    plannedEndState:stateRenderKey(project,shot.plannedEndStateId),
    workflow:workflowExecutionKey(profile)
  });
}

export function shotProjectRenderInputKey(project:FilmProject,shot:Shot):string{
  return shotProjectRenderInputKeyForProfile(project,shot,effectiveWorkflowProfile(project,shot));
}


export function preserveTrustedProfileValidation(current:WorkflowProfile|undefined,incoming:WorkflowProfile):WorkflowProfile{
  if(!current)return{...structuredClone(incoming),validation:{structuralStatus:'unvalidated',lastError:'New workflow profiles must be validated by the main process before use.'}};
  if(workflowExecutionKey(incoming)!==workflowExecutionKey(current))return{...structuredClone(incoming),validation:{structuralStatus:'unvalidated',lastError:'Profile execution configuration changed. Validate it again before rendering.'}};
  return{...structuredClone(incoming),validation:structuredClone(current.validation)};
}
