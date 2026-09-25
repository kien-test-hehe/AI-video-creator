import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { dialog } from 'electron';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';
import type { Asset, AssetKind, FilmProject, ParsedScene, Scene, Shot } from '../../shared/types';
import { assertPathInside, assertRelativeProjectPath, isPathInside } from './path-safety';

const PROJECT_FILE = 'cineforge.project.json';
const PROJECT_BACKUP_FILE = 'cineforge.project.backup.json';

export class ProjectService {
  private current: FilmProject | null = null;
  private gate: Promise<void> = Promise.resolve();

  getCurrent(): FilmProject | null {
    return this.current ? structuredClone(this.current) : null;
  }

  async createWithDialog(name = 'Untitled Film'): Promise<FilmProject | null> {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for the new CineForge project',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return this.createAt(result.filePaths[0], name);
  }

  async createAt(rootPath: string, name: string): Promise<FilmProject> {
    await this.ensureFolders(rootPath);
    const now = new Date().toISOString();
    const project: FilmProject = {
      schemaVersion: 1,
      id: randomUUID(),
      name,
      rootPath,
      createdAt: now,
      updatedAt: now,
      story: { title: name, logline: '', script: '', notes: '' },
      scenes: [],
      assets: [],
      shots: [],
      renderJobs: [],
      renderOutputs: [],
      timeline: [],
      settings: {
        costPolicy: { mode: 'codex-capcut-only', allowCapcutAiCredits: false },
        wangp: { rootPath: process.env.CINEFORGE_WANGP_ROOT || '', pythonPath: process.env.CINEFORGE_PYTHON || 'python', entrypoint: 'wgp.py', profile: 4, attention: 'auto', dryRunBeforeRender: false },
        capcut: { enabled: true, pro: true, handoffDirName: 'handoff/capcut' },
        comfyUrl: process.env.CINEFORGE_COMFY_URL || 'http://127.0.0.1:8188',
        ffmpegPath: process.env.CINEFORGE_FFMPEG || 'ffmpeg',
        comfyInputDir: process.env.CINEFORGE_COMFY_INPUT || '',
        localOnly: true,
        defaultFps: 24,
        outputContainer: 'mp4',
        workflowProfiles: structuredClone(BUILTIN_WORKFLOW_PROFILES),
        director: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', temperature: 0.3 }
      }
    };
    await this.persistUnlocked(project);
    return structuredClone(project);
  }

