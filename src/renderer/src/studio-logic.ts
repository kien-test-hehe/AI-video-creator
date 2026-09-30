import { MODEL_DEFAULTS } from '../../shared/defaults';
import type { FilmProject, PreflightReport, Shot, WorkflowProfile } from '../../shared/types';
import { compareTimelineClips, timelineTakeApprovalInputKey } from '../../shared/timeline-policy';
import { canonicalTakeReadiness } from '../../shared/production-state';


export type StudioPreflightState='unchecked'|'stale'|'ready'|'blocked';
export function studioPreflightState(report:PreflightReport|undefined,reportRevision:string|undefined,projectUpdatedAt:string|undefined):StudioPreflightState{
  if(!report)return'unchecked';
  if(!reportRevision||!projectUpdatedAt||reportRevision!==projectUpdatedAt)return'stale';
  return report.ready?'ready':'blocked';
}

export type StudioGuideAction='story'|'storyboard'|'settings'|'system'|'preflight'|'human'|'auto'|'timeline'|'finishing'|'monitor';
export interface StudioGuideInput{
  sceneCount:number;
  shotCount:number;
  validVideoWorkflowCount:number;
  readinessKnown:boolean;
  readinessReady:boolean;
  preflightState:StudioPreflightState;
  openHumanTasks:number;
  automationRunning:boolean;
  canonicalCount:number;
  timelineCount:number;
}
export interface StudioGuideStep{title:string;detail:string;actionLabel:string;action:StudioGuideAction;tone:'normal'|'warn'|'good';}
export function studioNextStep(input:StudioGuideInput):StudioGuideStep{
  if(input.sceneCount===0)return{title:'Start with the story',detail:'Paste or write the screenplay, then parse it into scenes.',actionLabel:'Open Story',action:'story',tone:'normal'};
  if(input.shotCount===0)return{title:'Turn scenes into shots',detail:'Create the shot plan before choosing generation routes.',actionLabel:'Open Storyboard',action:'storyboard',tone:'normal'};
  if(input.validVideoWorkflowCount===0)return{title:'Prepare one local video workflow',detail:'Provision or validate at least one WanGP/Comfy video route that matches your shots.',actionLabel:'Open Workflows',action:'settings',tone:'warn'};
  if(!input.readinessKnown)return{title:'Check this workstation',detail:'Verify GPU, local runtime, FFmpeg and model readiness before rendering.',actionLabel:'Open System',action:'system',tone:'normal'};
  if(!input.readinessReady)return{title:'Fix workstation blockers',detail:'System readiness has at least one blocking item. Resolve it before AUTO RUN.',actionLabel:'Open System',action:'system',tone:'warn'};
  if(input.preflightState==='unchecked'||input.preflightState==='stale')return{title:'Run project preflight',detail:'Check the current project state and local routes before spending GPU time.',actionLabel:'Run Preflight',action:'preflight',tone:'normal'};
  if(input.preflightState==='blocked')return{title:'Fix preflight blockers',detail:'The current project cannot render safely yet. Open System for the exact blocking checks.',actionLabel:'Open System',action:'system',tone:'warn'};
  if(input.openHumanTasks>0)return{title:'Review human decisions',detail:`${input.openHumanTasks} task${input.openHumanTasks===1?'':'s'} need a human decision before production can continue.`,actionLabel:'Show Human Tasks',action:'human',tone:'warn'};
  if(input.automationRunning)return{title:'AUTO RUN is working',detail:'Production owns the local GPU. Monitor the current shot, retries and QC blockers here.',actionLabel:'Monitor AUTO RUN',action:'monitor',tone:'good'};
  if(input.canonicalCount<input.shotCount)return{title:'Ready for autonomous production',detail:`${input.canonicalCount}/${input.shotCount} shots are canonical. CineForge can render, QC, propagate continuity and build the cut.`,actionLabel:'Start AUTO RUN',action:'auto',tone:'good'};
  if(input.timelineCount===0)return{title:'Build the canonical cut',detail:'All shots are canonical, but the timeline is still empty.',actionLabel:'Open Timeline',action:'timeline',tone:'normal'};
  return{title:'Finish the film',detail:'The canonical cut is ready for local master export or CapCut finishing.',actionLabel:'Open Finishing',action:'finishing',tone:'good'};
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

export function timelineTakeApprovalIssue(project:FilmProject,outputId:string):string|undefined{
  const output=project.renderOutputs.find(item=>item.id===outputId&&item.mediaType==='video');
  if(!output)return'Render output is missing or is not video.';
  const shot=project.shots.find(item=>item.id===output.shotId);
  if(!shot)return'Render output belongs to a missing shot.';
  if(shot.canonicalRenderId!==output.id)return'This take is not the shot\'s canonical take.';
  const readiness=canonicalTakeReadiness(project,shot.id,output.id);
  return readiness.ready?undefined:readiness.blockers.join(' ');
}

export function insertTimelineOutput(project:FilmProject,outputId:string,beforeClipId?:string,humanOverrideReason?:string):boolean{
  if(timelineInsertIssue(project))return false;
  const output=project.renderOutputs.find(item=>item.id===outputId&&item.mediaType==='video');if(!output)return false;
  const shot=project.shots.find(item=>item.id===output.shotId);if(!shot)return false;
  const approvalIssue=timelineTakeApprovalIssue(project,output.id);
  const overrideReason=humanOverrideReason?.trim();
  if(approvalIssue&&!overrideReason)return false;
  const targetClip=beforeClipId?project.timeline.find(clip=>clip.id===beforeClipId):undefined,track=targetClip?.track??0;
  const ordered=project.timeline.filter(clip=>clip.track===track).sort(compareTimelineClips);
  const target=targetClip?ordered.findIndex(clip=>clip.id===targetClip.id):ordered.length,index=target<0?ordered.length:target;
  const inserted={
    id:crypto.randomUUID(),shotId:output.shotId,renderOutputId:output.id,track,order:index,trimInSec:0,volume:1,
    approval:approvalIssue?'human-override' as const:'canonical' as const,
    approvalReason:approvalIssue?overrideReason:undefined,
    approvalInputKey:approvalIssue?timelineTakeApprovalInputKey(project,output.id):undefined
  };
  ordered.splice(index,0,inserted);ordered.forEach((clip,order)=>clip.order=order);project.timeline.push(inserted);return true;
}

export function canonicalReadyOutputForShot(project:FilmProject,shot:Shot){
  if(!shot.canonicalRenderId)return undefined;
  const output=project.renderOutputs.find(item=>item.id===shot.canonicalRenderId&&item.shotId===shot.id&&item.mediaType==='video');
  if(!output)return undefined;
  return canonicalTakeReadiness(project,shot.id,output.id).ready?output:undefined;
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
