import { MODEL_DEFAULTS } from '../../shared/defaults';
import type { FilmProject, Shot, WorkflowProfile } from '../../shared/types';

export interface WorkflowRouteResult { ok:boolean;message:string; }

export function routeShotToWorkflow(shot:Shot,profile:WorkflowProfile):WorkflowRouteResult{
  if(!profile.enabled)return{ok:false,message:`${profile.name} is disabled.`};
  if(!profile.workflowPath)return{ok:false,message:`${profile.name} has no workflow/settings file.`};
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

export function reorderTimeline(project:FilmProject,sourceId:string,targetId:string):boolean{
  if(sourceId===targetId)return false;
  const ordered=[...project.timeline].sort((a,b)=>a.order-b.order);
  const from=ordered.findIndex(clip=>clip.id===sourceId),to=ordered.findIndex(clip=>clip.id===targetId);
  if(from<0||to<0)return false;
  const[moved]=ordered.splice(from,1);ordered.splice(to,0,moved);ordered.forEach((clip,index)=>clip.order=index);project.timeline=ordered;
  return true;
}
