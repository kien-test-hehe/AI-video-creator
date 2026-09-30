import type { FilmProject, RenderOutput } from './types';
import { currentProductionInputKeyForOutput, renderOutputProductionInputKey } from './production-state';

export type TakeUseContext='timeline'|'preferred';

export function takeUseConfirmationMessage(output:RenderOutput,context:TakeUseContext):string|undefined{
  const action=context==='preferred'?'Mark it preferred anyway?':'Use it in the canonical timeline anyway?';
  if(output.technicalQc?.passed===false)return `This take failed technical QC:\n\n${output.technicalQc.issues.join('\n')||'Unknown QC failure'}\n\n${action}`;
  if(!output.technicalQc)return `This take has no technical QC record. ${action}`;
  return undefined;
}

export function takeNeedsConfirmation(output:RenderOutput):boolean{
  return output.technicalQc?.passed!==true;
}

export function latestPassingVideoTake(outputs:RenderOutput[]):RenderOutput|undefined{
  return [...outputs].filter(output=>output.mediaType==='video'&&output.technicalQc?.passed===true).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
}


export function latestCurrentPassingVideoTake(project:FilmProject,shotId:string):RenderOutput|undefined{
  const shot=project.shots.find(item=>item.id===shotId);if(!shot)return undefined;
  return [...project.renderOutputs]
    .filter(output=>output.shotId===shotId&&output.mediaType==='video'&&output.technicalQc?.passed===true)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))
    .find(output=>{
      const recorded=renderOutputProductionInputKey(project,output),current=currentProductionInputKeyForOutput(project,shot,output);
      return Boolean(recorded&&current&&recorded===current);
    });
}
