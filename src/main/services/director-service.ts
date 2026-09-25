import type { AppMachineSettings, ContinuityReview, DirectorShotDraft, FilmProject, Scene, Shot } from '../../shared/types';
import { assertLocalUrl } from './local-url';

interface ChatResponse{choices?:Array<{message?:{content?:string}}>}
function parseJsonObject(text:string):any{const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const first=cleaned.indexOf('{'),last=cleaned.lastIndexOf('}');if(first<0||last<first)throw new Error('Local director did not return JSON.');return JSON.parse(cleaned.slice(first,last+1));}

export async function planSceneWithLocalDirector(project:FilmProject,scene:Scene,machine:AppMachineSettings):Promise<DirectorShotDraft[]>{
  const cfg=machine.director;if(!cfg.model.trim())throw new Error('Set a local Director model in Machine Settings first.');
  const base=assertLocalUrl(cfg.baseUrl,true);const url=new URL('chat/completions',base.href.endsWith('/')?base.href:`${base.href}/`);
  const relevantAssets=project.assets.filter(a=>['character','location','prop','wardrobe','reference'].includes(a.kind));
  const assetContext=relevantAssets.map(a=>`${a.kind} | id=${a.id} | name=${a.name}${a.notes?` | continuity=${a.notes}`:''}`).join('\n');
  const system='You are a film director and storyboard planner for a local generative-video pipeline. Return strict JSON only. Plan shots that can be generated independently while preserving continuity. Avoid redundant coverage. Each visual prompt must describe subject identity, environment, lighting, composition and motion. Camera language should be practical and concise. You may ONLY reference asset ids supplied by the user.';
  const user=`FILM: ${project.story.title}\nLOGLINE: ${project.story.logline}\nSTORY BIBLE: ${project.story.notes}\n\nSCENE ${scene.index}: ${scene.heading}\n${scene.body}\n\nKNOWN ASSETS:\n${assetContext||'(none)'}\n\nReturn {"shots":[{"title":"...","prompt":"...","camera":"...","action":"...","dialogue":"...","continuityNotes":"...","quality":"preview|balanced|hero","preferredModel":"ltx-2.5-fast|ltx-2.3|hunyuan-video-1.5|wan-2.2-5b|framepack","characterAssetIds":["exact-known-id"],"locationAssetId":"exact-known-id-or-empty","referenceAssetIds":["exact-known-id"],"propAssetIds":["exact-known-id"]}]}. Use 2-8 shots depending on scene complexity.`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,temperature:cfg.temperature,messages:[{role:'system',content:system},{role:'user',content:user}]}),signal:AbortSignal.timeout(180_000)});
  if(!res.ok)throw new Error(`Local Director HTTP ${res.status}: ${(await res.text()).slice(0,1000)}`);
  const payload=await res.json() as ChatResponse;const content=payload.choices?.[0]?.message?.content;if(!content)throw new Error('Local Director returned no message content.');
  const parsed=parseJsonObject(content);if(!Array.isArray(parsed.shots))throw new Error('Local Director JSON is missing shots[].');
  const idsFor=(...kinds:string[])=>new Set(relevantAssets.filter(asset=>kinds.includes(asset.kind)).map(asset=>asset.id));
  const characterIds=idsFor('character'),locationIds=idsFor('location'),referenceIds=idsFor('reference'),propIds=idsFor('prop','wardrobe');
  const validModels=new Set(['ltx-2.5-fast','ltx-2.3','hunyuan-video-1.5','wan-2.2-5b','framepack']);
  return parsed.shots.slice(0,12).map((s:any,i:number)=>{
    const chars=Array.isArray(s.characterAssetIds)?s.characterAssetIds.map(String).filter((id:string)=>characterIds.has(id)).slice(0,4):[];
    const refs=Array.isArray(s.referenceAssetIds)?s.referenceAssetIds.map(String).filter((id:string)=>referenceIds.has(id)).slice(0,4):[];
    const props=Array.isArray(s.propAssetIds)?s.propAssetIds.map(String).filter((id:string)=>propIds.has(id)).slice(0,2):[];
    const location=typeof s.locationAssetId==='string'&&locationIds.has(s.locationAssetId)?s.locationAssetId:undefined;
    return{title:String(s.title||`Shot ${scene.index}.${i+1}`),prompt:String(s.prompt||scene.body),camera:String(s.camera||''),action:String(s.action||''),dialogue:String(s.dialogue||''),continuityNotes:String(s.continuityNotes||''),quality:['preview','balanced','hero'].includes(s.quality)?s.quality:'balanced',preferredModel:validModels.has(s.preferredModel)?s.preferredModel:undefined,characterAssetIds:chars,locationAssetId:location,referenceAssetIds:refs,propAssetIds:props} as DirectorShotDraft;
  });
}

