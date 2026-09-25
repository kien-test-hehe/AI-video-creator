import type { RenderOutput } from './types';

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
