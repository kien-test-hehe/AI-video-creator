import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMachineSettings, FilmProject, PreflightReport, ValidationIssue, WorkflowProfile } from '../../shared/types';
import { routeWorkflow } from './model-router';
import { probeSystem } from './system-probe';
import { validateProfileBindings } from './workflow-engine';
import { validateWanGpProfile } from './wangp-engine';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertPathInside } from './path-safety';
import { sha256File } from './runtime-fingerprint';

async function exists(path:string):Promise<boolean>{try{await access(path);return true;}catch{return false;}}

export async function preflightProject(project:FilmProject,machine:AppMachineSettings):Promise<PreflightReport>{
  const issues:ValidationIssue[]=[];
  const probe=await probeSystem(project,machine);
  const routed=new Map<string,WorkflowProfile>();

  for(const shot of project.shots){
    const refs=[...shot.characterAssetIds,...shot.propAssetIds,shot.locationAssetId,shot.startFrameAssetId,shot.endFrameAssetId,shot.referenceVideoAssetId,shot.audioAssetId].filter((id):id is string=>Boolean(id));
    for(const assetId of new Set(refs))if(!project.assets.some(a=>a.id===assetId))issues.push({level:'error',code:'SHOT_ASSET_MISSING',shotId:shot.id,assetId,message:`${shot.title}: referenced asset no longer exists (${assetId}).`});
    try{const profile=routeWorkflow(project,shot);routed.set(profile.id,profile);}
    catch(error){issues.push({level:'error',code:'SHOT_NO_WORKFLOW',shotId:shot.id,message:`${shot.title}: ${error instanceof Error?error.message:String(error)}`});}
    if(shot.generation.mode!=='t2v'&&!shot.startFrameAssetId&&shot.generation.mode!=='ia2v')issues.push({level:'info',code:'SHOT_NO_START_FRAME',shotId:shot.id,message:`${shot.title}: no start frame is attached; consistency may be lower for ${shot.generation.mode}.`});
    if(shot.generation.width<256||shot.generation.height<256||shot.generation.frames<1||shot.generation.fps<1)issues.push({level:'error',code:'SHOT_INVALID_DIMENSIONS',shotId:shot.id,message:`${shot.title}: invalid width/height/frames/fps values.`});
    if(shot.generation.modelFamily==='ltx-2.5-fast'&&(shot.generation.frames-1)%8!==0)issues.push({level:'warning',code:'LTX_FRAME_COUNT',shotId:shot.id,message:`${shot.title}: LTX 2.5 commonly expects frame count = 1 + a multiple of 8; current value is ${shot.generation.frames}.`});
    const seconds=shot.generation.frames/Math.max(1,shot.generation.fps);
    if(seconds>12&&shot.generation.modelFamily!=='framepack')issues.push({level:'warning',code:'LONG_SHOT',shotId:shot.id,message:`${shot.title}: ${seconds.toFixed(1)}s is long for one diffusion shot on 16 GB VRAM; split it or use a validated long-video route.`});
  }

  const usedProfiles=[...routed.values()];
  const needsWanGp=usedProfiles.some(p=>(p.runtime??(p.workflowFormat==='wangp-settings'?'wangp':'comfyui'))==='wangp');
  const needsComfy=usedProfiles.some(p=>(p.runtime??(p.workflowFormat==='wangp-settings'?'wangp':'comfyui'))==='comfyui');

  if(needsWanGp&&!probe.wangp.available)issues.push({level:'error',code:'WANGP_UNAVAILABLE',message:probe.wangp.configured?`WanGP unavailable: ${probe.wangp.error||'unknown error'}`:'Configure WanGP in Machine Settings before rendering WanGP-routed shots.'});
  if(needsComfy&&!probe.comfy.reachable)issues.push({level:'error',code:'COMFY_OFFLINE',message:`A routed shot requires ComfyUI, but ${machine.comfy.url} is offline: ${probe.comfy.error||'unknown error'}`});
  if(needsComfy&&!machine.comfy.dedicatedInstance)issues.push({level:'error',code:'COMFY_SHARED_INSTANCE',message:'Production ComfyUI routing requires a dedicated CineForge instance because cancellation and recovery use server-wide queue controls.'});
  if(needsWanGp&&machine.wangp.executionMode==='docker'){
    if(!probe.docker?.available)issues.push({level:'error',code:'DOCKER_UNAVAILABLE',message:`WanGP Docker mode is selected but Docker is unavailable: ${probe.docker?.error||'unknown error'}`});
    if(!machine.wangp.docker.image.trim())issues.push({level:'error',code:'WANGP_DOCKER_IMAGE',message:'WanGP Docker mode requires a configured image tag/digest.'});
    if(probe.docker?.gpuAccessible===false)issues.push({level:'warning',code:'DOCKER_GPU_RUNTIME',message:'Docker did not report an NVIDIA runtime. Verify NVIDIA Container Toolkit / --gpus support before rendering.'});
  }

  if(!probe.ffmpeg.available)issues.push({level:'error',code:'FFMPEG_MISSING',message:'FFmpeg is unavailable. Technical QC and timeline export require FFmpeg.'});
  if(!probe.ffmpeg.ffprobeAvailable)issues.push({level:'error',code:'FFPROBE_MISSING',message:'FFprobe is unavailable. Technical QC and safe media inspection require FFprobe.'});
  if(probe.ffmpeg.available&&!probe.ffmpeg.encoderAvailable)issues.push({level:'warning',code:'PREFERRED_ENCODER_MISSING',message:`Preferred H.264 encoder ${machine.ffmpeg.preferredH264Encoder} is unavailable; configure a supported encoder or switch to libx264.`});

  if(probe.gpu?.totalVramMb&&probe.gpu.totalVramMb<15000)issues.push({level:'warning',code:'LOW_VRAM',message:`Detected ${(probe.gpu.totalVramMb/1024).toFixed(1)} GB VRAM. The current routing defaults target roughly 16 GB.`});
  if(probe.memory&&probe.memory.totalMb<32*1024)issues.push({level:'warning',code:'LOW_SYSTEM_RAM',message:`Detected ${(probe.memory.totalMb/1024).toFixed(1)} GB RAM. 40–64 GB is recommended for model offload/switching.`});
  if(probe.memory&&probe.memory.freeMb<8*1024)issues.push({level:'warning',code:'LOW_FREE_RAM',message:`Only ${(probe.memory.freeMb/1024).toFixed(1)} GB RAM is currently free.`});
  if(probe.disk){
    const freeGb=probe.disk.freeBytes/1024/1024/1024;
    if(freeGb<5)issues.push({level:'error',code:'DISK_CRITICAL',message:`Only ${freeGb.toFixed(1)} GB free on the project volume.`});
    else if(freeGb<25)issues.push({level:'warning',code:'DISK_LOW',message:`Only ${freeGb.toFixed(1)} GB free on the project volume; local video renders/cache can consume this quickly.`});
  }

  if(project.settings.costPolicy.mode!=='codex-capcut-only')issues.push({level:'error',code:'COST_POLICY',message:'Unsupported cost policy. CineForge currently enforces Codex/ChatGPT + CapCut as the only intended recurring paid services.'});
  if(project.settings.costPolicy.allowCapcutAiCredits)issues.push({level:'warning',code:'CAPCUT_AI_CREDITS',message:'CapCut AI credits are enabled. Disable them if generation cost should remain local.'});

  const comfyShotsNeedingFileStage=project.shots.some(shot=>{
    try{const profile=routeWorkflow(project,shot);return(profile.runtime??'comfyui')==='comfyui'&&Boolean(shot.referenceVideoAssetId||shot.audioAssetId);}catch{return false;}
  });
  if(comfyShotsNeedingFileStage&&!machine.comfy.inputDir.trim())issues.push({level:'error',code:'COMFY_INPUT_REQUIRED',message:'A ComfyUI-routed shot uses input audio/video. Configure the local ComfyUI input directory in Machine Settings.'});
  else if(machine.comfy.inputDir.trim()&&!await exists(machine.comfy.inputDir))issues.push({level:comfyShotsNeedingFileStage?'error':'warning',code:'COMFY_INPUT_MISSING',message:`Configured ComfyUI input directory does not exist: ${machine.comfy.inputDir}`});

  for(const asset of project.assets){
    try{await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);}
    catch(error){issues.push({level:'error',code:'ASSET_PATH_INVALID',assetId:asset.id,message:`${asset.name}: ${error instanceof Error?error.message:String(error)}`});}
  }

  for(const profile of usedProfiles){
    if(!profile.workflowPath){issues.push({level:'error',code:'PROFILE_NO_PATH',profileId:profile.id,message:`Routed profile “${profile.name}” has no workflow/settings path.`});continue;}
    try{
      const safe=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`),`workflow path for ${profile.name}`);
      const currentSha=await sha256File(safe);
      if(profile.validation?.structuralStatus!=='valid')issues.push({level:'error',code:'PROFILE_NOT_VALIDATED',profileId:profile.id,message:`Profile “${profile.name}” has not passed structural validation. Validate it in Settings.`});
      else if(profile.validation.sourceSha256!==currentSha)issues.push({level:'error',code:'PROFILE_CHANGED',profileId:profile.id,message:`Profile “${profile.name}” changed after validation. Revalidate it before rendering.`});
      if(!profile.validation?.lastSuccessfulRenderAt)issues.push({level:'info',code:'PROFILE_NO_SUCCESSFUL_RENDER',profileId:profile.id,message:`Profile “${profile.name}” has no recorded successful render on this project yet.`});
      if(!profile.modelFingerprint)issues.push({level:'warning',code:'MODEL_FINGERPRINT_MISSING',profileId:profile.id,message:`Profile “${profile.name}” has no model/checkpoint fingerprint. Exact reproducibility cannot include model weights until you record one.`});
      const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
      const details=runtime==='wangp'?await validateWanGpProfile(profile):await validateProfileBindings(profile);
      for(const detail of details)issues.push({level:'error',code:'PROFILE_BINDING',profileId:profile.id,message:`${profile.name}: ${detail}`});
    }catch(error){issues.push({level:'error',code:'PROFILE_INVALID',profileId:profile.id,message:`${profile.name}: ${error instanceof Error?error.message:String(error)}`});}
  }

  if(project.shots.length===0)issues.push({level:'info',code:'NO_SHOTS',message:'No shots have been planned yet.'});
  return{createdAt:new Date().toISOString(),ready:!issues.some(i=>i.level==='error'),issues,probe};
}
