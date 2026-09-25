import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { assertRelativeProjectPath } from './path-safety';
import type { FilmProject } from '../../shared/types';

export interface CapCutHandoffResult { directory: string; manifestPath: string; taskPath: string; prompt: string; }

export async function prepareCapCutHandoff(project: FilmProject): Promise<CapCutHandoffResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(project.rootPath, project.settings.capcut.handoffDirName || 'handoff/capcut', stamp);
  await mkdir(base, { recursive: true });

  const clips = [...project.timeline].sort((a,b)=>a.track-b.track || a.order-b.order).map(clip => {
    const shot = project.shots.find(s=>s.id===clip.shotId);
    const render = project.renderOutputs.find(r=>r.id===clip.renderOutputId);
    return {
      clipId: clip.id,
      track: clip.track,
      order: clip.order,
      shotId: clip.shotId,
      shotTitle: shot?.title || clip.shotId,
      sourcePath: render?.path || null,
      sourceRelativeToProject: render?.path ? relative(project.rootPath, render.path) : null,
      trimInSec: clip.trimInSec,
      trimOutSec: clip.trimOutSec ?? null,
      volume: clip.volume,
      dialogue: shot?.dialogue || '',
      continuityNotes: shot?.continuityNotes || ''
    };
  });

  const manifest = {
    schema: 'cineforge-capcut-handoff/v1',
    project: { id: project.id, name: project.name, title: project.story.title, rootPath: project.rootPath },
    policy: {
      recurringPaidServices: ['Codex/ChatGPT', project.settings.capcut.pro ? 'CapCut Pro' : 'CapCut'],
      capcutAiCreditsAllowed: project.settings.costPolicy.allowCapcutAiCredits,
      cloudGenerationAllowed: false,
      note: 'Use existing/local-generated media. Do not spend CapCut AI credits unless capcutAiCreditsAllowed is true.'
    },
    output: { fps: project.settings.defaultFps, container: project.settings.outputContainer },
    clips,
    assets: project.assets.map(a=>({ id:a.id, kind:a.kind, name:a.name, path:assertRelativeProjectPath(project.rootPath,a.projectPath,'assets',`asset path for ${a.name}`), notes:a.notes, tags:a.tags })),
    story: project.story
  };

  const prompt = `Open the CapCut × Codex workflow and build an editable CapCut draft from this CineForge handoff. Preserve clip order, trims, dialogue timing and continuity notes. Use CapCut for timeline editing, typography, captions, transitions, tracking/reframe, effects and finishing. Do NOT generate replacement media with paid CapCut AI credits unless the manifest explicitly allows it. Prefer the existing local-generated assets. Keep the result editable in CapCut and do not flatten the project prematurely.`;

  const task = `# CineForge → CapCut × Codex handoff\n\n${prompt}\n\n## Inputs\n\n- Manifest: \`${join(base,'manifest.json')}\`\n- Project root: \`${project.rootPath}\`\n- Timeline clips: ${clips.length}\n- AI credit permission: **${project.settings.costPolicy.allowCapcutAiCredits ? 'ALLOWED' : 'DISABLED'}**\n\n## Finishing priorities\n\n1. Preserve editorial intent and clip timing.\n2. Style captions/typography in CapCut; never bake important text into generated imagery.\n3. Use deterministic cuts/J-cuts/L-cuts/fades/transitions where appropriate.\n4. Apply tracking/reframe/effects only when they improve the shot.\n5. Keep the CapCut project editable for final human verification.\n`;

  const manifestPath = join(base, 'manifest.json');
  const taskPath = join(base, 'CODEX_CAPCUT_TASK.md');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(taskPath, task, 'utf8');
  return { directory: base, manifestPath, taskPath, prompt };
}
