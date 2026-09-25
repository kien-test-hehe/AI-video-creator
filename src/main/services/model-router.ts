import type { FilmProject, Shot, WorkflowProfile } from '../../shared/types';
import { chooseModelForShot } from '../../shared/routing';

export function routeWorkflow(project: FilmProject, shot: Shot, forcedProfileId?: string): WorkflowProfile {
  if (forcedProfileId) {
    const forced = project.settings.workflowProfiles.find(p => p.id === forcedProfileId && p.enabled && (p.purpose ?? 'video') === 'video');
    if (!forced) throw new Error(`Forced workflow profile is missing or disabled: ${forcedProfileId}`);
    if (!forced.workflowPath) throw new Error(`Forced workflow profile has no workflow path: ${forced.name}`);
    return forced;
  }
  if (shot.generation.workflowProfileId) {
    const explicit = project.settings.workflowProfiles.find(p => p.id === shot.generation.workflowProfileId && p.enabled && (p.purpose ?? 'video') === 'video');
    if (explicit?.workflowPath) return explicit;
  }
  const candidates = project.settings.workflowProfiles.filter(p =>
    p.enabled && (p.purpose ?? 'video') === 'video' && p.modelFamily === shot.generation.modelFamily && p.mode === shot.generation.mode && p.workflowPath
  );
  if (candidates.length === 0) throw new Error(`No enabled ${shot.generation.modelFamily}/${shot.generation.mode} workflow profile. Import and enable a matching WanGP settings profile or ComfyUI workflow in Settings.`);
  return candidates[0];
}

export const autoChooseModel = chooseModelForShot;
