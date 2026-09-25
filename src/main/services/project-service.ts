import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { dialog } from 'electron';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';
import type { AssetKind, FilmProject, ParsedScene, Scene, Shot } from '../../shared/types';
import { assertExistingPathInside, assertPathInside, assertRelativeProjectPath, assertSafeWritePath, isPathInside } from './path-safety';
import { loadPortableProject } from './project-schema';

const PROJECT_FILE = 'cineforge.project.json';
const PROJECT_BACKUP_FILE = 'cineforge.project.backup.json';

export class ProjectService {
  private current: FilmProject | null = null;
  private gate: Promise<void> = Promise.resolve();

  getCurrent(): FilmProject | null { return this.current ? structuredClone(this.current) : null; }

  async createWithDialog(name = 'Untitled Film'): Promise<FilmProject | null> {
    const result = await dialog.showOpenDialog({ title: 'Choose a folder for the new CineForge project', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return this.createAt(result.filePaths[0], name);
  }

  async createAt(rootPath: string, name: string): Promise<FilmProject> {
    const resolvedRoot=resolve(rootPath),projectFile=join(resolvedRoot,PROJECT_FILE);
    try{await stat(projectFile);throw new Error('This folder already contains a CineForge project. Use Open instead, or choose a new/empty folder.');}
    catch(error:any){if(error?.code!=='ENOENT')throw error;}
    await this.ensureFolders(resolvedRoot);
    const now = new Date().toISOString();
    const project: FilmProject = {
      schemaVersion: 2,
      id: randomUUID(),
      name,
      rootPath: resolvedRoot,
      createdAt: now,
      updatedAt: now,
      story: { title: name, logline: '', script: '', notes: '' },
      scenes: [], assets: [], shots: [], renderJobs: [], renderOutputs: [], timeline: [],
      settings: {
        costPolicy: { mode: 'codex-capcut-only', allowCapcutAiCredits: false },
        capcut: { enabled: true, pro: false },
        defaultFps: 24,
        outputContainer: 'mp4',
        workflowProfiles: structuredClone(BUILTIN_WORKFLOW_PROFILES)
      }
    };
    await this.persistUnlocked(project);
    return structuredClone(project);
  }

  async openWithDialog(): Promise<FilmProject | null> {
    const result = await dialog.showOpenDialog({ title: 'Open CineForge project folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const openedRoot = resolve(result.filePaths[0]);
    const file = join(openedRoot, PROJECT_FILE);
    const backup = join(openedRoot, PROJECT_BACKUP_FILE);
    let raw: unknown;
    try {
      const info=await stat(file);
      if(info.size>50*1024*1024)throw new Error('Project file exceeds the 50 MB safety limit.');
      raw = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (primaryError) {
      try {
        const backupInfo=await stat(backup);
        if(backupInfo.size>50*1024*1024)throw new Error('Backup project file exceeds the 50 MB safety limit.');
        raw = JSON.parse(await readFile(backup, 'utf8'));
        await copyFile(backup, file);
        console.warn('Recovered CineForge project from backup after the primary project file could not be parsed.', primaryError);
      } catch { throw primaryError; }
    }

    const loaded = loadPortableProject(raw, openedRoot);
    const project = loaded.project;
    const storedRoot = typeof (raw as any)?.rootPath === 'string' ? resolve((raw as any).rootPath) : openedRoot;
    if (storedRoot !== openedRoot) this.rebasePortablePaths(project, storedRoot, openedRoot);

    await this.ensureFolders(project.rootPath);
    await this.validateStoragePaths(project);
    this.current = project;
    await this.persistUnlocked(project);
    if (loaded.migrationNotes.length) console.warn(loaded.migrationNotes.join('\n'));
    return structuredClone(project);
  }

  async saveFromRenderer(project: FilmProject): Promise<FilmProject> {
    return this.runExclusive(async () => {
      if (!this.current) throw new Error('No project is open.');
      const candidate=structuredClone(project);
      const proposedShotIds=new Set(Array.isArray(candidate.shots)?candidate.shots.map(shot=>shot?.id).filter((id):id is string=>typeof id==='string'):[]);
      candidate.renderJobs=this.current.renderJobs.filter(job=>proposedShotIds.has(job.shotId));
      candidate.renderOutputs=this.current.renderOutputs.filter(output=>proposedShotIds.has(output.shotId));
      const incoming = loadPortableProject(candidate, this.current.rootPath).project;
      if (incoming.id !== this.current.id) throw new Error('Renderer project does not match the open main-process project.');
      incoming.rootPath = this.current.rootPath;
      incoming.createdAt = this.current.createdAt;

      const editedAssets = new Map(incoming.assets.map(asset => [asset.id, asset]));
      incoming.assets = this.current.assets.map(original => {
        const edited = editedAssets.get(original.id);
        return edited ? { ...structuredClone(original), name: edited.name, tags: [...edited.tags], notes: edited.notes } : structuredClone(original);
      });
      const runtime = new Map(this.current.shots.map(shot => [shot.id, { status: shot.status, latestRenderId: shot.latestRenderId }]));
      for (const shot of incoming.shots) {
        const state = runtime.get(shot.id);
        if (state) { shot.status = state.status; shot.latestRenderId = state.latestRenderId; }
      }
      const currentProfiles=new Map(this.current.settings.workflowProfiles.map(profile=>[profile.id,profile]));
      incoming.settings.workflowProfiles=incoming.settings.workflowProfiles.map(profile=>{
        const current=currentProfiles.get(profile.id);if(!current)return profile;
        if(profileConfigKey(profile)!==profileConfigKey(current))return profile;
        return{...profile,validation:structuredClone(current.validation)};
      });
      await this.validateStoragePaths(incoming);
      return this.persistUnlocked(incoming);
    });
  }

  async mutate(mutator: (project: FilmProject) => void | Promise<void>): Promise<FilmProject> {
    return this.runExclusive(async () => {
      if (!this.current) throw new Error('No project is open.');
      const copy = structuredClone(this.current);
      await mutator(copy);
      await this.validateStoragePaths(copy);
      return this.persistUnlocked(copy);
    });
  }

  async importAsset(kind: AssetKind): Promise<FilmProject | null> {
    if (!this.current) throw new Error('Open a project first.');
    const result = await dialog.showOpenDialog({ title: `Import ${kind}`, properties: ['openFile', 'multiSelections'], filters: assetImportFilters(kind) });
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.mutate(async project => {
      for (const sourcePath of result.filePaths) {
        const id = randomUUID();
        const original = basename(sourcePath);
        const safeName = original.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const relativePath = join('assets', kind, `${id}-${safeName}`);
        const target = await assertSafeWritePath(join(project.rootPath,'assets'), join(project.rootPath,relativePath), 'asset import target');
        await mkdir(join(project.rootPath, 'assets', kind), { recursive: true });
        await copyFile(sourcePath, target);
        project.assets.push({
          id, kind,
          name: original.slice(0, Math.max(1, original.length - extname(original).length)),
          sourcePath: original, projectPath: relativePath, tags: [], notes: '', createdAt: new Date().toISOString()
        });
      }
    });
  }

  async deleteAsset(assetId:string):Promise<FilmProject>{
    const current=this.current;if(!current)throw new Error('Open a project first.');
    const asset=current.assets.find(item=>item.id===assetId);if(!asset)throw new Error('Asset not found.');
    const absolute=await assertExistingRelativeProjectPath(current.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`).catch(()=>undefined);
    const updated=await this.mutate(project=>{
      project.assets=project.assets.filter(item=>item.id!==assetId);
      for(const shot of project.shots){
        shot.characterAssetIds=shot.characterAssetIds.filter(id=>id!==assetId);
        shot.propAssetIds=shot.propAssetIds.filter(id=>id!==assetId);
        shot.referenceAssetIds=(shot.referenceAssetIds??[]).filter(id=>id!==assetId);
        if(shot.locationAssetId===assetId)shot.locationAssetId=undefined;
        if(shot.startFrameAssetId===assetId)shot.startFrameAssetId=undefined;
        if(shot.endFrameAssetId===assetId)shot.endFrameAssetId=undefined;
        if(shot.referenceVideoAssetId===assetId)shot.referenceVideoAssetId=undefined;
        if(shot.audioAssetId===assetId)shot.audioAssetId=undefined;
      }
    });
    if(absolute)await rm(absolute,{force:true}).catch(error=>console.warn(`Could not delete asset file after removing it from the project: ${absolute}`,error));
    return updated;
  }

  applyParsedScenes(parsed: ParsedScene[]): Promise<FilmProject> {
    return this.mutate(project => {
      project.scenes = parsed.map((p, index): Scene => ({
        id: randomUUID(), index: index + 1, heading: p.heading, body: p.body, location: p.location, timeOfDay: p.timeOfDay, shotIds: []
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
        id, sceneId, index, title: `Shot ${scene.index}.${index}`, prompt: scene.body, camera: '', action: '', dialogue: '', continuityNotes: '',
        characterAssetIds: [], propAssetIds: [], referenceAssetIds: [], status: 'draft',
        generation: {
          modelFamily: PRIMARY_VIDEO_MODEL, mode: base.mode || 'i2v', quality: base.quality || 'balanced',
          width: base.width || 768, height: base.height || 432, frames: base.frames || 121, fps: base.fps || 24,
          steps: base.steps, cfg: base.cfg, seed: Math.floor(Math.random() * 2_147_483_647), negativePrompt: '', includeAudio: base.includeAudio ?? true
        }
      };
      project.shots.push(shot);
      scene.shotIds.push(id);
    });
  }

  private rebasePortablePaths(project: FilmProject, storedRoot: string, openedRoot: string): void {
    for (const profile of project.settings.workflowProfiles) {
      if (profile.workflowPath && isPathInside(resolve(storedRoot, 'workflows'), profile.workflowPath)) {
        profile.workflowPath = join(openedRoot, relative(storedRoot, profile.workflowPath));
      }
    }
    for (const output of project.renderOutputs) {
      if (output.path && isPathInside(resolve(storedRoot, 'renders'), output.path)) output.path = join(openedRoot, relative(storedRoot, output.path));
    }
    for (const job of project.renderJobs) {
      const path = job.spec?.workflowProfile.workflowPath;
      if (path && isPathInside(resolve(storedRoot,'workflows'),path)) job.spec!.workflowProfile.workflowPath = join(openedRoot, relative(storedRoot,path));
    }
  }

  private async validateStoragePaths(project: FilmProject): Promise<void> {
    const root = resolve(project.rootPath);
    for (const asset of project.assets) {
      const lexical = assertRelativeProjectPath(root, asset.projectPath, 'assets', `asset path for ${asset.name}`);
      try { await assertExistingPathInside(resolve(root,'assets'), lexical, `asset path for ${asset.name}`); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    for (const profile of project.settings.workflowProfiles) {
      if (!profile.workflowPath) continue;
      const lexical = assertPathInside(resolve(root,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`);
      try { await assertExistingPathInside(resolve(root,'workflows'),lexical,`workflow path for ${profile.name}`); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    for (const output of project.renderOutputs) {
      if (!output.path) continue;
      const lexical = assertPathInside(resolve(root,'renders'),output.path,`render output path for ${output.filename}`);
      try { await assertExistingPathInside(resolve(root,'renders'),lexical,`render output path for ${output.filename}`); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    for (const job of project.renderJobs) {
      const snapshotPath=job.spec?.workflowProfile.workflowPath;
      if(!snapshotPath)continue;
      const lexical=assertPathInside(resolve(root,'workflows'),snapshotPath,`job workflow path for ${job.id}`);
      try{await assertExistingPathInside(resolve(root,'workflows'),lexical,`job workflow path for ${job.id}`);}
      catch(error:any){if(error?.code!=='ENOENT')throw error;}
    }
  }

  private async persistUnlocked(project: FilmProject): Promise<FilmProject> {
    project.updatedAt = new Date().toISOString();
    await this.ensureFolders(project.rootPath);
    const serializable = structuredClone(project);
    const projectFile = join(project.rootPath, PROJECT_FILE);
    const backupFile = join(project.rootPath, PROJECT_BACKUP_FILE);
    const tempFile = join(project.rootPath, `.${PROJECT_FILE}.${process.pid}.tmp`);
    const payload = JSON.stringify(serializable, null, 2);
    try { await copyFile(projectFile, backupFile); } catch {}
    await writeFile(tempFile, payload, 'utf8');
    try { await rename(tempFile, projectFile); }
    catch (error: any) {
      if (!['EEXIST','EPERM','EACCES'].includes(error?.code)) throw error;
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

  private async ensureFolders(rootPath: string): Promise<void> {
    await Promise.all([
      mkdir(join(rootPath,'assets'),{recursive:true}), mkdir(join(rootPath,'renders'),{recursive:true}),
      mkdir(join(rootPath,'exports'),{recursive:true}), mkdir(join(rootPath,'workflows'),{recursive:true}),
      mkdir(join(rootPath,'cache'),{recursive:true}), mkdir(join(rootPath,'handoff','capcut'),{recursive:true}),
      mkdir(join(rootPath,'.cineforge','jobs'),{recursive:true}), mkdir(join(rootPath,'.cineforge','logs'),{recursive:true})
    ]);
    try{await writeFile(join(rootPath,'.cineforge','.gitignore'),'*\n!.gitignore\n',{encoding:'utf8',flag:'wx'});}
    catch(error:any){if(error?.code!=='EEXIST')throw error;}
  }
}

function profileConfigKey(profile:FilmProject['settings']['workflowProfiles'][number]):string{
  return JSON.stringify({
    runtime:profile.runtime,purpose:profile.purpose,name:profile.name,modelFamily:profile.modelFamily,mode:profile.mode,
    workflowPath:profile.workflowPath,workflowFormat:profile.workflowFormat,bindings:profile.bindings,enabled:profile.enabled,
    notes:profile.notes,modelFingerprint:profile.modelFingerprint
  });
}

function assetImportFilters(kind:AssetKind):Array<{name:string;extensions:string[]}>{
  if(kind==='video')return[{name:'Video',extensions:['mp4','mov','webm','mkv','avi']}];
  if(kind==='audio')return[{name:'Audio',extensions:['wav','mp3','flac','m4a','aac','ogg']}];
  return[{name:'Images',extensions:['png','jpg','jpeg','webp','bmp']}];
}
