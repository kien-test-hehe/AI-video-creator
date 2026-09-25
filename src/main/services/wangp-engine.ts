import { readFile } from 'node:fs/promises';
import type { WorkflowBinding,WorkflowBindingKey,WorkflowProfile } from '../../shared/types';
import type { WorkflowValues } from './workflow-engine';

const KEY_HINTS:Record<WorkflowBindingKey,string[]>={
  prompt:['prompt','text_prompt','positive_prompt'],negativePrompt:['negative_prompt','negative'],width:['width'],height:['height'],resolution:['resolution','size'],frames:['frames','num_frames','frame_count','length','video_length'],fps:['fps','frame_rate','force_fps'],steps:['steps','num_steps'],cfg:['cfg','guidance','guidance_scale'],seed:['seed'],
  startImage:['start_image','image_start','input_image'],endImage:['end_image','image_end','last_image'],locationImage:['location_image','scene_image'],
  characterImage1:['character_image_1','character1'],characterImage2:['character_image_2','character2'],characterImage3:['character_image_3','character3'],characterImage4:['character_image_4','character4'],
  propImage1:['prop_image_1','prop1'],propImage2:['prop_image_2','prop2'],referenceImage1:['reference_image_1','reference1','reference_image','image_reference'],referenceImage2:['reference_image_2','reference2'],referenceImage3:['reference_image_3','reference3'],referenceImage4:['reference_image_4','reference4'],
  inputAudio:['input_audio','audio_path'],inputVideo:['input_video','video_path'],filenamePrefix:['filename_prefix','output_prefix']
};

function transformValue(value:unknown,transform:WorkflowBinding['transform']):unknown{switch(transform){case'integer':return Math.round(Number(value));case'float':return Number(value);case'boolean':return Boolean(value);case'string':return value==null?'':String(value);default:return value;}}
function splitPath(path:string):Array<string|number>{const result:Array<string|number>=[];for(const part of path.split('.')){const re=/([^\[\]]+)|\[(\d+)\]/g;let match:RegExpExecArray|null;while((match=re.exec(part)))result.push(match[2]!=null?Number(match[2]):match[1]);}return result;}
function hasPath(root:any,path:string):boolean{let cur=root;for(const key of splitPath(path)){if(cur==null||!(key in Object(cur)))return false;cur=cur[key as any];}return true;}
function setPath(root:any,path:string,value:unknown):void{const parts=splitPath(path);if(!parts.length)throw new Error(`Invalid WanGP JSON path: ${path}`);let cur=root;for(let i=0;i<parts.length-1;i++){const key=parts[i];if(cur[key as any]==null)cur[key as any]=typeof parts[i+1]==='number'?[]:{};cur=cur[key as any];}cur[parts.at(-1) as any]=value;}

export function analyzeWanGpBindings(settings:any):{bindings:WorkflowBinding[];warnings:string[]}{
  const leaves:Array<{path:string;key:string;value:unknown}>=[];
  const walk=(value:any,path='')=>{if(Array.isArray(value))return value.forEach((v,i)=>walk(v,`${path}[${i}]`));if(value&&typeof value==='object')return Object.entries(value).forEach(([k,v])=>walk(v,path?`${path}.${k}`:k));const key=path.split('.').at(-1)?.replace(/\[\d+\]$/,'')||path;leaves.push({path,key:key.toLowerCase(),value});};walk(settings);
  const bindings:WorkflowBinding[]=[],warnings:string[]=[];
  for(const[bindingKey,hints]of Object.entries(KEY_HINTS) as[WorkflowBindingKey,string[]][]){
    const candidates=leaves.filter(x=>hints.some(h=>x.key===h));
    if(candidates.length===0)continue;
    if(candidates.length>1){warnings.push(`${bindingKey}: ambiguous WanGP setting; candidates: ${candidates.map(c=>c.path).join(', ')}. Add the JSON path manually.`);continue;}
    const hit=candidates[0];bindings.push({key:bindingKey,jsonPath:hit.path,transform:typeof hit.value==='number'?(Number.isInteger(hit.value)?'integer':'float'):'identity',required:['prompt','seed'].includes(bindingKey)});
  }
  return{bindings,warnings};
}

export function suggestWanGpBindings(settings:any):WorkflowBinding[]{return analyzeWanGpBindings(settings).bindings;}

export async function inspectWanGpSettings(path:string):Promise<{format:'wangp-settings';suggestedBindings:WorkflowBinding[];warnings:string[]}>{
  const raw=JSON.parse(await readFile(path,'utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('WanGP settings must be a JSON object exported from WanGP.');
  const analyzed=analyzeWanGpBindings(raw);return{format:'wangp-settings',suggestedBindings:analyzed.bindings,warnings:analyzed.warnings};
}

export async function validateWanGpProfile(profile:WorkflowProfile):Promise<string[]>{
  const raw=JSON.parse(await readFile(profile.workflowPath,'utf8'));const issues:string[]=[];
  for(const binding of profile.bindings){
    if(!binding.jsonPath){issues.push(`${binding.key}: missing jsonPath for WanGP runtime.`);continue;}
    if(!hasPath(raw,binding.jsonPath))issues.push(`${binding.key}: JSON path “${binding.jsonPath}” does not exist in exported settings.`);
  }
  if(!profile.bindings.some(b=>b.key==='prompt'))issues.push('prompt: no prompt binding configured.');
  if(!profile.bindings.some(b=>b.key==='seed'))issues.push('seed: no seed binding configured.');
  return issues;
}

export async function compileWanGpProfile(profile:WorkflowProfile,values:WorkflowValues):Promise<Record<string,unknown>>{
  const raw=JSON.parse(await readFile(profile.workflowPath,'utf8')),output=structuredClone(raw);
  for(const binding of profile.bindings){
    const value=values[binding.key];if(value===undefined||value===null||value===''){if(binding.required)throw new Error(`Required WanGP binding is missing: ${binding.key}`);continue;}
    if(!binding.jsonPath){if(binding.required)throw new Error(`Required WanGP binding has no jsonPath: ${binding.key}`);continue;}
    if(!hasPath(output,binding.jsonPath))throw new Error(`WanGP binding path no longer exists: ${binding.key} → ${binding.jsonPath}`);
    setPath(output,binding.jsonPath,transformValue(value,binding.transform));
  }
  return output;
}
