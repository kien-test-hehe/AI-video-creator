import type { ModelFamily, Shot } from './types';

export interface ModelRoutingOptions {
  validatedModels?: Iterable<ModelFamily>;
}

export function chooseModelForShot(
  shot: Pick<Shot, 'dialogue' | 'generation' | 'camera' | 'action'>,
  options: ModelRoutingOptions = {}
): ModelFamily {
  const seconds = shot.generation.frames / Math.max(1, shot.generation.fps);
  const candidates:ModelFamily[]=[];
  if(seconds>10||shot.dialogue.trim()||shot.generation.includeAudio)candidates.push('ltx-2.5-fast');
  else if(shot.generation.quality==='hero')candidates.push('hunyuan-video-1.5','ltx-2.5-fast');
  else if(/fast|whip|fight|action|tracking|orbit|chase|sprint|explosion/i.test(`${shot.camera} ${shot.action}`))candidates.push('wan-2.2-5b','ltx-2.5-fast','hunyuan-video-1.5');
  else candidates.push('ltx-2.5-fast');

  if(options.validatedModels){
    const validated=new Set(options.validatedModels);
    const selected=candidates.find(model=>validated.has(model));
    if(selected)return selected;
    if(validated.has(shot.generation.modelFamily))return shot.generation.modelFamily;
    const deterministicFallback:ModelFamily[]=['ltx-2.5-fast','wan-2.2-5b','hunyuan-video-1.5','ltx-2.3','framepack','custom'];
    return deterministicFallback.find(model=>validated.has(model))??shot.generation.modelFamily;
  }
  return candidates[0];
}
