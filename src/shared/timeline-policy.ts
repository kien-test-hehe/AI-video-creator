import type { FilmProject, RenderOutput, TimelineClip } from './types';
import { canonicalTakeReadiness, currentProductionInputKeyForOutput, latestShotQcResult, productionFingerprint, renderOutputProductionInputKey, shotQcInputKey } from './production-state';

export function timelineOutputIssue(
  clip:Pick<TimelineClip,'id'|'shotId'|'renderOutputId'>,
  output:RenderOutput|undefined
):string|undefined{
  if(!output)return `Timeline clip ${clip.id} references a missing render output: ${clip.renderOutputId}.`;
  if(output.shotId!==clip.shotId)return `Timeline clip ${clip.id} belongs to shot ${clip.shotId} but render output ${output.id} belongs to shot ${output.shotId}.`;
  if(output.mediaType!=='video')return `Timeline clip ${clip.id} references a non-video render output: ${output.id}.`;
  return undefined;
}

export function timelineTakeApprovalInputKey(project:FilmProject,outputId:string):string{
  const output=project.renderOutputs.find(item=>item.id===outputId);
  const shot=output?project.shots.find(item=>item.id===output.shotId):undefined;
  if(!output||!shot)return productionFingerprint('timeline-approval',JSON.stringify({outputId,missing:true}));
  const layers:Array<'visual'|'semantic'|'continuity'>=['visual','semantic'];
  if(project.shotDependencies.some(edge=>edge.toShotId===shot.id&&edge.relation!=='parallel'&&edge.propagate.length>0))layers.push('continuity');
  const qcs=layers.map(layer=>{
    const expected=shotQcInputKey(project,shot.id,output.id,layer);
    const result=latestShotQcResult(project,shot.id,output.id,layer,expected);
    return{layer,expected,result:result?{id:result.id,status:result.status,createdAt:result.createdAt,issues:result.issues}:undefined};
  });
  const openReviews=project.humanTasks
    .filter(task=>task.status==='open'&&task.relatedRenderOutputIds.includes(output.id)&&['manual-qc','verify-continuity'].includes(task.type))
    .map(task=>({id:task.id,type:task.type,title:task.title,createdAt:task.createdAt}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const readiness=canonicalTakeReadiness(project,shot.id,output.id);
  return productionFingerprint('timeline-approval',JSON.stringify({
    shotId:shot.id,outputId:output.id,canonicalRenderId:shot.canonicalRenderId,
    recordedProductionInputKey:renderOutputProductionInputKey(project,output),
    currentProductionInputKey:currentProductionInputKeyForOutput(project,shot,output),
    technicalQc:output.technicalQc,qcs,openReviews,readiness
  }));
}

export function timelineClipApprovalIssue(project:FilmProject,clip:TimelineClip):string|undefined{
  const shot=project.shots.find(item=>item.id===clip.shotId);
  if(!shot)return `Timeline clip ${clip.id} references a missing shot: ${clip.shotId}.`;
  const approval=clip.approval??'legacy';
  if(approval==='human-override'){
    if(!clip.approvalReason?.trim())return `Timeline clip ${clip.id} is marked as a human override without a recorded reason.`;
    if(!clip.approvalInputKey)return `Timeline clip ${clip.id} has a legacy human override without approval provenance. Re-approve this take against the current shot/QC state.`;
    const currentKey=timelineTakeApprovalInputKey(project,clip.renderOutputId);
    if(currentKey!==clip.approvalInputKey)return `Timeline clip ${clip.id} human override is stale because the shot, render provenance, QC, or review state changed. Re-approve this take.`;
    return undefined;
  }
  if(approval==='legacy')return `Timeline clip ${clip.id} uses legacy take approval. Re-approve this clip or rebuild the cut from canonical takes before export.`;
  if(shot.canonicalRenderId!==clip.renderOutputId)return `Timeline clip ${clip.id} is marked canonical but no longer matches the shot's canonical take.`;
  const readiness=canonicalTakeReadiness(project,clip.shotId,clip.renderOutputId);
  if(!readiness.ready)return `Timeline clip ${clip.id} is no longer canonical-ready: ${readiness.blockers.join(' ')}`;
  return undefined;
}

export function timelineClipUseIssue(project:FilmProject,clip:TimelineClip):string|undefined{
  const output=project.renderOutputs.find(item=>item.id===clip.renderOutputId);
  return timelineOutputIssue(clip,output)??timelineClipApprovalIssue(project,clip);
}

export function duplicateTimelineOrderKey(clips:Array<Pick<TimelineClip,'track'|'order'>>):string|undefined{
  const seen=new Set<string>();
  for(const clip of clips){const key=`${clip.track}:${clip.order}`;if(seen.has(key))return key;seen.add(key);}
  return undefined;
}

export function compareTimelineClips(
  a:Pick<TimelineClip,'track'|'order'|'id'>,
  b:Pick<TimelineClip,'track'|'order'|'id'>
):number{
  return a.track-b.track||a.order-b.order||a.id.localeCompare(b.id);
}

export function timelineExportInputKey(project:FilmProject):string{
  const outputs=new Map(project.renderOutputs.map(output=>[output.id,output] as const));
  const clips=[...project.timeline].sort(compareTimelineClips).map(clip=>{
    const output=outputs.get(clip.renderOutputId);
    return{
      clip,
      output:output?{id:output.id,shotId:output.shotId,path:output.path,mediaType:output.mediaType,technicalQc:output.technicalQc}:undefined,
      approvalStateKey:timelineTakeApprovalInputKey(project,clip.renderOutputId),
      useIssue:timelineClipUseIssue(project,clip)
    };
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
    timeline:[...project.timeline].sort(compareTimelineClips).map(clip=>({
      ...clip,
      approvalStateKey:timelineTakeApprovalInputKey(project,clip.renderOutputId),
      useIssue:timelineClipUseIssue(project,clip)
    })),
    shots:project.shots.filter(shot=>shotIds.has(shot.id)).map(shot=>({id:shot.id,title:shot.title,dialogue:shot.dialogue,continuityNotes:shot.continuityNotes})).sort((a,b)=>a.id.localeCompare(b.id)),
    outputs:project.renderOutputs.filter(output=>outputIds.has(output.id)).map(output=>({id:output.id,jobId:output.jobId,shotId:output.shotId,path:output.path,filename:output.filename,mediaType:output.mediaType,technicalQc:output.technicalQc})).sort((a,b)=>a.id.localeCompare(b.id)),
    assets:project.assets.map(asset=>({id:asset.id,kind:asset.kind,name:asset.name,projectPath:asset.projectPath,notes:asset.notes,tags:asset.tags})).sort((a,b)=>a.id.localeCompare(b.id))
  });
}