  async openWithDialog(): Promise<FilmProject | null> {
    const result = await dialog.showOpenDialog({
      title: 'Open CineForge project folder',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = join(result.filePaths[0], PROJECT_FILE);
    const backup = join(result.filePaths[0], PROJECT_BACKUP_FILE);
    let project: FilmProject;
    try {
      project = JSON.parse(await readFile(file, 'utf8')) as FilmProject;
    } catch (primaryError) {
      try {
        project = JSON.parse(await readFile(backup, 'utf8')) as FilmProject;
        await copyFile(backup, file);
        console.warn('Recovered CineForge project from backup after the primary project file could not be parsed.', primaryError);
      } catch {
        throw primaryError;
      }
    }
    if (project.schemaVersion !== 1) throw new Error(`Unsupported project schema: ${project.schemaVersion}`);
    const storedRoot = project.rootPath;
    const openedRoot = result.filePaths[0];
    if (storedRoot && resolve(storedRoot) !== resolve(openedRoot)) {
      for (const profile of project.settings.workflowProfiles ?? []) {
        if (profile.workflowPath && isPathInside(resolve(storedRoot, 'workflows'), profile.workflowPath)) {
          profile.workflowPath = join(openedRoot, relative(storedRoot, profile.workflowPath));
        }
      }
      for (const output of project.renderOutputs ?? []) {
        if (output.path && isPathInside(resolve(storedRoot, 'renders'), output.path)) {
          output.path = join(openedRoot, relative(storedRoot, output.path));
        }
      }
      for (const job of project.renderJobs ?? []) {
        const snapshotPath = job.spec?.workflowProfile.workflowPath;
        if (snapshotPath && isPathInside(resolve(storedRoot, 'workflows'), snapshotPath)) {
          job.spec!.workflowProfile.workflowPath = join(openedRoot, relative(storedRoot, snapshotPath));
        }
      }
    }
    project.rootPath = openedRoot;
    project.settings.costPolicy ??= { mode: 'codex-capcut-only', allowCapcutAiCredits: false };
    project.settings.wangp ??= { rootPath: process.env.CINEFORGE_WANGP_ROOT || '', pythonPath: process.env.CINEFORGE_PYTHON || 'python', entrypoint: 'wgp.py', profile: 4, attention: 'auto', dryRunBeforeRender: false };
    project.settings.capcut ??= { enabled: true, pro: true, handoffDirName: 'handoff/capcut' };
    project.settings.comfyInputDir ??= '';
    project.settings.defaultFps ??= 24;
    project.settings.outputContainer ??= 'mp4';
    project.settings.director ??= { baseUrl: 'http://127.0.0.1:11434/v1', model: '', temperature: 0.3 };
    project.settings.workflowProfiles ??= [];
    for (const builtin of BUILTIN_WORKFLOW_PROFILES) {
      if (!project.settings.workflowProfiles.some(p => p.id === builtin.id)) project.settings.workflowProfiles.push(structuredClone(builtin));
    }
    for (const profile of project.settings.workflowProfiles) { profile.purpose ??= 'video'; profile.runtime ??= profile.workflowFormat === 'wangp-settings' ? 'wangp' : 'comfyui'; }
    for (const shot of project.shots) {
      shot.characterAssetIds ??= [];
      shot.propAssetIds ??= [];
      shot.generation.includeAudio ??= false;
    }
    this.validateStoragePaths(project);
    await this.ensureFolders(project.rootPath);
    const interrupted = new Set(['queued', 'preparing', 'uploading', 'submitted', 'running', 'downloading']);
    for (const job of project.renderJobs) {
      if (interrupted.has(job.status)) {
        job.status = 'failed';
        job.progress = 0;
        job.message = 'Interrupted by application restart';
        job.error = 'The previous local render session ended before this job completed.';
        job.updatedAt = new Date().toISOString();
      }
    }
    for (const shot of project.shots) {
      if (shot.status === 'rendering' || shot.status === 'queued') {
        const latest = project.renderJobs.find(j => j.shotId === shot.id);
        shot.status = latest?.status === 'done' ? 'rendered' : latest?.status === 'failed' ? 'failed' : 'draft';
      }
    }
    this.current = project;
    await this.persistUnlocked(project);
    return structuredClone(project);
  }

  async save(project: FilmProject): Promise<FilmProject> {
    return this.runExclusive(() => this.persistUnlocked(project));
  }

  async saveFromRenderer(project: FilmProject): Promise<FilmProject> {
    return this.runExclusive(async () => {
      if (!this.current) throw new Error('No project is open.');
      const incoming = structuredClone(project);
      if (incoming.id !== this.current.id) throw new Error('Renderer project does not match the open main-process project.');
      if (incoming.schemaVersion !== this.current.schemaVersion) throw new Error('Renderer cannot change the project schema version.');
      incoming.rootPath = this.current.rootPath;
      incoming.createdAt = this.current.createdAt;
      incoming.renderJobs = structuredClone(this.current.renderJobs);
      incoming.renderOutputs = structuredClone(this.current.renderOutputs);
      const editedAssets = new Map(incoming.assets.map(asset => [asset.id, asset]));
      incoming.assets = this.current.assets.map(original => {
        const edited = editedAssets.get(original.id);
        return edited
          ? { ...structuredClone(original), name: edited.name, tags: [...edited.tags], notes: edited.notes }
          : structuredClone(original);
      });
      const runtime = new Map(this.current.shots.map(shot => [shot.id, { status: shot.status, latestRenderId: shot.latestRenderId }]));
      for (const shot of incoming.shots) {
        const state = runtime.get(shot.id);
        if (state) { shot.status = state.status; shot.latestRenderId = state.latestRenderId; }
      }
      this.validateStoragePaths(incoming);
      return this.persistUnlocked(incoming);
    });
  }

  async mutate(mutator: (project: FilmProject) => void | Promise<void>): Promise<FilmProject> {
    return this.runExclusive(async () => {
      if (!this.current) throw new Error('No project is open.');
      const copy = structuredClone(this.current);
      await mutator(copy);
      return this.persistUnlocked(copy);
    });
  }

  private async persistUnlocked(project: FilmProject): Promise<FilmProject> {
    project.updatedAt = new Date().toISOString();
    await this.ensureFolders(project.rootPath);
    const serializable = structuredClone(project);
    const projectFile = join(project.rootPath, PROJECT_FILE);
    const backupFile = join(project.rootPath, PROJECT_BACKUP_FILE);
    const tempFile = join(project.rootPath, `.${PROJECT_FILE}.${process.pid}.tmp`);
    const payload = JSON.stringify(serializable, null, 2);
    try { await copyFile(projectFile, backupFile); } catch { }
    await writeFile(tempFile, payload, 'utf8');
    try {
      await rename(tempFile, projectFile);
    } catch (error: any) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      await writeFile(projectFile, payload, 'utf8');
      await rm(tempFile, { force: true }).catch(() => undefined);
    }
    this.current = serializable;
    return structuredClone(serializable);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async importAsset(kind: AssetKind): Promise<FilmProject | null> {
    if (!this.current) throw new Error('Open a project first.');
    const result = await dialog.showOpenDialog({
      title: `Import ${kind}`,
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    return this.mutate(async project => {
      for (const sourcePath of result.filePaths) {
        const id = randomUUID();
        const original = basename(sourcePath);
        const safeName = original.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const relative = join('assets', kind, `${id}-${safeName}`);
        const target = join(project.rootPath, relative);
        await mkdir(join(project.rootPath, 'assets', kind), { recursive: true });
        await copyFile(sourcePath, target);
        const asset: Asset = {
          id,
          kind,
          name: original.slice(0, Math.max(1, original.length - extname(original).length)),
          sourcePath,
          projectPath: relative,
          tags: [],
          notes: '',
          createdAt: new Date().toISOString()
        };
        project.assets.push(asset);
      }
    });
  }

  applyParsedScenes(parsed: ParsedScene[]): Promise<FilmProject> {
    return this.mutate(project => {
      project.scenes = parsed.map((p, index): Scene => ({
        id: randomUUID(),
        index: index + 1,
        heading: p.heading,
        body: p.body,
        location: p.location,
        timeOfDay: p.timeOfDay,
        shotIds: []
      }));
      project.shots = [];
      project.timeline = [];
    });
  }

  addShot(sceneId: string): Promise<FilmProject> {
    return this.mutate(project => {
      const scene = project.scenes.find(s => s.id === sceneId);
      if (!scene) throw new Error('Scene not found.');
      const index = project.shots.filter(s => s.sceneId === sceneId).length + 1;
      const id = randomUUID();
      const base = MODEL_DEFAULTS[PRIMARY_VIDEO_MODEL];
      const shot: Shot = {
        id,
        sceneId,
        index,
        title: `Shot ${scene.index}.${index}`,
        prompt: scene.body,
        camera: '',
        action: '',
        dialogue: '',
        continuityNotes: '',
        characterAssetIds: [],
        propAssetIds: [],
        status: 'draft',
        generation: {
          modelFamily: PRIMARY_VIDEO_MODEL,
          mode: base.mode || 'flf2v',
          quality: base.quality || 'balanced',
          width: base.width || 768,
          height: base.height || 432,
          frames: base.frames || 121,
          fps: base.fps || 24,
          steps: base.steps,
          cfg: base.cfg,
          seed: Math.floor(Math.random() * 2_147_483_647),
          negativePrompt: '',
          includeAudio: base.includeAudio ?? true
        }
      };
      project.shots.push(shot);
      scene.shotIds.push(id);
    });
  }

  private validateStoragePaths(project: FilmProject): void {
    const root = resolve(project.rootPath);
    for (const asset of project.assets) {
      assertRelativeProjectPath(root, asset.projectPath, 'assets', `asset path for ${asset.name}`);
    }
    for (const profile of project.settings.workflowProfiles ?? []) {
      if (profile.workflowPath) assertPathInside(resolve(root, 'workflows'), profile.workflowPath, `workflow path for ${profile.name}`);
    }
    for (const output of project.renderOutputs ?? []) {
      if (output.path) assertPathInside(resolve(root, 'renders'), output.path, `render output path for ${output.filename}`);
    }
  }

  private async ensureFolders(rootPath: string): Promise<void> {
    await Promise.all([
      mkdir(join(rootPath, 'assets'), { recursive: true }),
      mkdir(join(rootPath, 'renders'), { recursive: true }),
      mkdir(join(rootPath, 'exports'), { recursive: true }),
      mkdir(join(rootPath, 'workflows'), { recursive: true }),
      mkdir(join(rootPath, 'cache'), { recursive: true }),
      mkdir(join(rootPath, 'handoff', 'capcut'), { recursive: true })
    ]);
  }
}
