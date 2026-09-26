import type { RenderOutput, TimelineClip } from './types';

export function timelineOutputIssue(
  clip:Pick<TimelineClip,'id'|'shotId'|'renderOutputId'>,
  output:RenderOutput|undefined
):string|undefined{
  if(!output)return `Timeline clip ${clip.id} references a missing render output: ${clip.renderOutputId}.`;
  if(output.shotId!==clip.shotId)return `Timeline clip ${clip.id} belongs to shot ${clip.shotId} but render output ${output.id} belongs to shot ${output.shotId}.`;
  if(output.mediaType!=='video')return `Timeline clip ${clip.id} references a non-video render output: ${output.id}.`;
  return undefined;
}

export function duplicateTimelineOrderKey(clips:Array<Pick<TimelineClip,'track'|'order'>>):string|undefined{
  const seen=new Set<string>();
  for(const clip of clips){const key=`${clip.track}:${clip.order}`;if(seen.has(key))return key;seen.add(key);}
  return undefined;
}
