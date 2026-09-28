import type { FilmProject, RenderJob, RenderJobStatus } from './types';

const ACTIVE_RENDER_STATUSES=new Set<RenderJobStatus>(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);

export function hasActiveRenderJobs(jobs:Array<Pick<RenderJob,'status'>>):boolean{
  return jobs.some(job=>ACTIVE_RENDER_STATUSES.has(job.status));
}

export function removedActiveRenderShotIds(project:Pick<FilmProject,'shots'>,jobs:Array<Pick<RenderJob,'shotId'|'status'>>):string[]{
  const incomingShotIds=new Set(project.shots.map(shot=>shot.id));
  return [...new Set(jobs.filter(job=>ACTIVE_RENDER_STATUSES.has(job.status)&&!incomingShotIds.has(job.shotId)).map(job=>job.shotId))];
}

export const MAX_WORKFLOW_PROFILES=512;
export function workflowProfileCapacityIssue(project:Pick<FilmProject,'settings'>):string|undefined{
  return project.settings.workflowProfiles.length>=MAX_WORKFLOW_PROFILES
    ? `Project already has the maximum of ${MAX_WORKFLOW_PROFILES} workflow profiles. Delete an unused profile before importing or provisioning another one.`
    : undefined;
}
