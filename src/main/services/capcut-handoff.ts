import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FilmProject } from '../../shared/types';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertSafeWritePath } from './path-safety';

export interface CapCutHandoffResult{directory:string;manifestPath:string;taskPath:string;prompt:string}

export async function prepareCapCutHandoff(project:FilmProject):Promise<CapCutHandoffResult>{
  if(!project.settings.capcut.enabled)throw new Error('CapCut handoff is disabled for this project.');
  if(!project.timeline.length)throw new Error('Timeline is empty. Build the canonical CineForge cut before creating a CapCut handoff.');

  const ordered=[...project.timeline].sort((a,b)=>a.track-b.track||a.order-b.order);
  const seen=new Set<string>();
  const clips=[];
  for(const clip of ordered){
    const orderKey=`${clip.track}:${clip.order}`;if(seen.has(orderKey))throw new Error(`Duplicate timeline order detected at track ${clip.track}, order ${clip.order}.`);seen.add(orderKey);
    if(clip.trimOutSec!=null&&clip.trimOutSec<=clip.trimInSec)throw new Error(`Invalid trim on timeline clip ${clip.id}.`);
    if(!Number.isFinite(clip.volume)||clip.volume<0)throw new Error(`Invalid volume on timeline clip ${clip.id}.`);
    const shot=project.shots.find(s=>s.id===clip.shotId);if(!shot)throw new Error(`Timeline clip ${clip.id} references a missing shot.`);
    const render=project.renderOutputs.find(r=>r.id===clip.renderOutputId);if(!render||render.mediaType!=='video')throw new Error(`Timeline clip ${clip.id} has no valid video render.`);
    const duration=render.technicalQc?.durationSec;
    if(duration!=null&&clip.trimInSec>=duration)throw new Error(`Timeline clip ${clip.id} starts at ${clip.trimInSec}s, beyond its measured ${duration.toFixed(3)}s source duration.`);
    if(duration!=null&&clip.trimOutSec!=null&&clip.trimOutSec>duration+0.02)throw new Error(`Timeline clip ${clip.id} ends at ${clip.trimOutSec}s, beyond its measured ${duration.toFixed(3)}s source duration.`);
    const sourcePath=await assertExistingPathInside(join(project.rootPath,'renders'),render.path,`CapCut source for ${shot.title}`);
    clips.push({clipId:clip.id,track:clip.track,order:clip.order,shotId:clip.shotId,shotTitle:shot.title,sourcePath,sourceRelativeToProject:relative(project.rootPath,sourcePath),trimInSec:clip.trimInSec,trimOutSec:clip.trimOutSec??null,volume:clip.volume,dialogue:shot.dialogue,continuityNotes:shot.continuityNotes,technicalQc:render.technicalQc??null});
  }

  const assets=[];
  for(const asset of project.assets){
    const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
    assets.push({id:asset.id,kind:asset.kind,name:asset.name,path,projectRelativePath:relative(project.rootPath,path),notes:asset.notes,tags:asset.tags});
  }

  const stamp=new Date().toISOString().replace(/[:.]/g,'-'),handoffRoot=join(project.rootPath,'handoff','capcut');
  await mkdir(handoffRoot,{recursive:true});const base=await assertSafeWritePath(handoffRoot,join(handoffRoot,stamp),'CapCut handoff directory');await mkdir(base,{recursive:true});

  const manifest={
    schema:'cineforge-capcut-handoff/v2',
    project:{id:project.id,name:project.name,title:project.story.title,rootPath:project.rootPath,schemaVersion:project.schemaVersion},
    policy:{recurringPaidServices:['Codex/ChatGPT',project.settings.capcut.pro?'CapCut Pro':'CapCut'],capcutAiCreditsAllowed:project.settings.costPolicy.allowCapcutAiCredits,cloudGenerationAllowed:false,note:'Use existing/local-generated media. Do not spend CapCut AI credits unless capcutAiCreditsAllowed is true.'},
    output:{fps:project.settings.defaultFps,container:project.settings.outputContainer},clips,assets,story:project.story
  };

  const prompt='Open the official CapCut × Codex workflow and build an editable CapCut draft from this CineForge handoff. Preserve clip order, trims, dialogue timing and continuity notes. Use CapCut for timeline editing, typography, captions, transitions, tracking/reframe, effects and finishing. Do NOT generate replacement media with paid CapCut AI credits unless the manifest explicitly allows it. Prefer the existing local-generated assets. Keep the result editable in CapCut and do not flatten the project prematurely.';
  const manifestPath=await assertSafeWritePath(base,join(base,'manifest.json'),'CapCut manifest'),taskPath=await assertSafeWritePath(base,join(base,'CODEX_CAPCUT_TASK.md'),'CapCut task');
  const task=`# CineForge → CapCut × Codex handoff\n\n${prompt}\n\n## Inputs\n\n- Manifest: \`${manifestPath}\`\n- Project root: \`${project.rootPath}\`\n- Timeline clips: ${clips.length}\n- AI credit permission: **${project.settings.costPolicy.allowCapcutAiCredits?'ALLOWED':'DISABLED'}**\n\n## Finishing priorities\n\n1. Preserve editorial intent and clip timing.\n2. Style captions/typography in CapCut; never bake important text into generated imagery.\n3. Use deterministic cuts/J-cuts/L-cuts/fades/transitions where appropriate.\n4. Apply tracking/reframe/effects only when they improve the shot.\n5. Keep the CapCut project editable for final human verification.\n6. If a listed source is missing or unreadable, stop and report it instead of substituting cloud-generated media.\n`;
  await writeFile(manifestPath,JSON.stringify(manifest,null,2),'utf8');await writeFile(taskPath,task,'utf8');
  return{directory:base,manifestPath,taskPath,prompt};
}
