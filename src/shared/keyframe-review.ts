import type { Asset } from './types';

export const GENERATED_KEYFRAME_CANDIDATE_TAG='system:keyframe-candidate';
export const GENERATED_KEYFRAME_APPROVED_TAG='system:keyframe-approved';
export const GENERATED_KEYFRAME_REJECTED_TAG='system:keyframe-rejected';
export const KEYFRAME_ROLE_TAG_PREFIX='keyframe-role:';
export const KEYFRAME_PROFILE_TAG_PREFIX='keyframe-profile:';
export const KEYFRAME_INPUT_TAG_PREFIX='keyframe-input:';

export interface GeneratedKeyframeCandidateInfo{
  role:'start'|'end';
  profileId:string;
  inputKey:string;
}

export function generatedKeyframeCandidateTags(role:'start'|'end',profileId:string,inputKey:string):string[]{
  return[
    GENERATED_KEYFRAME_CANDIDATE_TAG,
    `${KEYFRAME_ROLE_TAG_PREFIX}${role}`,
    `${KEYFRAME_PROFILE_TAG_PREFIX}${profileId}`,
    `${KEYFRAME_INPUT_TAG_PREFIX}${inputKey}`
  ];
}

export function generatedKeyframeCandidateInfo(asset:Pick<Asset,'kind'|'tags'>):GeneratedKeyframeCandidateInfo|undefined{
  if(asset.kind!=='keyframe'||!asset.tags.includes(GENERATED_KEYFRAME_CANDIDATE_TAG))return undefined;
  const roleValue=asset.tags.find(tag=>tag.startsWith(KEYFRAME_ROLE_TAG_PREFIX))?.slice(KEYFRAME_ROLE_TAG_PREFIX.length);
  const profileId=asset.tags.find(tag=>tag.startsWith(KEYFRAME_PROFILE_TAG_PREFIX))?.slice(KEYFRAME_PROFILE_TAG_PREFIX.length);
  const inputKey=asset.tags.find(tag=>tag.startsWith(KEYFRAME_INPUT_TAG_PREFIX))?.slice(KEYFRAME_INPUT_TAG_PREFIX.length);
  if((roleValue!=='start'&&roleValue!=='end')||!profileId||!inputKey)return undefined;
  return{role:roleValue,profileId,inputKey};
}
