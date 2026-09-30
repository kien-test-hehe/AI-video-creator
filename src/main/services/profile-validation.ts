import { join } from 'node:path';
import type { AppMachineSettings, FilmProject, Shot, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { assertExistingPathInside, assertPathInside } from './path-safety';
import { fingerprintRuntime, sha256File } from './runtime-fingerprint';
import { validateComfyNodeAvailability, validateProfileBindings } from './workflow-engine';
import { validateWanGpProfile } from './wangp-engine';
import { probeSystem } from './system-probe';
import { ComfyClient } from './comfy-client';
import { shotProjectRenderInputKey, workflowExecutionKey } from '../../shared/shot-signature';
import { workflowCapabilityErrors } from '../../shared/workflow-capabilities';

export async function validateAndRecordProfile(projects: ProjectService, machine: AppMachineSettings, profileId: string): Promise<FilmProject> {
  const project = projects.getCurrent();
  if (!project) throw new Error('Open a project first.');
  const profile = project.settings.workflowProfiles.find(p=>p.id===profileId);
  if (!profile) throw new Error('Workflow profile not found.');
  if (!profile.workflowPath) throw new Error('Workflow profile has no imported workflow/settings file.');
  const projectId=project.id,projectRoot=project.rootPath,profileInputKey=workflowExecutionKey(profile);

  const lexical = assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`);
  const safe = await assertExistingPathInside(join(project.rootPath,'workflows'),lexical,`workflow path for ${profile.name}`);
  const sourceSha256 = await sha256File(safe),safeProfile={...structuredClone(profile),workflowPath:safe};
  const fingerprintBefore=await fingerprintRuntime(machine,safeProfile);
  const runtime = profile.runtime ?? (profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
  const modeErrors=profilePurposeModeErrors(profile);
  const runtimeErrors = runtime === 'wangp' ? await validateWanGpProfile(safeProfile) : await validateProfileBindings(safeProfile);
  const probe=await probeSystem(project,machine);
  const environmentErrors:string[]=[],runtimeNodeErrors:string[]=[];
  if(runtime==='wangp'){
    if(!probe.wangp.available)environmentErrors.push(`WanGP runtime is not production-ready: ${probe.wangp.error||'unavailable'}`);
    if(machine.wangp.executionMode==='docker'&&probe.docker?.gpuAccessible!==true)environmentErrors.push('WanGP Docker validation requires a working NVIDIA GPU runtime.');
  }else{
    if(!probe.comfy.reachable)environmentErrors.push(`ComfyUI is offline: ${probe.comfy.error||machine.comfy.url}`);
    else{
      try{runtimeNodeErrors.push(...await validateComfyNodeAvailability(safeProfile,await new ComfyClient(machine.comfy.url,true).objectInfo()));}
      catch(error){runtimeNodeErrors.push(`ComfyUI node catalog validation failed: ${error instanceof Error?error.message:String(error)}`);}
    }
    if(!machine.comfy.dedicatedInstance)environmentErrors.push('ComfyUI production profiles require a dedicated CineForge instance for workload isolation, deterministic recovery, and safe legacy cancellation fallback.');
  }
  const errors=[...modeErrors,...runtimeErrors,...runtimeNodeErrors,...environmentErrors];
  const fingerprint = await fingerprintRuntime(machine, safeProfile);
  if(fingerprint.environmentSha256!==fingerprintBefore.environmentSha256)throw new Error('Local AI runtime changed while profile validation was running. Validate again against the stable runtime.');
  if(await sha256File(safe)!==sourceSha256)throw new Error('Workflow file changed while profile validation was running. Validate again.');
  const now = new Date().toISOString();

  return projects.mutate(p=>{
    if(p.id!==projectId||p.rootPath!==projectRoot)throw new Error('Project changed while workflow validation was running. Validation result was discarded.');
    const target=p.settings.workflowProfiles.find(item=>item.id===profileId);
    if(!target)throw new Error('Workflow profile was removed while validation was running. Validation result was discarded.');
    if(workflowExecutionKey(target)!==profileInputKey)throw new Error('Workflow profile configuration changed while validation was running. Validation result was discarded; validate again.');
    const before=new Map(p.shots.map(shot=>[shot.id,shotProjectRenderInputKey(p,shot)]));
    target.validation = {
      ...(target.validation ?? { structuralStatus:'unvalidated' }),
      structuralStatus: errors.length ? 'invalid' : 'valid',
      validatedAt: now,
      sourceSha256,
      runtimeFingerprint: fingerprint.environmentSha256,
      lastError: errors.length ? errors.join('\n').slice(0,10_000) : undefined,
      lastSuccessfulRenderAt: target.validation?.lastSuccessfulRenderAt
    };
    for(const shot of p.shots){
      if(before.get(shot.id)===shotProjectRenderInputKey(p,shot))continue;
      shot.latestRenderId=undefined;
      if(['rendered','failed'].includes(shot.status))shot.status='ready';
    }
  });
}

export function profileCompatibilityErrors(profile: WorkflowProfile, shot: Shot): string[] {
  return workflowCapabilityErrors(profile,shot);
}


function profilePurposeModeErrors(profile:WorkflowProfile):string[]{
  const imageMode=profile.mode==='t2i'||profile.mode==='i2i';
  if(profile.purpose==='video'&&imageMode)return[`Video profile “${profile.name}” cannot use image-only mode ${profile.mode}.`];
  if(profile.purpose==='image'&&!imageMode)return[`Image profile “${profile.name}” must use t2i or i2i, not ${profile.mode}.`];
  if(profile.purpose==='audio'||profile.purpose==='utility')return[`${profile.purpose} workflow profiles are stored for forward compatibility but are not executable by the current CineForge routing layer.`];
  return[];
}
