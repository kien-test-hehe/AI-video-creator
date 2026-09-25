import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FilmProject, PreflightReport, ValidationIssue } from '../../shared/types';
import { routeWorkflow } from './model-router';
import { probeSystem } from './system-probe';
import { validateProfileBindings } from './workflow-engine';
import { validateWanGpProfile } from './wangp-engine';
import { assertPathInside, assertRelativeProjectPath } from './path-safety';

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

export async function preflightProject(project: FilmProject): Promise<PreflightReport> {
  const issues: ValidationIssue[] = [];
  const probe = await probeSystem(project);
  const enabledVideoProfiles = project.settings.workflowProfiles.filter(p=>p.enabled && (p.purpose ?? 'video')==='video');
  const needsComfy = enabledVideoProfiles.some(p=>(p.runtime ?? 'comfyui')==='comfyui');
  const needsWanGp = enabledVideoProfiles.some(p=>(p.runtime ?? (p.workflowFormat==='wangp-settings'?'wangp':'comfyui'))==='wangp');

  if (needsWanGp && !probe.wangp.available) issues.push({level:'error',code:'WANGP_UNAVAILABLE',message:probe.wangp.configured?`WanGP is configured but unavailable: ${probe.wangp.error || probe.wangp.entrypoint}`:'Configure the WanGP root path in Settings before using WanGP production profiles.'});
  if (!needsWanGp && !probe.wangp.available) issues.push({level:'info',code:'WANGP_NOT_CONFIGURED',message:'WanGP is not configured. This is fine until a WanGP render profile is enabled.'});
  if (needsComfy && !probe.comfy.reachable) issues.push({ level: 'error', code: 'COMFY_OFFLINE', message: `An enabled ComfyUI profile requires ${project.settings.comfyUrl}, but it is offline: ${probe.comfy.error || 'unknown error'}` });
  if (!needsComfy && !probe.comfy.reachable) issues.push({ level: 'info', code: 'COMFY_OPTIONAL_OFFLINE', message: 'ComfyUI is offline, but no enabled production profile currently requires it.' });
  if (!probe.ffmpeg.available) issues.push({ level: 'warning', code: 'FFMPEG_MISSING', message: 'FFmpeg is unavailable. Generation can still work, but timeline export will fail.' });
  if (probe.gpu?.totalVramMb && probe.gpu.totalVramMb < 15000) issues.push({ level: 'warning', code: 'LOW_VRAM', message: `Detected ${(probe.gpu.totalVramMb / 1024).toFixed(1)} GB VRAM. The current local defaults target roughly 16 GB VRAM.` });

  if (project.settings.costPolicy.mode !== 'codex-capcut-only') issues.push({level:'error',code:'COST_POLICY',message:'Unsupported cost policy. CineForge currently enforces Codex/ChatGPT + CapCut as the only intended recurring paid services.'});
  if (project.settings.costPolicy.allowCapcutAiCredits) issues.push({level:'warning',code:'CAPCUT_AI_CREDITS',message:'CapCut AI credits are enabled. Disable this if you want generation cost to stay local.'});
  if (!project.settings.localOnly) issues.push({level:'warning',code:'LOCAL_ONLY_DISABLED',message:'Local-only endpoint guard is disabled. Re-enable it to prevent accidental cloud AI calls.'});

  const comfyShotsNeedingFileStage = project.shots.some(shot=>{
    try { const profile=routeWorkflow(project,shot); return (profile.runtime ?? 'comfyui')==='comfyui' && Boolean(shot.referenceVideoAssetId || shot.audioAssetId); }
    catch { return false; }
  });
  if (comfyShotsNeedingFileStage && !project.settings.comfyInputDir.trim()) issues.push({level:'error',code:'COMFY_INPUT_REQUIRED',message:'At least one ComfyUI-routed shot uses input audio/video. Configure ComfyUI/input in Settings.'});
  else if (project.settings.comfyInputDir.trim() && !await exists(project.settings.comfyInputDir)) issues.push({level:comfyShotsNeedingFileStage?'error':'warning',code:'COMFY_INPUT_MISSING',message:`Configured ComfyUI input directory does not exist: ${project.settings.comfyInputDir}`});

  for (const asset of project.assets) {
    let assetPath:string;
    try { assetPath=assertRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`); }
    catch(error){issues.push({level:'error',code:'ASSET_PATH_INVALID',assetId:asset.id,message:`${asset.name}: ${error instanceof Error?error.message:String(error)}`});continue;}
    if(!await exists(assetPath))issues.push({level:'error',code:'ASSET_MISSING',assetId:asset.id,message:`Missing project asset: ${asset.name} (${asset.projectPath})`});
  }

  for (const profile of enabledVideoProfiles) {
    if(!profile.workflowPath){issues.push({level:'warning',code:'PROFILE_NO_PATH',profileId:profile.id,message:`Enabled profile “${profile.name}” has no workflow/settings path.`});continue;}
    try{assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`);}catch(error){issues.push({level:'error',code:'PROFILE_PATH_INVALID',profileId:profile.id,message:`${profile.name}: ${error instanceof Error?error.message:String(error)}`});continue;}
    if(!await exists(profile.workflowPath)){issues.push({level:'error',code:'PROFILE_FILE_MISSING',profileId:profile.id,message:`Profile file not found for “${profile.name}”: ${profile.workflowPath}`});continue;}
    if(profile.bindings.length===0)issues.push({level:'warning',code:'PROFILE_NO_BINDINGS',profileId:profile.id,message:`Video profile “${profile.name}” has no bindings, so shot parameters may not be injected.`});
    try{
      const runtime=profile.runtime ?? (profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
      const details=runtime==='wangp'?await validateWanGpProfile(profile):await validateProfileBindings(profile);
      for(const detail of details)issues.push({level:profile.bindings.some(b=>b.required&&detail.startsWith(`${b.key}:`))?'error':'warning',code:'PROFILE_BINDING',profileId:profile.id,message:`${profile.name}: ${detail}`});
    }catch(error){issues.push({level:'error',code:'PROFILE_INVALID',profileId:profile.id,message:`${profile.name}: ${error instanceof Error?error.message:String(error)}`});}
  }

  for(const shot of project.shots){
    const refs=[...shot.characterAssetIds,...shot.propAssetIds,shot.locationAssetId,shot.startFrameAssetId,shot.endFrameAssetId,shot.referenceVideoAssetId,shot.audioAssetId].filter((id):id is string=>Boolean(id));
    for(const assetId of new Set(refs))if(!project.assets.some(a=>a.id===assetId))issues.push({level:'error',code:'SHOT_ASSET_MISSING',shotId:shot.id,assetId,message:`${shot.title}: referenced asset no longer exists (${assetId}).`});
    try{routeWorkflow(project,shot);}catch(error){issues.push({level:'error',code:'SHOT_NO_WORKFLOW',shotId:shot.id,message:`${shot.title}: ${error instanceof Error?error.message:String(error)}`});}
    if(shot.generation.mode!=='t2v'&&!shot.startFrameAssetId&&shot.generation.mode!=='ia2v')issues.push({level:'info',code:'SHOT_NO_START_FRAME',shotId:shot.id,message:`${shot.title}: no start frame is attached; consistency may be lower for ${shot.generation.mode}.`});
    if(shot.generation.width<256||shot.generation.height<256||shot.generation.frames<1||shot.generation.fps<1)issues.push({level:'error',code:'SHOT_INVALID_DIMENSIONS',shotId:shot.id,message:`${shot.title}: invalid width/height/frames/fps values.`});
    if(shot.generation.modelFamily==='ltx-2.5-fast'&&(shot.generation.frames-1)%8!==0)issues.push({level:'warning',code:'LTX_FRAME_COUNT',shotId:shot.id,message:`${shot.title}: LTX 2.5 reference workflows commonly expect frame count = 1 + a multiple of 8; current value is ${shot.generation.frames}.`});
    const seconds=shot.generation.frames/Math.max(1,shot.generation.fps);if(seconds>12&&shot.generation.modelFamily!=='framepack')issues.push({level:'warning',code:'LONG_SHOT',shotId:shot.id,message:`${shot.title}: ${seconds.toFixed(1)}s is long for one diffusion shot on 16 GB VRAM; consider splitting or a long-video route.`});
  }
  if(project.shots.length===0)issues.push({level:'info',code:'NO_SHOTS',message:'No shots have been planned yet.'});
  return{createdAt:new Date().toISOString(),ready:!issues.some(i=>i.level==='error'),issues,probe};
}
