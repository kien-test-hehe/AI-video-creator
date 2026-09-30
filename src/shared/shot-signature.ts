import type { FilmProject, RenderJobSpec, Shot, WorkflowProfile } from './types';

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
  return JSON.stringify({
    shot:shotKeyframeInputKey(shot,role),
    actualStartState:stateRenderKey(project,shot.actualStartStateId),
    plannedStartState:stateRenderKey(project,shot.plannedStartStateId),
    plannedEndState:stateRenderKey(project,shot.plannedEndStateId),
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
    enabled:profile.enabled,
    modelFingerprint:profile.modelFingerprint
  });
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
  if(shot.generation.workflowProfileId)return project.settings.workflowProfiles.find(profile=>profile.id===shot.generation.workflowProfileId);
  const candidates=project.settings.workflowProfiles.filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.modelFamily===shot.generation.modelFamily&&profile.mode===shot.generation.mode&&Boolean(profile.workflowPath));
  return candidates.find(profile=>profile.validation?.structuralStatus==='valid')??candidates[0];
}

export function shotProjectRenderInputKeyForProfile(project:FilmProject,shot:Shot,profile:WorkflowProfile|undefined):string{
  const ids=[...shot.characterAssetIds,...shot.propAssetIds,...(shot.referenceAssetIds??[]),shot.locationAssetId].filter((id):id is string=>Boolean(id));
  const promptAssets=[...new Set(ids)].map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({
    id:asset!.id,kind:asset!.kind,name:asset!.name,notes:asset!.notes
  })).sort((a,b)=>a.id.localeCompare(b.id));
  return JSON.stringify({
    shot:shotRenderInputKey(shot),
    promptAssets,
    actualStartState:stateRenderKey(project,shot.actualStartStateId),
    plannedStartState:stateRenderKey(project,shot.plannedStartStateId),
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
