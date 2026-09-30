import type { Shot, WorkflowCapabilities, WorkflowProfile } from './types';

const GENERIC_KEYS=['referenceImage1','referenceImage2','referenceImage3','referenceImage4'] as const;

export interface WorkflowCapabilityShot {
  generation:{modelFamily:string;mode:string;includeAudio?:boolean};
  startFrameAssetId?:string;
  endFrameAssetId?:string;
  audioAssetId?:string;
  referenceVideoAssetId?:string;
  characterAssetIds?:string[];
  locationAssetId?:string;
  propAssetIds?:string[];
  referenceAssetIds?:string[];
}

export interface EffectiveWorkflowCapabilities {
  maxGenericReferences:number;
  supportsStartImage:boolean;
  supportsEndImage:boolean;
  supportsInputAudio:boolean;
  supportsInputVideo:boolean;
  supportsGeneratedAudio:boolean;
}

export function effectiveWorkflowCapabilities(profile:Pick<WorkflowProfile,'bindings'|'capabilities'>):EffectiveWorkflowCapabilities{
  const keys=new Set(profile.bindings.map(binding=>binding.key));
  const declared=profile.capabilities??{};
  const discreteGeneric=GENERIC_KEYS.filter(key=>keys.has(key)).length;
  const inferredGeneric=keys.has('referenceImages')?Math.max(4,discreteGeneric):discreteGeneric;
  const declaredGeneric=declared.maxGenericReferences;
  return{
    maxGenericReferences:Number.isInteger(declaredGeneric)&&declaredGeneric!>=0?Math.min(64,declaredGeneric!):inferredGeneric,
    supportsStartImage:declared.supportsStartImage??keys.has('startImage'),
    supportsEndImage:declared.supportsEndImage??keys.has('endImage'),
    supportsInputAudio:declared.supportsInputAudio??keys.has('inputAudio'),
    supportsInputVideo:declared.supportsInputVideo??keys.has('inputVideo'),
    supportsGeneratedAudio:declared.supportsGeneratedAudio??keys.has('includeAudio')
  };
}


export function workflowCapabilityErrors(profile:WorkflowProfile,shot:WorkflowCapabilityShot):string[]{
  const errors:string[]=[],caps=effectiveWorkflowCapabilities(profile),keys=new Set(profile.bindings.map(binding=>binding.key));
  if(profile.modelFamily!==shot.generation.modelFamily)errors.push(`Profile model family ${profile.modelFamily} does not match shot model ${shot.generation.modelFamily}.`);
  if(profile.mode!==shot.generation.mode)errors.push(`Profile mode ${profile.mode} does not match shot mode ${shot.generation.mode}.`);
  if((shot.generation.mode==='i2v'||shot.generation.mode==='flf2v'||shot.generation.mode==='ia2v'||Boolean(shot.startFrameAssetId))&&!caps.supportsStartImage){
    errors.push('Shot requires a start-image input but this workflow profile has no declared/bound start-image capability.');
  }
  if((shot.generation.mode==='flf2v'||Boolean(shot.endFrameAssetId))&&!caps.supportsEndImage){
    errors.push('Shot requires an end-image input but this workflow profile has no declared/bound end-image capability.');
  }
  if((shot.generation.mode==='ia2v'||Boolean(shot.audioAssetId))&&!caps.supportsInputAudio){
    errors.push('Shot requires an input-audio binding but this workflow profile cannot accept input audio.');
  }
  if((shot.generation.mode==='v2v'||Boolean(shot.referenceVideoAssetId))&&!caps.supportsInputVideo){
    errors.push('Shot requires an input-video binding but this workflow profile cannot accept input video.');
  }
  if(Boolean(shot.generation.includeAudio)&&!caps.supportsGeneratedAudio){
    errors.push('Shot requests generated audio but this workflow profile does not declare or bind generated-audio support.');
  }

  const genericCandidates:string[]=[];
  const characterKeys=['characterImage1','characterImage2','characterImage3','characterImage4'] as const;
  for(const[index,id]of (shot.characterAssetIds??[]).entries()){
    if(index>=characterKeys.length||!keys.has(characterKeys[index]))genericCandidates.push(id);
  }
  if(shot.locationAssetId&&!keys.has('locationImage'))genericCandidates.push(shot.locationAssetId);
  const propKeys=['propImage1','propImage2'] as const;
  for(const[index,id]of (shot.propAssetIds??[]).entries()){
    if(index>=propKeys.length||!keys.has(propKeys[index]))genericCandidates.push(id);
  }
  genericCandidates.push(...(shot.referenceAssetIds??[]));
  const demand=new Set(genericCandidates).size;
  if(demand>caps.maxGenericReferences){
    errors.push(`Workflow reference capacity is insufficient: ${demand-caps.maxGenericReferences} attached reference asset(s) cannot be bound.`);
  }
  return errors;
}
