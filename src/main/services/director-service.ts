import type { AppMachineSettings, ContinuityReview, DirectorShotDraft, FilmProject, Scene, Shot } from '../../shared/types';
import { assertLocalUrl } from './local-url';

interface ChatResponse{choices?:Array<{message?:{content?:string}}>}
function parseJsonObject(text:string):any{const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const first=cleaned.indexOf('{'),last=cleaned.lastIndexOf('}');if(first<0||last<first)throw new Error('Local director did not return JSON.');return JSON.parse(cleaned.slice(first,last+1));}

export async function planSceneWithLocalDirector(project:FilmProject,scene:Scene,machine:AppMachineSettings):Promise<DirectorShotDraft[]>{
  const cfg=machine.director;if(!cfg.model.trim())throw new Error('Set a local Director model in Machine Settings first.');
  const base=assertLocalUrl(cfg.baseUrl,true);const url=new URL('chat/completions',base.href.endsWith('/')?base.href:`${base.href}/`);
  const sceneText=`${scene.heading} ${scene.body}`.toLowerCase();
  const relevantAssets=project.assets
    .filter(a=>['character','location','prop','wardrobe','reference'].includes(a.kind))
    .map(asset=>({asset,score:assetRelevance(asset.name,asset.tags,sceneText)+(asset.kind==='character'?2:asset.kind==='location'?1:0)}))
    .sort((a,b)=>b.score-a.score||a.asset.name.localeCompare(b.asset.name))
    .slice(0,40)
    .map(item=>item.asset);
  const assetContext=relevantAssets.map(a=>`${a.kind} | id=${a.id} | name=${clipText(a.name,240)}${a.notes?` | continuity=${clipText(a.notes,600)}`:''}${a.tags.length?` | tags=${a.tags.slice(0,12).join(',')}`:''}`).join('\n');
  const availableModels=[...new Set(project.settings.workflowProfiles.filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid').map(profile=>profile.modelFamily))];
  const modelInstruction=availableModels.length?`preferredModel must be one of: ${availableModels.join(' | ')}. Use an empty string if no preference is necessary.`:'Set preferredModel to an empty string because no validated video route is currently available.';
  const system='You are a film director and storyboard planner for a local generative-video pipeline. Return strict JSON only. Plan shots that can be generated independently while preserving continuity. Avoid redundant coverage. Each visual prompt must describe subject identity, environment, lighting, composition and motion. Camera language should be practical and concise. You may ONLY reference asset ids supplied by the user.';
  const user=`FILM: ${clipText(project.story.title,500)}\nLOGLINE: ${clipText(project.story.logline,2000)}\nSTORY BIBLE: ${clipText(project.story.notes,8000)}\n\nSCENE ${scene.index}: ${clipText(scene.heading,1000)}\n${clipText(scene.body,16000)}\n\nKNOWN ASSETS (most scene-relevant, capped):\n${assetContext||'(none)'}\n\n${modelInstruction}\nReturn {"shots":[{"title":"...","prompt":"...","camera":"...","action":"...","dialogue":"...","continuityNotes":"...","quality":"preview|balanced|hero","preferredModel":"validated-model-or-empty","characterAssetIds":["exact-known-id"],"locationAssetId":"exact-known-id-or-empty","referenceAssetIds":["exact-known-id"],"propAssetIds":["exact-known-id"]}]}. Use 2-8 shots depending on scene complexity.`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,temperature:cfg.temperature,messages:[{role:'system',content:system},{role:'user',content:user}]}),signal:AbortSignal.timeout(180_000)});
  if(!res.ok)throw new Error(`Local Director HTTP ${res.status}: ${(await res.text()).slice(0,1000)}`);
  const payload=await res.json() as ChatResponse;const content=payload.choices?.[0]?.message?.content;if(!content)throw new Error('Local Director returned no message content.');
  const parsed=parseJsonObject(content);if(!Array.isArray(parsed.shots))throw new Error('Local Director JSON is missing shots[].');
  const idsFor=(...kinds:string[])=>new Set(relevantAssets.filter(asset=>kinds.includes(asset.kind)).map(asset=>asset.id));
  const characterIds=idsFor('character'),locationIds=idsFor('location'),referenceIds=idsFor('reference'),propIds=idsFor('prop','wardrobe');
  const validModels=new Set(availableModels);
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
  const assets=[...ids].map(id=>project.assets.find(a=>a.id===id)).filter(Boolean).map(a=>`${a!.kind} ${clipText(a!.name,240)}: ${clipText(a!.notes||'(no continuity description)',800)}`).join('\n');
  const system='You are a continuity supervisor for AI-generated film shots. Return strict JSON only. Find concrete continuity risks from the provided text/reference metadata; do not claim that you visually inspected rendered pixels.';
  const user=`SCENE: ${clipText(scene?.heading||'',1000)}\n${clipText(scene?.body||'',12000)}\n\nPREVIOUS SHOT:\n${prior?`${clipText(prior.title,500)}\n${clipText(prior.prompt,6000)}\n${clipText(prior.action,3000)}\nContinuity: ${clipText(prior.continuityNotes,4000)}`:'(none)'}\n\nCURRENT SHOT:\n${clipText(shot.title,500)}\nPrompt: ${clipText(shot.prompt,8000)}\nCamera: ${clipText(shot.camera,2000)}\nAction: ${clipText(shot.action,4000)}\nDialogue/audio: ${clipText(shot.dialogue,4000)}\nContinuity: ${clipText(shot.continuityNotes,5000)}\n\nATTACHED ASSET METADATA:\n${assets||'(none)'}\n\nReturn {"issues":["specific issue"],"suggestedContinuityNotes":"concise notes","promptAddendum":"only extra constraints"}. If there is no meaningful issue, return empty fields.`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:cfg.model,temperature:Math.min(cfg.temperature,0.4),messages:[{role:'system',content:system},{role:'user',content:user}]}),signal:AbortSignal.timeout(180_000)});
  if(!res.ok)throw new Error(`Local Director HTTP ${res.status}: ${(await res.text()).slice(0,1000)}`);
  const payload=await res.json() as ChatResponse;const content=payload.choices?.[0]?.message?.content;if(!content)throw new Error('Local Director returned no message content.');
  const parsed=parseJsonObject(content);return{issues:Array.isArray(parsed.issues)?parsed.issues.map(String).slice(0,12):[],suggestedContinuityNotes:String(parsed.suggestedContinuityNotes||''),promptAddendum:String(parsed.promptAddendum||'')};
}

function clipText(value:string,max:number):string{const text=String(value??'');return text.length>max?`${text.slice(0,max-1)}…`:text;}
function assetRelevance(name:string,tags:string[],sceneText:string):number{
  let score=0;const tokens=[name,...tags].map(value=>value.trim().toLowerCase()).filter(value=>value.length>=2);
  for(const token of tokens)if(sceneText.includes(token))score+=token===name.trim().toLowerCase()?5:2;
  return score;
}
