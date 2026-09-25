import { basename, join } from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { AppMachineSettings, AssetKind, FilmProject, KeyframeRequest, RenderBatchRequest, RenderRequest } from '../shared/types';
import { AppSettingsService } from './services/app-settings-service';
import { ProjectService } from './services/project-service';
import { parseScreenplay } from './services/script-parser';
import { detectWorkflowFormat, inspectWorkflow, readWorkflow, suggestBindings, uiWorkflowToApi } from './services/workflow-engine';
import { inspectWanGpSettings } from './services/wangp-engine';
import { probeSystem } from './services/system-probe';
import { ComfyClient } from './services/comfy-client';
import { RenderQueueService } from './services/render-queue';
import { exportTimeline } from './services/ffmpeg-service';
import { planSceneWithLocalDirector, reviewShotWithLocalDirector } from './services/director-service';
import { generateKeyframe } from './services/keyframe-service';
import { preflightProject } from './services/preflight-service';
import { assertExistingPathInside, assertPathInside, assertSafeWritePath } from './services/path-safety';
import { prepareCapCutHandoff } from './services/capcut-handoff';
import { assertTrustedIpcSender } from './services/ipc-security';
import { validateAndRecordProfile } from './services/profile-validation';

type Handler = (...args: any[]) => any;

export function registerIpc(projects: ProjectService, queue: RenderQueueService, settings: AppSettingsService): void {
  const handle = (channel: string, handler: Handler) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: any[]) => {
      assertTrustedIpcSender(event);
      return handler(...args);
    });
  };

  handle(IPC.projectCreate, async (name?: string) => {
    if (queue.isBusy()) throw new Error('Finish or cancel the active render queue before switching projects.');
    return projects.createWithDialog(name);
  });
  handle(IPC.projectOpen, async () => {
    if (queue.isBusy()) throw new Error('Finish or cancel the active render queue before switching projects.');
    const opened = await projects.openWithDialog();
    if (opened) await queue.reconcileAfterProjectOpen();
    return projects.getCurrent();
  });
  handle(IPC.projectSave, (project: FilmProject) => projects.saveFromRenderer(project));
  handle(IPC.projectGet, () => projects.getCurrent());
  handle(IPC.projectParseScript, (script: string) => parseScreenplay(script));
  handle(IPC.projectPreflight, async () => {
    const project = requireProject(projects);
    return preflightProject(project, settings.get());
  });
  handle(IPC.assetImport, (kind: AssetKind) => projects.importAsset(kind));

  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsSave, async (next: AppMachineSettings) => {
    if (queue.isBusy()) throw new Error('Machine runtime settings cannot change while render jobs are active.');
    return settings.save(next);
  });

  handle(IPC.workflowImportComfy, async () => {
    const project = requireProject(projects);
    const result = await dialog.showOpenDialog({ title: 'Import ComfyUI workflow JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const source=result.filePaths[0];
    const target=await assertSafeWritePath(join(project.rootPath,'workflows'),join(project.rootPath,'workflows',`${Date.now()}-${basename(source)}`),'workflow import target');
    await copyFile(source,target);
    const rawWorkflow=await readWorkflow(target);
    const format=detectWorkflowFormat(rawWorkflow);
    if(format==='api'){const inspected=await inspectWorkflow(target);return{path:target,...inspected,warnings:[]};}
    const machine=settings.get();
    const client=new ComfyClient(machine.comfy.url,true);
    const ping=await client.ping();
    if(!ping.reachable)return{path:target,format:'ui' as const,suggestedBindings:[],warnings:[`ComfyUI is offline, so UI workflow conversion could not run: ${ping.error||'unknown error'}`]};
    const converted=uiWorkflowToApi(rawWorkflow,await client.objectInfo());
    if(converted.requiresApiExport)return{path:target,format:'ui' as const,suggestedBindings:[],warnings:[...converted.warnings,'CineForge refused to create a partial API graph. Load it in ComfyUI, Save (API Format), and import that JSON.']};
    const apiPath=await assertSafeWritePath(join(project.rootPath,'workflows'),target.replace(/\.json$/i,'.api.json'),'converted workflow');
    await writeFile(apiPath,JSON.stringify(converted.workflow,null,2),'utf8');
    return{path:apiPath,format:'api' as const,suggestedBindings:suggestBindings(converted.workflow),warnings:converted.warnings};
  });

  handle(IPC.workflowImportWanGp, async () => {
    const project=requireProject(projects);
    const result=await dialog.showOpenDialog({title:'Import WanGP exported settings JSON',properties:['openFile'],filters:[{name:'WanGP settings',extensions:['json']}]});
    if(result.canceled||!result.filePaths[0])return null;
    const source=result.filePaths[0];
    const target=await assertSafeWritePath(join(project.rootPath,'workflows'),join(project.rootPath,'workflows',`${Date.now()}-wangp-${basename(source)}`),'WanGP settings import');
    await copyFile(source,target);
    const inspected=await inspectWanGpSettings(target);
    return{path:target,...inspected,warnings:['WanGP settings are version/model specific. Review ambiguous bindings and validate the profile before production rendering.']};
  });

  handle(IPC.workflowInspect, async (path:string)=>{
    const project=requireProject(projects);
    const safe=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),path,'workflow path'),'workflow path');
    try{return await inspectWorkflow(safe);}catch{return inspectWanGpSettings(safe);}
  });
  handle(IPC.workflowValidate, (profileId:string) => validateAndRecordProfile(projects, settings.get(), profileId));

  handle(IPC.systemProbe, async()=>probeSystem(requireProject(projects),settings.get()));
  handle(IPC.comfyPing, async(url?:string)=>{
    const machine=settings.get();
    const target=url||machine.comfy.url;
    return new ComfyClient(target,true).ping();
  });
  handle(IPC.systemReveal,async(path:string)=>{
    const project=requireProject(projects);
    const safe=await assertExistingPathInside(project.rootPath,path,'reveal path');
    shell.showItemInFolder(safe);
  });

  handle(IPC.renderEnqueue,(request:RenderRequest)=>queue.enqueue(request));
  handle(IPC.renderEnqueueBatch,(request:RenderBatchRequest)=>queue.enqueueBatch(request));
  handle(IPC.renderRetry,(jobId:string)=>queue.retry(jobId));
  handle(IPC.renderCancel,(jobId:string)=>queue.cancel(jobId));
  handle(IPC.renderSnapshot,()=>queue.snapshot());

  handle(IPC.directorPlanScene,async(sceneId:string)=>{
    const project=requireProject(projects);
    const scene=project.scenes.find(s=>s.id===sceneId);
    if(!scene)throw new Error('Scene not found.');
    return planSceneWithLocalDirector(project,scene,settings.get());
  });
  handle(IPC.directorReviewShot,async(shotId:string)=>{
    const project=requireProject(projects);
    const shot=project.shots.find(s=>s.id===shotId);
    if(!shot)throw new Error('Shot not found.');
    return reviewShotWithLocalDirector(project,shot,settings.get());
  });
  handle(IPC.keyframeGenerate,(request:KeyframeRequest)=>generateKeyframe(projects,settings.get(),request));
  handle(IPC.timelineExport,async()=>({outputPath:await exportTimeline(requireProject(projects),settings.get())}));
  handle(IPC.capcutPrepareHandoff,async()=>prepareCapCutHandoff(requireProject(projects)));

  queue.on('snapshot',snapshot=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send(IPC.queueEvent,snapshot);});
}

function requireProject(projects: ProjectService): FilmProject {
  const project=projects.getCurrent();
  if(!project)throw new Error('Open a project first.');
  return project;
}
