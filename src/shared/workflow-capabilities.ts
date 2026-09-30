import type { WorkflowCapabilities, WorkflowProfile } from './types';

const GENERIC_KEYS=['referenceImage1','referenceImage2','referenceImage3','referenceImage4'] as const;

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
