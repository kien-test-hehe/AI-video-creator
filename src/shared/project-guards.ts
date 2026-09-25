import type { FilmProject, RenderJob, RenderJobStatus } from './types';

const ACTIVE_RENDER_STATUSES=new Set<RenderJobStatus>(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);

export function hasActiveRenderJobs(jobs:Array<Pick<RenderJob,'status'>>):boolean{
  return jobs.some(job=>ACTIVE_RENDER_STATUSES.has(job.status));
}

export function removedActiveRenderShotIds(project:Pick<FilmProject,'shots'>,jobs:Array<Pick<RenderJob,'shotId'|'status'>>):string[]{
  const incomingShotIds=new Set(project.shots.map(shot=>shot.id));
  return [...new Set(jobs.filter(job=>ACTIVE_RENDER_STATUSES.has(job.status)&&!incomingShotIds.has(job.shotId)).map(job=>job.shotId))];
}