export async function reviewShotWithLocalDirector(project:FilmProject,shot:Shot,machine:AppMachineSettings):Promise<ContinuityReview>{
  const cfg=machine.director;if(!cfg.model.trim())throw new Error('Set a local Director model in Machine Settings first.');
  const base=assertLocalUrl(cfg.baseUrl,true);const url=new URL('chat/completions',base.href.endsWith('/')?base.href:`${base.href}/`);
  const scene=project.scenes.find(s=>s.id===shot.sceneId);const sceneShots=project.shots.filter(s=>s.sceneId===shot.sceneId).sort((a,b)=>a.index-b.index);const prior=sceneShots[sceneShots.findIndex(s=>s.id===shot.id)-1];
  const ids=new Set([...(shot.characterAssetIds||[]),...(shot.referenceAssetIds||[]),...(shot.propAssetIds||[])]);if(shot.locationAssetId)ids.add(shot.locationAssetId);if(shot.startFrameAssetId)ids.add(shot.startFrameAssetId);if(shot.endFrameAssetId)ids.add(shot.endFrameAssetId);
  const assets=[...ids].map(id=>project.assets.find(a=>a.id===id)).filter(Boolean).map(a=>`${a!.kind} ${a!.name}: ${a!.notes||'(no continuity description)'}`).join('\n');
  const system='You are a continuity supervisor for AI-generated film shots. Return strict JSON only. Find concrete continuity risks from the provided text/reference metadata; do not claim that you visually inspected rendered pixels.';
  const user=`SCENE: ${scene?.heading||''}\n${scene?.body||''}\n\nPREVIOUS SHOT:\n${prior?`${prior.title}\n${prior.prompt}\n${prior.action}\nContinuity: ${prior.continuityNotes}`:'(none)'}\n\nCURRENT SHOT:\n${shot.title}\nPrompt: ${shot.prompt}\nCamera: ${shot.camera}\nAction: ${shot.action}\nDialogue/audio: ${shot.dialogue}\nContinuity: ${shot.continuityNotes}\n\nATTACHED ASSET METADATA:\n${assets||'(none)'}\n\nReturn {"issues":["specific issue"],"suggestedContinuityNotes":"concise notes","promptAddendum":"only extra constraints"}. If there is no meaningful issue, return empty fields.`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,temperature:Math.min(cfg.temperature,0.4),messages:[{role:'system',content:system},{role:'user',content:user}]}),signal:AbortSignal.timeout(180_000)});
  if(!res.ok)throw new Error(`Local Director HTTP ${res.status}: ${(await res.text()).slice(0,1000)}`);
  const payload=await res.json() as ChatResponse;const content=payload.choices?.[0]?.message?.content;if(!content)throw new Error('Local Director returned no message content.');
  const parsed=parseJsonObject(content);return{issues:Array.isArray(parsed.issues)?parsed.issues.map(String).slice(0,12):[],suggestedContinuityNotes:String(parsed.suggestedContinuityNotes||''),promptAddendum:String(parsed.promptAddendum||'')};
}
