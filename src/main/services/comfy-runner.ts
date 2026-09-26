import type { ComfyClient } from './comfy-client';
import { historyWasInterrupted, promptQueueState } from './comfy-client';

export async function waitForComfyCompletion(
  client:ComfyClient,
  promptId:string,
  options:{intervalMs?:number;timeoutMs?:number;cancelled?:()=>boolean;onTick?:(elapsedSec:number)=>void|Promise<void>}={}
):Promise<any>{
  const started=Date.now();const interval=options.intervalMs??1500;const timeout=options.timeoutMs??6*60*60_000;
  while(true){
    if(options.cancelled?.())throw new Error('Job cancelled.');
    if(Date.now()-started>timeout)throw new Error(`ComfyUI job timed out after ${Math.round(timeout/60_000)} minutes.`);
    const history=await client.history(promptId);
    if(history){
      if(history.status?.status_str==='error')throw new Error(`ComfyUI execution failed: ${JSON.stringify(history.status)}`);
      if(history.outputs&&Object.keys(history.outputs).length>0)return history;
      if(history.status?.completed)return history;
    }
    const elapsed=Math.floor((Date.now()-started)/1000);await options.onTick?.(elapsed);await new Promise(resolve=>setTimeout(resolve,interval));
  }
}


export async function waitForComfyPromptRelease(
  client:ComfyClient,
  promptId:string,
  options:{intervalMs?:number;onTick?:(message:string)=>void|Promise<void>}={}
):Promise<void>{
  const interval=options.intervalMs??1500;
  while(true){
    try{
      const history=await client.history(promptId);
      if(history){
        if(historyWasInterrupted(history)||history.status?.status_str==='error'||history.status?.completed||(history.outputs&&Object.keys(history.outputs).length>0))return;
      }
      const state=promptQueueState(await client.queue(),promptId);
      if(state==='absent')return;
      await options.onTick?.(`ComfyUI prompt is still ${state}; waiting for backend release.`);
    }catch(error){
      await options.onTick?.(`ComfyUI state is temporarily unavailable; retaining the GPU lock · ${error instanceof Error?error.message:String(error)}`);
    }
    await new Promise(resolve=>setTimeout(resolve,interval));
  }
}
