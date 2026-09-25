import { join } from 'node:path';
import type { AppMachineSettings, FilmProject, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { assertExistingPathInside, assertPathInside } from './path-safety';
import { fingerprintRuntime, sha256File } from './runtime-fingerprint';
import { validateProfileBindings } from './workflow-engine';
import { validateWanGpProfile } from './wangp-engine';

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
  const errors = runtime === 'wangp' ? await validateWanGpProfile(profile) : await validateProfileBindings(profile);
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
