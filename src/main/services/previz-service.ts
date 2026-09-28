import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FilmProject, PrevizRequirement, Shot } from '../../shared/types';
import { stringifyJsonLimited } from './json-file';
import { assertSafeWritePath } from './path-safety';

export interface PrevizAdvice{requirement:PrevizRequirement;score:number;reasons:string[];}

export function advisePreviz(shot:Shot):PrevizAdvice{
  let score=0;const reasons:string[]=[];
  const text=`${shot.camera} ${shot.action} ${shot.prompt}`.toLowerCase();
  const add=(points:number,reason:string)=>{score+=points;reasons.push(reason);};
  if(/\b(orbit|360|arc shot|crane|jib|drone|steadicam|tracking|truck|dolly|push[- ]?in|pull[- ]?out|follow shot)\b/.test(text))add(2,'complex camera path');
  if(/\b(vehicle|car|truck|motorcycle|bike|train|aircraft|spaceship|boat)\b/.test(text))add(2,'moving vehicle / large moving object');
  if(/\b(stairs?|doorway|corridor|hallway|elevator|balcony|bridge|window|table|counter)\b/.test(text)&&/\b(enter|exit|cross|walk|run|move|approach|pass|through|around)\b/.test(text))add(1,'action depends on environment geometry');
  if(/\b(handoff|hand over|grab|pick up|put down|open|close|sit|stand|embrace|fight|wrestle|dance|chase)\b/.test(text))add(2,'precise character/object interaction');
  if(shot.characterAssetIds.length>=3)add(2,`${shot.characterAssetIds.length} characters require blocking`);
  else if(shot.characterAssetIds.length===2)add(1,'two-character blocking');
  if(shot.propAssetIds.length>=2)add(1,'multiple continuity props');
  if(/\b(precise|exact|match|screen direction|eyeline|blocking|spatial)\b/.test(shot.continuityNotes.toLowerCase()))add(2,'explicit spatial continuity constraint');
  const requirement:PrevizRequirement=score>=4?'required':score>=2?'optional':'none';
  return{requirement,score,reasons};
}

export async function ensurePrevizPlan(project:FilmProject,shot:Shot):Promise<{advice:PrevizAdvice;manifestPath?:string}>{
  const advice=advisePreviz(shot);
  const explicit=shot.previz?.reason?.startsWith('Human override:');
  const effective=explicit?(shot.previz?.requirement??'none'):advice.requirement;
  if(effective==='none')return{advice:{...advice,requirement:'none'}};
  const relative=join('.cineforge','previz',`${shot.id}.json`);
  const absolute=await assertSafeWritePath(join(project.rootPath,'.cineforge'),join(project.rootPath,relative),'previz manifest');
  await mkdir(join(project.rootPath,'.cineforge','previz'),{recursive:true});
  const asset=(id:string|undefined)=>id?project.assets.find(item=>item.id===id):undefined;
  const manifest={
    schemaVersion:1,generatedAt:new Date().toISOString(),shotId:shot.id,sceneId:shot.sceneId,title:shot.title,
    requirement:effective,score:advice.score,reasons:advice.reasons,camera:shot.camera,action:shot.action,prompt:shot.prompt,continuityNotes:shot.continuityNotes,
    characters:shot.characterAssetIds.map(id=>asset(id)).filter(Boolean).map(item=>({id:item!.id,name:item!.name,notes:item!.notes})),
    location:asset(shot.locationAssetId)?{id:asset(shot.locationAssetId)!.id,name:asset(shot.locationAssetId)!.name,notes:asset(shot.locationAssetId)!.notes}:undefined,
    props:shot.propAssetIds.map(id=>asset(id)).filter(Boolean).map(item=>({id:item!.id,name:item!.name,notes:item!.notes})),
    targetStartFrameAssetId:shot.startFrameAssetId,targetEndFrameAssetId:shot.endFrameAssetId,
    deliverables:['camera/blocking reference','preview still or viewport render','optional depth/normal/mask passes when useful']
  };
  await writeFile(absolute,stringifyJsonLimited(manifest,'Previz manifest',2*1024*1024),'utf8');
  return{advice:{...advice,requirement:effective},manifestPath:absolute};
}
