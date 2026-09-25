import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Asset, FilmProject, KeyframeRequest, Shot, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { ComfyClient } from './comfy-client';
import { compileProfile, type WorkflowValues } from './workflow-engine';
import { collectComfyFileRefs, inferMediaType, uniqueComfyFileRefs } from './comfy-output';
import { waitForComfyCompletion } from './comfy-runner';
import { assertPathInside, assertRelativeProjectPath } from './path-safety';

function keyframePrompt(shot: Shot, role: 'start'|'end'): string {
  const temporal = role === 'start'
    ? 'Create the opening hero frame before the described motion begins.'
    : 'Create the final hero frame after the described action has resolved.';
  return [shot.prompt, temporal, shot.camera && `Camera: ${shot.camera}`, shot.action && `Action context: ${shot.action}`, shot.continuityNotes && `Continuity: ${shot.continuityNotes}`, 'Single cinematic still frame. No split screen, no storyboard grid.'].filter(Boolean).join('\n');
}

function chooseProfile(project: FilmProject, id: string): WorkflowProfile {
  const profile = project.settings.workflowProfiles.find(p => p.id === id && p.enabled);
  if (!profile) throw new Error('Keyframe workflow profile is missing or disabled.');
  if ((profile.purpose ?? 'video') !== 'image') throw new Error('Selected workflow profile is not marked as an image workflow.');
  if (!profile.workflowPath) throw new Error('Keyframe workflow profile has no workflow path.');
  return profile;
}

export async function generateKeyframe(projects: ProjectService, request: KeyframeRequest): Promise<FilmProject> {
  const project = projects.getCurrent();
  if (!project) throw new Error('Open a project first.');
  if (project.rootPath !== request.projectRoot) throw new Error('Keyframe request does not match the open project.');
  const shot = project.shots.find(s => s.id === request.shotId);
  if (!shot) throw new Error('Shot not found.');
  const profile = chooseProfile(project, request.workflowProfileId);
  const client = new ComfyClient(project.settings.comfyUrl, project.settings.localOnly);
  const ping = await client.ping();
  if (!ping.reachable) throw new Error(`ComfyUI unavailable: ${ping.error || project.settings.comfyUrl}`);

  const values: WorkflowValues = {
    prompt: keyframePrompt(shot, request.role),
    negativePrompt: shot.generation.negativePrompt,
    width: shot.generation.width,
    height: shot.generation.height,
    frames: 1,
    fps: 1,
    steps: shot.generation.steps,
    cfg: shot.generation.cfg,
    seed: shot.generation.seed + (request.role === 'end' ? 1 : 0),
    filenamePrefix: `cineforge/keyframes/${shot.id}/${request.role}`
  };

  if (profile.mode === 'i2i' && request.role === 'end' && shot.startFrameAssetId) {
    const start = project.assets.find(a => a.id === shot.startFrameAssetId);
    if (start) {
      const uploaded = await client.uploadImage(assertRelativeProjectPath(project.rootPath, start.projectPath, 'assets', `asset path for ${start.name}`));
      values.startImage = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.filename}` : uploaded.filename;
    }
  }

  assertPathInside(join(project.rootPath, 'workflows'), profile.workflowPath, `workflow path for ${profile.name}`);
  const workflow = await compileProfile(profile, values);
  const queued = await client.queuePrompt(workflow, { cineforge: { projectId: project.id, shotId: shot.id, purpose: 'keyframe', role: request.role } });
  const history = await waitForComfyCompletion(client, queued.prompt_id);
  const refs = uniqueComfyFileRefs(collectComfyFileRefs(history?.outputs || history));
  const imageRef = refs.find(r => inferMediaType(r.filename) === 'image');
  if (!imageRef) throw new Error('Image workflow completed but returned no image output.');

  const bytes = await client.download(imageRef);
  const assetId = randomUUID();
  const extension = extname(imageRef.filename) || '.png';
  const relative = join('assets', 'keyframe', `${shot.id}-${request.role}-${assetId}${extension}`);
  await mkdir(join(project.rootPath, 'assets', 'keyframe'), { recursive: true });
  await writeFile(join(project.rootPath, relative), bytes);
  const asset: Asset = {
    id: assetId,
    kind: 'keyframe',
    name: `${shot.title} ${request.role} keyframe`,
    sourcePath: `comfy://${imageRef.subfolder || ''}/${imageRef.filename}`,
    projectPath: relative,
    tags: ['generated', 'keyframe', request.role, profile.modelFamily],
    notes: `Generated locally with workflow profile ${profile.name}.`,
    createdAt: new Date().toISOString()
  };

  return projects.mutate(p => {
    p.assets.push(asset);
    const target = p.shots.find(s => s.id === shot.id);
    if (!target) return;
    if (request.role === 'start') target.startFrameAssetId = asset.id;
    else target.endFrameAssetId = asset.id;
    if (target.status === 'draft') target.status = 'ready';
  });
}
