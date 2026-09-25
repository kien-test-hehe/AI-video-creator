import { readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertLocalUrl } from './local-url';

export interface ComfyFileRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyPromptResult {
  prompt_id: string;
  number?: number;
  node_errors?: Record<string, unknown>;
}

export class ComfyClient {
  readonly clientId = randomUUID();

  constructor(public baseUrl: string, public localOnly = true) {}

  private url(path: string): URL {
    const base = assertLocalUrl(this.baseUrl, this.localOnly);
    return new URL(path, `${base.origin}/`);
  }

  private request(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(this.url(path), { ...init, signal: timeout });
  }

  async ping(): Promise<{ reachable: boolean; url: string; systemStats?: unknown; error?: string }> {
    try {
      const res = await this.request('/system_stats', {}, 5_000);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return { reachable: true, url: this.baseUrl, systemStats: await res.json() };
    } catch (error) {
      return { reachable: false, url: this.baseUrl, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async objectInfo(): Promise<Record<string, any>> {
    const res = await this.request('/object_info', {}, 30_000);
    if (!res.ok) throw new Error(`ComfyUI /object_info failed: ${res.status}`);
    return res.json();
  }

  async uploadImage(path: string, overwrite = true): Promise<ComfyFileRef> {
    const bytes = await readFile(path);
    const form = new FormData();
    form.append('image', new Blob([bytes]), basename(path));
    form.append('type', 'input');
    form.append('overwrite', overwrite ? 'true' : 'false');
    const res = await this.request('/upload/image', { method: 'POST', body: form }, 120_000);
    if (!res.ok) throw new Error(`ComfyUI image upload failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ComfyFileRef>;
  }

  async queuePrompt(prompt: Record<string, unknown>, extraData: Record<string, unknown> = {}): Promise<ComfyPromptResult> {
    const res = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: this.clientId, extra_data: extraData })
    }, 30_000);
    const raw=await res.text();let payload:any;
    try{payload=raw?JSON.parse(raw):{};}catch{throw new Error(`ComfyUI /prompt returned ${res.status} with non-JSON body: ${raw.slice(0,1000)}`);}
    if (!res.ok || payload.error) {
      throw new Error(`ComfyUI rejected prompt (${res.status}): ${JSON.stringify(payload).slice(0,4000)}`);
    }
    return payload as ComfyPromptResult;
  }

  async history(promptId: string): Promise<any | null> {
    const res = await this.request(`/history/${encodeURIComponent(promptId)}`, {}, 15_000);
    if (!res.ok) throw new Error(`ComfyUI history failed: ${res.status}`);
    const history = await res.json() as Record<string, any>;
    return history[promptId] ?? null;
  }

  async queue(): Promise<any> {
    const res = await this.request('/queue', {}, 15_000);
    if (!res.ok) throw new Error(`ComfyUI queue failed: ${res.status}`);
    return res.json();
  }

  async deleteQueued(promptId:string):Promise<void>{
    const res=await this.request('/queue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delete:[promptId]})},10_000);
    if(!res.ok)throw new Error(`ComfyUI queue delete failed: ${res.status}`);
  }

  async interrupt(promptId?:string): Promise<void> {
    const res = await this.request('/interrupt', {
      method: 'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(promptId?{prompt_id:promptId}:{})
    }, 10_000);
    if (!res.ok) throw new Error(`ComfyUI interrupt failed: ${res.status}`);
  }

  async cancelPrompt(promptId:string):Promise<void>{
    const modern=await this.request(`/api/jobs/${encodeURIComponent(promptId)}/cancel`,{method:'POST'},10_000).catch(()=>undefined);
    if(modern&&modern.status!==404&&modern.status!==405){
      if(!modern.ok)throw new Error(`ComfyUI targeted cancel failed: ${modern.status} ${(await modern.text()).slice(0,1000)}`);
      const payload=await modern.json().catch(()=>({})) as {cancelled?:boolean};
      if(payload.cancelled===true)return;
      if(await this.history(promptId))throw new Error(`ComfyUI prompt ${promptId} finished before cancellation could be applied.`);
      throw new Error(`ComfyUI did not confirm targeted cancellation for ${promptId}.`);
    }

    const before=await this.queue();
    const state=promptQueueState(before,promptId);
    if(state==='pending')await this.deleteQueued(promptId);
    else if(state==='running')await this.interrupt(promptId);
    else{
      const history=await this.history(promptId);
      if(historyWasInterrupted(history))return;
      if(history)throw new Error(`ComfyUI prompt ${promptId} already finished.`);
      throw new Error(`ComfyUI prompt ${promptId} is no longer present in queue or history.`);
    }

    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const now=promptQueueState(await this.queue(),promptId);
      if(now==='absent'){
        const history=await this.history(promptId);
        if(!history)return;
        if(historyWasInterrupted(history))return;
        throw new Error(`ComfyUI prompt ${promptId} reached terminal history before cancellation was confirmed.`);
      }
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw new Error(`ComfyUI did not confirm removal of prompt ${promptId} after cancellation.`);
  }

  async download(ref: ComfyFileRef): Promise<Uint8Array> {
    const res=await this.outputResponse(ref);
    return new Uint8Array(await res.arrayBuffer());
  }

  async downloadToFile(ref:ComfyFileRef,destination:string):Promise<void>{
    const res=await this.outputResponse(ref,30*60_000);
    if(!res.body)throw new Error('ComfyUI output download returned no response body.');
    try{
      await pipeline(Readable.fromWeb(res.body as any),createWriteStream(destination,{flags:'w'}));
    }catch(error){
      await rm(destination,{force:true}).catch(()=>undefined);
      throw error;
    }
  }

  private async outputResponse(ref:ComfyFileRef,timeoutMs=180_000):Promise<Response>{
    const url=this.url('/view');
    url.searchParams.set('filename',ref.filename);
    if(ref.subfolder)url.searchParams.set('subfolder',ref.subfolder);
    if(ref.type)url.searchParams.set('type',ref.type);
    const res=await fetch(url,{signal:AbortSignal.timeout(timeoutMs)});
    if(!res.ok)throw new Error(`ComfyUI output download failed: ${res.status} ${(await res.text()).slice(0,1000)}`);
    return res;
  }
}

export function promptQueueState(queue:any,promptId:string):'running'|'pending'|'absent'{
  const running=Array.isArray(queue?.queue_running)?queue.queue_running:[];
  const pending=Array.isArray(queue?.queue_pending)?queue.queue_pending:[];
  if(running.some((item:any)=>Array.isArray(item)&&item[1]===promptId))return'running';
  if(pending.some((item:any)=>Array.isArray(item)&&item[1]===promptId))return'pending';
  return'absent';
}


export function historyWasInterrupted(history:unknown):boolean{
  const messages=(history as any)?.status?.messages;
  return Array.isArray(messages)&&messages.some((message:any)=>Array.isArray(message)&&message[0]==='execution_interrupted');
}
