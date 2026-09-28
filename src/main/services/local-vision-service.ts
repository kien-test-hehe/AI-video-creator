import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AppMachineSettings } from '../../shared/types';
import { assertLocalUrl, fetchLocalUrl } from './local-url';
import { readResponseJsonLimited, readResponseTextLimited } from './http-response';

interface ChatResponse{choices?:Array<{message?:{content?:string}}>} 

export class LocalVisionUnavailableError extends Error{}

function mimeFor(path:string):string{
  const ext=extname(path).toLowerCase();
  if(ext==='.png')return'image/png';
  if(ext==='.webp')return'image/webp';
  return'image/jpeg';
}

function parseJsonObject(text:string):any{
  const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const first=cleaned.indexOf('{'),last=cleaned.lastIndexOf('}');
  if(first<0||last<first)throw new Error('Local visual evaluator did not return JSON.');
  return JSON.parse(cleaned.slice(first,last+1));
}

export async function analyzeImagesWithLocalVision(machine:AppMachineSettings,instruction:string,imagePaths:string[]):Promise<any>{
  const cfg=machine.director;
  if(!cfg.model.trim())throw new LocalVisionUnavailableError('No local Director/VLM model is configured.');
  if(!imagePaths.length)throw new Error('Visual analysis requires at least one image.');
  if(imagePaths.length>8)throw new Error('Visual analysis supports at most 8 images per request.');
  const content:any[]=[{type:'text',text:instruction}];
  for(const path of imagePaths){
    const info=await stat(path);
    if(!info.isFile())throw new Error(`Visual analysis input is not a file: ${path}`);
    if(info.size>8*1024*1024)throw new Error(`Visual analysis image exceeds the 8 MB safety limit: ${path}`);
    const data=(await readFile(path)).toString('base64');
    content.push({type:'image_url',image_url:{url:`data:${mimeFor(path)};base64,${data}`}});
  }
  const base=assertLocalUrl(cfg.baseUrl,true);
  const url=new URL('chat/completions',base.href.endsWith('/')?base.href:`${base.href}/`);
  let res:Response;
  try{
    res=await fetchLocalUrl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,temperature:Math.min(cfg.temperature,.2),messages:[{role:'system',content:'You are CineForge local visual QC. Inspect only the supplied images. Return strict JSON only. Never claim certainty when the images do not support it.'},{role:'user',content}]}),signal:AbortSignal.timeout(180_000)});
  }catch(error){throw new LocalVisionUnavailableError(`Local visual evaluator is unavailable: ${error instanceof Error?error.message:String(error)}`);}
  if(!res.ok){
    const detail=(await readResponseTextLimited(res,'Local visual evaluator error',1024*1024)).slice(0,1200);
    if(res.status===400||res.status===404||res.status===422)throw new LocalVisionUnavailableError(`Configured local model may not support image input (HTTP ${res.status}): ${detail}`);
    throw new Error(`Local visual evaluator HTTP ${res.status}: ${detail}`);
  }
  const payload=await readResponseJsonLimited<ChatResponse>(res,'Local visual evaluator response',8*1024*1024);
  const text=payload.choices?.[0]?.message?.content;
  if(!text)throw new Error('Local visual evaluator returned no message content.');
  return parseJsonObject(text);
}
