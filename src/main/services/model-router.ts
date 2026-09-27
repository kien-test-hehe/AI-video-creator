import type { FilmProject, Shot, WorkflowProfile } from '../../shared/types';
import { chooseModelForShot } from '../../shared/routing';
import { profileCompatibilityErrors } from './profile-validation';

export function routeWorkflow(project: FilmProject, shot: Shot, forcedProfileId?: string): WorkflowProfile {
  if (forcedProfileId) {
    const forced = project.settings.workflowProfiles.find(p => p.id === forcedProfileId && p.enabled && (p.purpose ?? 'video') === 'video');
    if (!forced) throw new Error(`Forced workflow profile is missing or disabled: ${forcedProfileId}`);
    assertUsableProfile(forced, shot);
    return forced;
  }

  if (shot.generation.workflowProfileId) {
    const explicit = project.settings.workflowProfiles.find(p => p.id === shot.generation.workflowProfileId && p.enabled && (p.purpose ?? 'video') === 'video');
    if (!explicit) throw new Error(`Selected workflow profile is missing or disabled: ${shot.generation.workflowProfileId}`);
    assertUsableProfile(explicit, shot);
    return explicit;
  }

  const candidates = project.settings.workflowProfiles.filter(p =>
    p.enabled &&
    (p.purpose ?? 'video') === 'video' &&
    p.modelFamily === shot.generation.modelFamily &&
    p.mode === shot.generation.mode &&
    p.workflowPath
  );
  if (candidates.length === 0) throw new Error(`No enabled ${shot.generation.modelFamily}/${shot.generation.mode} workflow profile. Import, validate and enable a matching WanGP settings profile or ComfyUI workflow in Settings.`);

  const validated = candidates.find(p=>p.validation?.structuralStatus==='valid');
  if(!validated)throw new Error(`No validated ${shot.generation.modelFamily}/${shot.generation.mode} workflow profile. Validate a matching profile in Settings before rendering.`);
  return validated;
}

function assertUsableProfile(profile: WorkflowProfile, shot: Shot): void {
  if (!profile.workflowPath) throw new Error(`Workflow profile has no workflow path: ${profile.name}`);
  if(profile.validation?.structuralStatus!=='valid')throw new Error(`Workflow profile is ${profile.validation?.structuralStatus||'unvalidated'}: ${profile.name}. Validate it before production use.`);
  const mismatch = profileCompatibilityErrors(profile,shot);
  if (mismatch.length) throw new Error(`${profile.name}: ${mismatch.join(' ')}`);
}

export const autoChooseModel = chooseModelForShot;
