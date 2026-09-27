import type { FilmProject, RenderOutput, TimelineClip } from './types';

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


export function timelineExportInputKey(project:FilmProject):string{
  const outputs=new Map(project.renderOutputs.map(output=>[output.id,output] as const));
  const clips=[...project.timeline].sort((a,b)=>a.track-b.track||a.order-b.order||a.id.localeCompare(b.id)).map(clip=>{
    const output=outputs.get(clip.renderOutputId);
    return{clip,output:output?{id:output.id,shotId:output.shotId,path:output.path,mediaType:output.mediaType}:undefined};
  });
  return JSON.stringify({
    projectId:project.id,
    rootPath:project.rootPath,
    name:project.name,
    defaultFps:project.settings.defaultFps,
    outputContainer:project.settings.outputContainer,
    clips
  });
}

export function capcutHandoffInputKey(project:FilmProject):string{
  const outputIds=new Set(project.timeline.map(clip=>clip.renderOutputId));
  const shotIds=new Set(project.timeline.map(clip=>clip.shotId));
  return JSON.stringify({
    project:{id:project.id,rootPath:project.rootPath,name:project.name,schemaVersion:project.schemaVersion},
    story:project.story,
    policy:{costPolicy:project.settings.costPolicy,capcut:project.settings.capcut,defaultFps:project.settings.defaultFps,outputContainer:project.settings.outputContainer},
    timeline:[...project.timeline].sort((a,b)=>a.track-b.track||a.order-b.order||a.id.localeCompare(b.id)),
    shots:project.shots.filter(shot=>shotIds.has(shot.id)).map(shot=>({id:shot.id,title:shot.title,dialogue:shot.dialogue,continuityNotes:shot.continuityNotes})).sort((a,b)=>a.id.localeCompare(b.id)),
    outputs:project.renderOutputs.filter(output=>outputIds.has(output.id)).map(output=>({id:output.id,jobId:output.jobId,shotId:output.shotId,path:output.path,filename:output.filename,mediaType:output.mediaType,technicalQc:output.technicalQc})).sort((a,b)=>a.id.localeCompare(b.id)),
    assets:project.assets.map(asset=>({id:asset.id,kind:asset.kind,name:asset.name,projectPath:asset.projectPath,notes:asset.notes,tags:asset.tags})).sort((a,b)=>a.id.localeCompare(b.id))
  });
}
