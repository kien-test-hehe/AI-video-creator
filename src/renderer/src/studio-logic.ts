import { MODEL_DEFAULTS } from '../../shared/defaults';
import type { FilmProject, PreflightReport, Shot, WorkflowProfile } from '../../shared/types';
import { compareTimelineClips } from '../../shared/timeline-policy';


export type StudioPreflightState='unchecked'|'stale'|'ready'|'blocked';
export function studioPreflightState(report:PreflightReport|undefined,reportRevision:string|undefined,projectUpdatedAt:string|undefined):StudioPreflightState{
  if(!report)return'unchecked';
  if(!reportRevision||!projectUpdatedAt||reportRevision!==projectUpdatedAt)return'stale';
  return report.ready?'ready':'blocked';
}
export interface WorkflowRouteResult { ok:boolean;message:string; }

export function routeShotToWorkflow(shot:Shot,profile:WorkflowProfile):WorkflowRouteResult{
  if(!profile.enabled)return{ok:false,message:`${profile.name} is disabled.`};
  if(!profile.workflowPath)return{ok:false,message:`${profile.name} has no workflow/settings file.`};
  if(profile.validation?.structuralStatus!=='valid')return{ok:false,message:`${profile.name} is ${profile.validation?.structuralStatus||'unvalidated'}. Validate it before routing production shots.`};
  if((profile.purpose??'video')!=='video')return{ok:false,message:`${profile.name} is not a video workflow.`};
  const defaults=MODEL_DEFAULTS[profile.modelFamily];
  shot.generation={
    ...shot.generation,
    ...defaults,
    modelFamily:profile.modelFamily,
    mode:profile.mode,
    workflowProfileId:profile.id,
    seed:shot.generation.seed,
    negativePrompt:shot.generation.negativePrompt,
    quality:shot.generation.quality
  };
  if(shot.status==='draft')shot.status='ready';
  return{ok:true,message:`Routed to ${profile.name}.`};
}


export function resolveStudioWorkflow(profiles:WorkflowProfile[],shot:Shot):WorkflowProfile|undefined{
  if(shot.generation.workflowProfileId)return profiles.find(profile=>profile.id===shot.generation.workflowProfileId);
  const candidates=profiles.filter(profile=>profile.enabled&&Boolean(profile.workflowPath)&&(profile.purpose??'video')==='video'&&profile.modelFamily===shot.generation.modelFamily&&profile.mode===shot.generation.mode);
  return candidates.find(profile=>profile.validation?.structuralStatus==='valid')||candidates[0];
}

export function studioWorkflowIssue(profile:WorkflowProfile|undefined,shot:Shot):string|undefined{
  if(!profile)return'No matching video workflow.';
  if(!profile.enabled)return`${profile.name} is disabled.`;
  if(!profile.workflowPath)return`${profile.name} has no workflow/settings file.`;
  if((profile.purpose??'video')!=='video')return`${profile.name} is not a video workflow.`;
  if(profile.modelFamily!==shot.generation.modelFamily)return`${profile.name} targets ${profile.modelFamily}, but this shot is ${shot.generation.modelFamily}.`;
  if(profile.mode!==shot.generation.mode)return`${profile.name} is ${profile.mode}, but this shot is ${shot.generation.mode}.`;
  if(profile.validation?.structuralStatus!=='valid')return`${profile.name} is ${profile.validation?.structuralStatus||'unvalidated'}.`;
  return undefined;
}

export function isStudioWorkflowReady(profile:WorkflowProfile|undefined,shot:Shot):boolean{return !studioWorkflowIssue(profile,shot);}

export function reorderTimeline(project:FilmProject,sourceId:string,targetId:string):boolean{
  if(sourceId===targetId)return false;
  const source=project.timeline.find(clip=>clip.id===sourceId),target=project.timeline.find(clip=>clip.id===targetId);
  if(!source||!target||source.track!==target.track)return false;
  const ordered=project.timeline.filter(clip=>clip.track===source.track).sort(compareTimelineClips);
  const from=ordered.findIndex(clip=>clip.id===sourceId),to=ordered.findIndex(clip=>clip.id===targetId);
  if(from<0||to<0)return false;
  const[moved]=ordered.splice(from,1);ordered.splice(to,0,moved);ordered.forEach((clip,index)=>clip.order=index);
  return true;
}

export function timelineInsertIssue(project:Pick<FilmProject,'timeline'>):string|undefined{return project.timeline.length>=100_000?'Timeline already has the maximum of 100000 clips. Remove/archive clips before adding another take.':undefined;}

export function insertTimelineOutput(project:FilmProject,outputId:string,beforeClipId?:string):boolean{
  if(timelineInsertIssue(project))return false;
  const output=project.renderOutputs.find(item=>item.id===outputId&&item.mediaType==='video');if(!output)return false;
  if(!project.shots.some(shot=>shot.id===output.shotId))return false;
  const targetClip=beforeClipId?project.timeline.find(clip=>clip.id===beforeClipId):undefined,track=targetClip?.track??0;
  const ordered=project.timeline.filter(clip=>clip.track===track).sort(compareTimelineClips);
  const target=targetClip?ordered.findIndex(clip=>clip.id===targetClip.id):ordered.length,index=target<0?ordered.length:target;
  const inserted={id:crypto.randomUUID(),shotId:output.shotId,renderOutputId:output.id,track,order:index,trimInSec:0,volume:1};
  ordered.splice(index,0,inserted);ordered.forEach((clip,order)=>clip.order=order);project.timeline.push(inserted);return true;
}

export function alternateShotTitle(title:string):string{
  const suffix=' · alt',max=2000;
  return `${title.slice(0,Math.max(0,max-suffix.length))}${suffix}`;
}

export function appendProjectText(current:string,addition:string,max:number,label:string):string{
  const merged=[current,addition].filter(Boolean).join('\n');
  if(merged.length>max)throw new Error(`${label} would exceed the ${max}-character project safety limit. Shorten the existing text or suggestion before appending.`);
  return merged;
}
