import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { dialog } from 'electron';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';
import type { AssetKind, FilmProject, ParsedScene, Scene, Shot } from '../../shared/types';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertPathInside, assertRelativeProjectPath, assertSafeWritePath, isPathInside } from './path-safety';
import { loadPortableProject, UnsupportedProjectSchemaError } from './project-schema';
import { preserveTrustedProfileValidation, shotProjectRenderInputKey } from '../../shared/shot-signature';
import { latestPassingVideoTake } from '../../shared/take-policy';
import { readJsonFileLimited } from './json-file';

const PROJECT_FILE = 'cineforge.project.json';
const PROJECT_BACKUP_FILE = 'cineforge.project.backup.json';
const ASSET_KINDS=new Set<AssetKind>(['character','location','prop','wardrobe','reference','keyframe','audio','video','image']);

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
    if(typeof name!=='string')throw new Error('Project name must be a string.');
    if(name.length>240)throw new Error('Project name exceeds the 240-character project safety limit.');
    const resolvedRoot=resolve(rootPath),projectFile=join(resolvedRoot,PROJECT_FILE);
    try{await stat(projectFile);throw new Error('This folder already contains a CineForge project. Use Open instead, or choose a new/empty folder.');}
    catch(error:any){if(error?.code!=='ENOENT')throw error;}
    try{
      const harmless=new Set(['.DS_Store','Thumbs.db','desktop.ini']);
      const existing=(await readdir(resolvedRoot)).filter(name=>!harmless.has(name));
      if(existing.length)throw new Error(`Choose an empty folder for a new CineForge project. “${resolvedRoot}” already contains ${existing.length} item(s).`);
    }catch(error:any){if(error?.code!=='ENOENT')throw error;}
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
    return this.openAt(result.filePaths[0]);
  }

  async openAt(rootPath:string):Promise<FilmProject>{
    const openedRoot = resolve(rootPath);
    const file = join(openedRoot, PROJECT_FILE);
    const backup = join(openedRoot, PROJECT_BACKUP_FILE);
    await this.assertProjectStateFileNotSymlink(file,'CineForge project file');
    await this.assertProjectStateFileNotSymlink(backup,'CineForge backup project file');
    let raw:unknown,loaded:ReturnType<typeof loadPortableProject>,recoveredFromBackup=false,primaryFailure:unknown;
    try{
      raw=await readJsonFileLimited(file,'CineForge project file',50*1024*1024);
      loaded=loadPortableProject(raw,openedRoot);
    }catch(primaryError){
      if(primaryError instanceof UnsupportedProjectSchemaError)throw primaryError;
      primaryFailure=primaryError;
      try{
        raw=await readJsonFileLimited(backup,'CineForge backup project file',50*1024*1024);
        loaded=loadPortableProject(raw,openedRoot);
        recoveredFromBackup=true;
      }catch(backupError){
        throw new Error(`CineForge project could not be loaded from primary or backup. Primary: ${primaryError instanceof Error?primaryError.message:String(primaryError)}. Backup: ${backupError instanceof Error?backupError.message:String(backupError)}`);
      }
    }

    const project=loaded.project;
    const storedRoot = typeof (raw as any)?.rootPath === 'string' ? resolve((raw as any).rootPath) : openedRoot;
    if (storedRoot !== openedRoot) this.rebasePortablePaths(project, storedRoot, openedRoot);

    let rejectedPrimaryPath:string|undefined;
    if(recoveredFromBackup)rejectedPrimaryPath=await this.preserveRejectedPrimary(openedRoot,file);
    await this.ensureFolders(project.rootPath);
    await this.validateStoragePaths(project);
    const committed=await this.persistUnlocked(project);
    if(recoveredFromBackup)console.warn(`Recovered CineForge project from backup after the primary project file failed validation.${rejectedPrimaryPath?` Rejected primary preserved at ${rejectedPrimaryPath}.`:''}`,primaryFailure);
    if (loaded.migrationNotes.length) console.warn(loaded.migrationNotes.join('\n'));
    return committed;
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
      const currentShots = new Map(this.current.shots.map(shot => [shot.id, shot]));
      for (const shot of incoming.shots) {
        const currentShot=currentShots.get(shot.id);
        if(!currentShot){
          shot.latestRenderId=undefined;
          shot.status=shot.status==='ready'?'ready':'draft';
          continue;
        }
        if(shotProjectRenderInputKey(incoming,shot)!==shotProjectRenderInputKey(this.current,currentShot)){
          shot.latestRenderId=undefined;
          shot.status=currentShot.status==='rendering'?'rendering':(['rendered','failed'].includes(currentShot.status)?'ready':currentShot.status);
        }else{
          shot.status=currentShot.status;
          shot.latestRenderId=currentShot.latestRenderId;
        }
      }
      const currentProfiles=new Map(this.current.settings.workflowProfiles.map(profile=>[profile.id,profile]));
      incoming.settings.workflowProfiles=incoming.settings.workflowProfiles.map(profile=>preserveTrustedProfileValidation(currentProfiles.get(profile.id),profile));
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
    if(!ASSET_KINDS.has(kind))throw new Error(`Invalid asset kind: ${String(kind)}`);
    if (!this.current) throw new Error('Open a project first.');
    if(this.current.assets.length>=100_000)throw new Error('Asset import would exceed the 100000-asset project safety limit.');
    const origin={id:this.current.id,rootPath:this.current.rootPath};
    const result = await dialog.showOpenDialog({ title: `Import ${kind}`, properties: ['openFile', 'multiSelections'], filters: assetImportFilters(kind) });
    if (result.canceled || result.filePaths.length === 0) return null;
    const copied:string[]=[];
    try{
      return await this.mutate(async project => {
        if(project.id!==origin.id||project.rootPath!==origin.rootPath)throw new Error('Project changed while the asset import dialog was open. Import was cancelled.');
        if(project.assets.length+result.filePaths.length>100_000)throw new Error('Asset import would exceed the 100000-asset project safety limit.');
        for (const sourcePath of result.filePaths) {
          const id = randomUUID();
          const original = basename(sourcePath);
          const safeName = original.replace(/[^a-zA-Z0-9._-]+/g, '_');
          const relativePath = join('assets', kind, `${id}-${safeName}`);
          const target = await assertSafeWritePath(join(project.rootPath,'assets'), join(project.rootPath,relativePath), 'asset import target');
          await mkdir(join(project.rootPath, 'assets', kind), { recursive: true });
          await copyFile(sourcePath, target);copied.push(target);
          project.assets.push({
            id, kind,
            name: original.slice(0, Math.max(1, original.length - extname(original).length)),
            sourcePath: original, projectPath: relativePath, tags: [], notes: '', createdAt: new Date().toISOString()
          });
        }
      });
    }catch(error){
      for(const path of copied)await rm(path,{force:true}).catch(cleanupError=>console.warn(`Could not remove rolled-back asset import: ${path}`,cleanupError));
      throw error;
    }
  }

  async deleteAsset(assetId:string):Promise<FilmProject>{
    const current=this.current;if(!current)throw new Error('Open a project first.');
    const asset=current.assets.find(item=>item.id===assetId);if(!asset)throw new Error('Asset not found.');
    const origin={id:current.id,rootPath:current.rootPath};
    let absolute:string|undefined;
    try{absolute=await assertExistingRelativeProjectPath(current.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);}
    catch(error:any){if(error?.code!=='ENOENT')throw error;}
    const updated=await this.mutate(project=>{
      if(project.id!==origin.id||project.rootPath!==origin.rootPath)throw new Error('Project changed while deleting the asset. Delete was cancelled.');
      const before=new Map(project.shots.map(shot=>[shot.id,shotProjectRenderInputKey(project,shot)]));
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
        if(before.get(shot.id)!==shotProjectRenderInputKey(project,shot)){shot.latestRenderId=undefined;if(['rendered','failed'].includes(shot.status))shot.status='ready';}
      }
    });
    if(absolute)await rm(absolute,{force:true}).catch(error=>console.warn(`Could not delete asset file after removing it from the project: ${absolute}`,error));
    return updated;
  }

  async deleteRenderOutput(outputId:string):Promise<FilmProject>{
    const current=this.current;if(!current)throw new Error('Open a project first.');
    const output=current.renderOutputs.find(item=>item.id===outputId);if(!output)throw new Error('Render output not found.');
    const origin={id:current.id,rootPath:current.rootPath};
    const duplicatePath=current.renderOutputs.some(item=>item.id!==outputId&&resolve(item.path)===resolve(output.path));
    let absolute:string|undefined;
    if(!duplicatePath){
      try{absolute=await assertExistingPathInside(join(current.rootPath,'renders'),output.path,'render output');}
      catch(error:any){if(error?.code!=='ENOENT')throw error;}
    }
    const updated=await this.mutate(project=>{
      if(project.id!==origin.id||project.rootPath!==origin.rootPath)throw new Error('Project changed while deleting the render output. Delete was cancelled.');
      project.renderOutputs=project.renderOutputs.filter(item=>item.id!==outputId);
      for(const job of project.renderJobs)job.outputs=job.outputs.filter(item=>item.id!==outputId);
      project.timeline=project.timeline.filter(clip=>clip.renderOutputId!==outputId);
      const shot=project.shots.find(item=>item.id===output.shotId);
      if(shot?.latestRenderId===outputId){
        const fallback=latestPassingVideoTake(project.renderOutputs.filter(item=>item.shotId===shot.id));
        shot.latestRenderId=fallback?.id;
        if(!fallback&&shot.status==='rendered')shot.status='ready';
      }
    });
    if(absolute)await rm(absolute,{force:true}).catch(error=>console.warn(`Could not delete render output file after removing it from the project: ${absolute}`,error));
    return updated;
  }

  applyParsedScenes(parsed: ParsedScene[]): Promise<FilmProject> {
    return this.mutate(project => {
      project.scenes = parsed.map((p, index): Scene => ({
        id: randomUUID(), index: index + 1, heading: p.heading, body: p.body, location: p.location, timeOfDay: p.timeOfDay, shotIds: []
      }));
      project.shots = [];
      project.renderJobs = [];
      project.renderOutputs = [];
      project.timeline = [];
    });
  }

  addShot(sceneId: string): Promise<FilmProject> {
    return this.mutate(project => {
      const scene = project.scenes.find(s => s.id === sceneId);
      if (!scene) throw new Error('Scene not found.');
      if(scene.body.length>200_000)throw new Error('Scene body exceeds the 200000-character shot prompt safety limit. Shorten or split the scene before creating a shot from it.');
      if(project.shots.length>=100_000)throw new Error('Adding a shot would exceed the 100000-shot project safety limit.');
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

  private async preserveRejectedPrimary(rootPath:string,projectFile:string):Promise<string|undefined>{
    try{
      await this.assertProjectStateFileNotSymlink(projectFile,'Rejected CineForge project file');
      await stat(projectFile);
    }catch(error:any){
      if(error?.code==='ENOENT')return undefined;
      throw new Error(`CineForge found a usable backup but could not safely preserve the rejected primary project before recovery: ${error instanceof Error?error.message:String(error)}`);
    }
    const target=await assertSafeWritePath(rootPath,join(rootPath,`cineforge.project.rejected-${Date.now()}-${randomUUID()}.json`),'rejected CineForge project preservation');
    try{await copyFile(projectFile,target);return target;}
    catch(error){throw new Error(`CineForge found a usable backup but refused to overwrite the rejected primary because preserving it failed: ${error instanceof Error?error.message:String(error)}`);}
  }

  private async persistUnlocked(project: FilmProject): Promise<FilmProject> {
    project.updatedAt = new Date().toISOString();
    await this.ensureFolders(project.rootPath);
    const serializable = structuredClone(project);
    const projectFile = join(project.rootPath, PROJECT_FILE);
    const backupFile = join(project.rootPath, PROJECT_BACKUP_FILE);
    const tempFile = join(project.rootPath, `.${PROJECT_FILE}.${randomUUID()}.tmp`);
    await this.assertProjectStateFileNotSymlink(projectFile,'CineForge project file');
    await this.assertProjectStateFileNotSymlink(backupFile,'CineForge backup project file');
    const payload = JSON.stringify(serializable, null, 2);
    const previous=this.current&&this.current.id===project.id&&this.current.rootPath===project.rootPath?structuredClone(this.current):undefined;
    if(previous){
      const backupPayload=JSON.stringify(previous,null,2);
      try{await writeFile(backupFile,backupPayload,{encoding:'utf8',mode:0o600});}
      catch(error){throw new Error(`Could not create trusted project backup before saving: ${error instanceof Error?error.message:String(error)}`);}
    }else{
      try{await writeFile(backupFile,payload,{encoding:'utf8',mode:0o600});}
      catch(error){throw new Error(`Could not initialize or repair trusted project backup: ${error instanceof Error?error.message:String(error)}`);}
    }
    await writeFile(tempFile, payload, {encoding:'utf8',flag:'wx'});
    try { await rename(tempFile, projectFile); }
    catch (error: any) {
      if (!['EEXIST','EPERM','EACCES'].includes(error?.code)){await rm(tempFile,{force:true}).catch(()=>undefined);throw error;}
      try{await this.assertProjectStateFileNotSymlink(projectFile,'CineForge project file');await writeFile(projectFile, payload, 'utf8');}
      finally{await rm(tempFile, { force: true }).catch(() => undefined);}
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

  private async assertProjectStateFileNotSymlink(path:string,label:string):Promise<void>{
    try{
      const info=await lstat(path);
      if(info.isSymbolicLink())throw new Error(`${label} must not be a symbolic link.`);
      if(!info.isFile())throw new Error(`${label} is not a regular file.`);
    }catch(error:any){if(error?.code!=='ENOENT')throw error;}
  }

  private async ensureFolders(rootPath: string): Promise<void> {
    await mkdir(rootPath,{recursive:true});
    const managed=[
      'assets','renders','exports','workflows','cache',
      join('handoff','capcut'),'.cineforge',join('.cineforge','jobs'),join('.cineforge','logs')
    ];
    for(const relativePath of managed){
      const candidate=join(rootPath,relativePath);
      const safe=await assertSafeWritePath(rootPath,candidate,`managed project directory ${relativePath}`);
      await mkdir(safe,{recursive:true});
      await assertExistingPathInside(rootPath,safe,`managed project directory ${relativePath}`);
    }
    const cineforgeDir=await assertExistingPathInside(rootPath,join(rootPath,'.cineforge'),'CineForge metadata directory');
    const gitignore=await assertSafeWritePath(cineforgeDir,join(cineforgeDir,'.gitignore'),'CineForge metadata gitignore');
    try{await writeFile(gitignore,'*\n!.gitignore\n',{encoding:'utf8',flag:'wx'});}
    catch(error:any){if(error?.code!=='EEXIST')throw error;}
  }
}


function assetImportFilters(kind:AssetKind):Array<{name:string;extensions:string[]}>{
  if(kind==='video')return[{name:'Video',extensions:['mp4','mov','webm','mkv','avi']}];
  if(kind==='audio')return[{name:'Audio',extensions:['wav','mp3','flac','m4a','aac','ogg']}];
  return[{name:'Images',extensions:['png','jpg','jpeg','webp','bmp']}];
}
