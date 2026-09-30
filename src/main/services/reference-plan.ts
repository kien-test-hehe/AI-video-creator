import type { Shot, WorkflowBindingKey, WorkflowProfile } from '../../shared/types';

const CHARACTER_KEYS=['characterImage1','characterImage2','characterImage3','characterImage4'] as const;
const PROP_KEYS=['propImage1','propImage2'] as const;
const GENERIC_KEYS=['referenceImage1','referenceImage2','referenceImage3','referenceImage4'] as const;

export interface ShotReferencePlan {
  characterIds:Array<string|undefined>;
  locationId?:string;
  propIds:Array<string|undefined>;
  genericIds:string[];
  genericBindingKeys:WorkflowBindingKey[];
  genericArray:boolean;
  genericCapacity:number;
  genericDemand:number;
  unservedIds:string[];
}

export function planShotReferences(shot:Shot,profile:WorkflowProfile):ShotReferencePlan{
  const keys=new Set(profile.bindings.map(binding=>binding.key));
  const genericCandidates:string[]=[];
  const characterIds:Array<string|undefined>=[];
  const propIds:Array<string|undefined>=[];

  for(const[index,id]of shot.characterAssetIds.entries()){
    if(index<CHARACTER_KEYS.length&&keys.has(CHARACTER_KEYS[index]))characterIds[index]=id;
    else genericCandidates.push(id);
  }

  const locationId=shot.locationAssetId&&keys.has('locationImage')?shot.locationAssetId:undefined;
  if(shot.locationAssetId&&!locationId)genericCandidates.push(shot.locationAssetId);

  for(const[index,id]of shot.propAssetIds.entries()){
    if(index<PROP_KEYS.length&&keys.has(PROP_KEYS[index]))propIds[index]=id;
    else genericCandidates.push(id);
  }

  for(const id of shot.referenceAssetIds??[])genericCandidates.push(id);

  const uniqueCandidates=[...new Set(genericCandidates)];
  const genericArray=keys.has('referenceImages');
  const genericBindingKeys=genericArray?[]:GENERIC_KEYS.filter(key=>keys.has(key));
  const genericCapacity=genericArray?16:genericBindingKeys.length;
  const genericIds=uniqueCandidates.slice(0,genericCapacity);
  const unservedIds=uniqueCandidates.slice(genericCapacity);

  return{
    characterIds,
    locationId,
    propIds,
    genericIds,
    genericBindingKeys:[...genericBindingKeys],
    genericArray,
    genericCapacity,
    genericDemand:uniqueCandidates.length,
    unservedIds
  };
}
