import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AppMachineSettings } from '../../shared/types';
import { assertLocalUrl, fetchLocalUrl } from './local-url';
import { readResponseJsonLimited, readResponseTextLimited } from './http-response';

interface ChatResponse{choices?:Array<{message?:{content?:string}}>} 

export class LocalVisionUnavailableError extends Error{}
export class LocalVisionJsonError extends Error{}

function mimeFor(path:string):string{
  const ext=extname(path).toLowerCase();
  if(ext==='.png')return'image/png';
  if(ext==='.webp')return'image/webp';
  return'image/jpeg';
}

export function parseLocalVisionJsonObject(text:string):any{
  const cleaned=text.trim().replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'');
  const first=cleaned.indexOf('{'),last=cleaned.lastIndexOf('}');
  if(first<0||last<first)throw new LocalVisionJsonError('Local visual evaluator did not return a JSON object.');
  try{return JSON.parse(cleaned.slice(first,last+1));}
  catch(error){throw new LocalVisionJsonError(`Local visual evaluator returned malformed JSON: ${error instanceof Error?error.message:String(error)}`);}
}

export async function analyzeImagesWithLocalVision(machine:AppMachineSettings,instruction:string,imagePaths:string[]):Promise<any>{
  const cfg=machine.director;
  if(!cfg.model.trim())throw new LocalVisionUnavailableError('No local Director/VLM model is configured.');
  if(!imagePaths.length)throw new Error('Visual analysis requires at least one image.');
  if(imagePaths.length>8)throw new Error('Visual analysis supports at most 8 images per request.');
  const imageContent:any[]=[];
  for(const path of imagePaths){
    const info=await stat(path);
    if(!info.isFile())throw new Error(`Visual analysis input is not a file: ${path}`);
    if(info.size>8*1024*1024)throw new Error(`Visual analysis image exceeds the 8 MB safety limit: ${path}`);
    const data=(await readFile(path)).toString('base64');
    imageContent.push({type:'image_url',image_url:{url:`data:${mimeFor(path)};base64,${data}`}});
  }
  const base=assertLocalUrl(cfg.baseUrl,true);
  const url=new URL('chat/completions',base.href.endsWith('/')?base.href:`${base.href}/`);

  const request=async(repair:boolean):Promise<string>=>{
    const content:any[]=[
      {type:'text',text:repair
        ?`${instruction}\nYour previous response was not parseable JSON. Inspect the supplied images again and return exactly one syntactically valid JSON object with no markdown, comments or trailing text.`
        :instruction},
      ...imageContent
    ];
    let res:Response;
    try{
      res=await fetchLocalUrl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        model:cfg.model,temperature:Math.min(cfg.temperature,.2),
        messages:[{role:'system',content:'You are CineForge local visual QC. Inspect only the supplied images. Return strict JSON only. Never claim certainty when the images do not support it.'},{role:'user',content}]
      }),signal:AbortSignal.timeout(180_000)});
    }catch(error){throw new LocalVisionUnavailableError(`Local visual evaluator is unavailable: ${error instanceof Error?error.message:String(error)}`);}
    if(!res.ok){
      let detail='';
      try{detail=(await readResponseTextLimited(res,'Local visual evaluator error',1024*1024)).slice(0,1200);}
      catch(error){detail=`response body unavailable: ${error instanceof Error?error.message:String(error)}`;}
      const hint=res.status===400||res.status===404||res.status===422?'Configured local model may not support image input':'Local visual evaluator request failed';
      throw new LocalVisionUnavailableError(`${hint} (HTTP ${res.status}): ${detail}`);
    }
    let payload:ChatResponse;
    try{payload=await readResponseJsonLimited<ChatResponse>(res,'Local visual evaluator response',8*1024*1024);}
    catch(error){throw new LocalVisionUnavailableError(`Local visual evaluator returned an unreadable protocol response: ${error instanceof Error?error.message:String(error)}`);}
    const text=payload.choices?.[0]?.message?.content;
    if(!text)throw new LocalVisionUnavailableError('Local visual evaluator returned no message content.');
    return text;
  };

  const first=await request(false);
  try{return parseLocalVisionJsonObject(first);}
  catch(error){
    if(!(error instanceof LocalVisionJsonError))throw error;
    const repaired=await request(true);
    try{return parseLocalVisionJsonObject(repaired);}
    catch(repairError){
      if(repairError instanceof LocalVisionJsonError)throw new LocalVisionUnavailableError(`Local visual evaluator still returned malformed JSON after one bounded repair attempt: ${repairError.message}`);
      throw repairError;
    }
  }
}

export async function releaseLocalVisionModel(machine:AppMachineSettings):Promise<void>{
  const cfg=machine.director;if(!cfg.model.trim())return;
  let base:URL;
  try{base=assertLocalUrl(cfg.baseUrl,true);}catch{return;}
  const hostname=base.hostname.toLowerCase(),port=base.port||'80';
  if(!['127.0.0.1','localhost','::1','[::1]'].includes(hostname)||port!=='11434')return;
  try{
    const url=new URL('/api/generate',base.origin);
    await fetchLocalUrl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,keep_alive:0}),signal:AbortSignal.timeout(15_000)});
  }catch(error){console.warn('Could not unload local Ollama QC model:',error);}
}
