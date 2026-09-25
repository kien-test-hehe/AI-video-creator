import { join } from 'node:path';
import type { AppMachineSettings, FilmProject, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { assertExistingPathInside, assertPathInside } from './path-safety';
import { fingerprintRuntime, sha256File } from './runtime-fingerprint';
import { validateComfyNodeAvailability, validateProfileBindings } from './workflow-engine';
import { validateWanGpProfile } from './wangp-engine';
import { probeSystem } from './system-probe';
import { ComfyClient } from './comfy-client';

export async function validateAndRecordProfile(projects: ProjectService, machine: AppMachineSettings, profileId: string): Promise<FilmProject> {
  const project = projects.getCurrent();
  if (!project) throw new Error('Open a project first.');
  const profile = project.settings.workflowProfiles.find(p=>p.id===profileId);
  if (!profile) throw new Error('Workflow profile not found.');
  if (!profile.workflowPath) throw new Error('Workflow profile has no imported workflow/settings file.');

  const lexical = assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`);
  const safe = await assertExistingPathInside(join(project.rootPath,'workflows'),lexical,`workflow path for ${profile.name}`);
  const sourceSha256 = await sha256File(safe);
  const runtime = profile.runtime ?? (profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
  const modeErrors=profilePurposeModeErrors(profile);
  const runtimeErrors = runtime === 'wangp' ? await validateWanGpProfile(profile) : await validateProfileBindings(profile);
  const probe=await probeSystem(project,machine);
  const environmentErrors:string[]=[],runtimeNodeErrors:string[]=[];
  if(runtime==='wangp'){
    if(!probe.wangp.available)environmentErrors.push(`WanGP runtime is not production-ready: ${probe.wangp.error||'unavailable'}`);
    if(machine.wangp.executionMode==='docker'&&probe.docker?.gpuAccessible!==true)environmentErrors.push('WanGP Docker validation requires a working NVIDIA GPU runtime.');
  }else{
    if(!probe.comfy.reachable)environmentErrors.push(`ComfyUI is offline: ${probe.comfy.error||machine.comfy.url}`);
    else{
      try{runtimeNodeErrors.push(...await validateComfyNodeAvailability(profile,await new ComfyClient(machine.comfy.url,true).objectInfo()));}
      catch(error){runtimeNodeErrors.push(`ComfyUI node catalog validation failed: ${error instanceof Error?error.message:String(error)}`);}
    }
    if(!machine.comfy.dedicatedInstance)environmentErrors.push('ComfyUI production profiles require a dedicated CineForge instance for workload isolation, deterministic recovery, and safe legacy cancellation fallback.');
  }
  const errors=[...modeErrors,...runtimeErrors,...runtimeNodeErrors,...environmentErrors];
  const fingerprint = await fingerprintRuntime(machine, profile);
  const now = new Date().toISOString();

  return projects.mutate(p=>{
    const target=p.settings.workflowProfiles.find(item=>item.id===profileId);
    if(!target)return;
    target.validation = {
      ...(target.validation ?? { structuralStatus:'unvalidated' }),
      structuralStatus: errors.length ? 'invalid' : 'valid',
      validatedAt: now,
      sourceSha256,
      runtimeFingerprint: fingerprint.environmentSha256,
      lastError: errors.length ? errors.join('\n') : undefined,
      lastSuccessfulRenderAt: target.validation?.lastSuccessfulRenderAt
    };
  });
}

export function profileCompatibilityErrors(profile: WorkflowProfile, shot: { generation: { modelFamily:string; mode:string } }): string[] {
  const errors:string[]=[];
  if(profile.modelFamily!==shot.generation.modelFamily)errors.push(`Profile model family ${profile.modelFamily} does not match shot model ${shot.generation.modelFamily}.`);
  if(profile.mode!==shot.generation.mode)errors.push(`Profile mode ${profile.mode} does not match shot mode ${shot.generation.mode}.`);
  return errors;
}


function profilePurposeModeErrors(profile:WorkflowProfile):string[]{
  const imageMode=profile.mode==='t2i'||profile.mode==='i2i';
  if(profile.purpose==='video'&&imageMode)return[`Video profile “${profile.name}” cannot use image-only mode ${profile.mode}.`];
  if(profile.purpose==='image'&&!imageMode)return[`Image profile “${profile.name}” must use t2i or i2i, not ${profile.mode}.`];
  if(profile.purpose==='audio'||profile.purpose==='utility')return[`${profile.purpose} workflow profiles are stored for forward compatibility but are not executable by the current CineForge routing layer.`];
  return[];
}
