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
import { writeCodexMachineContext } from './services/machine-context';
import { listWanGpCatalog, provisionRecommendedWanGpProfiles } from './services/wangp-catalog-service';

type Handler = (...args: any[]) => any;

let activeExportAbortController:AbortController|null=null;
let activeKeyframeAbortController:AbortController|null=null;
let activeExportPromise:Promise<unknown>|null=null;
let activeKeyframePromise:Promise<unknown>|null=null;
let activeHandoffPromise:Promise<unknown>|null=null;

export async function shutdownForegroundOperations():Promise<void>{
  activeExportAbortController?.abort();
  activeKeyframeAbortController?.abort();
  const pending=[activeExportPromise,activeKeyframePromise,activeHandoffPromise].filter((value):value is Promise<unknown>=>Boolean(value));
  if(pending.length)await Promise.allSettled(pending);
}

export function registerIpc(projects: ProjectService, queue: RenderQueueService, settings: AppSettingsService,trustedRendererUrl:string): void {
  let keyframeBusy = false;
  const handle = (channel: string, handler: Handler) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: any[]) => {
      assertTrustedIpcSender(event,trustedRendererUrl);
      return handler(...args);
    });
  };

  const assertProjectSwitchAllowed=()=>{if(queue.isBusy()||keyframeBusy||activeExportAbortController||activeHandoffPromise)throw new Error('Finish or cancel active renders, keyframe generation, timeline export, or CapCut handoff before switching projects.');};
  const assertGpuGenerationAvailable=()=>{if(keyframeBusy)throw new Error('A keyframe generation is already using the local generation runtime.');if(queue.isBusy())throw new Error('Finish or cancel the active render queue before generating a keyframe.');};

  handle(IPC.projectCreate, async (name?: string) => {
    assertProjectSwitchAllowed();
    const created=await projects.createWithDialog(name);
    if(created)await autoProvisionWanGpIfNeeded(projects,settings);
    return projects.getCurrent();
  });
  handle(IPC.projectOpen, async () => {
    assertProjectSwitchAllowed();
    const opened = await projects.openWithDialog();
    if (opened) {
      await autoProvisionWanGpIfNeeded(projects,settings);
      await queue.reconcileAfterProjectOpen();
    }
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
  handle(IPC.assetDelete, (assetId:string) => {
    if(queue.isBusy()||keyframeBusy||activeExportAbortController||activeHandoffPromise)throw new Error('Finish or cancel active generation/export/handoff before deleting project assets.');
    return projects.deleteAsset(assetId);
  });

  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsSave, async (next: AppMachineSettings) => {
    if (queue.isBusy()||keyframeBusy) throw new Error('Machine runtime settings cannot change while render jobs or keyframe generation are active.');
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
    return{path:target,...inspected,warnings:inspected.warnings};
  });

  handle(IPC.workflowInspect, async (path:string)=>{
    const project=requireProject(projects);
    const safe=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),path,'workflow path'),'workflow path');
    try{return await inspectWorkflow(safe);}catch{return inspectWanGpSettings(safe);}
  });
  handle(IPC.workflowValidate, (profileId:string) => validateAndRecordProfile(projects, settings.get(), profileId));
  handle(IPC.workflowWanGpCatalog, () => listWanGpCatalog(settings.get()));
  handle(IPC.workflowProvisionWanGp, () => provisionRecommendedWanGpProfiles(projects,settings));

  handle(IPC.systemProbe, async()=>{
    const project=projects.getCurrent()??undefined,machine=settings.get(),probe=await probeSystem(project,machine);
    if(project)probe.codexContextPath=await writeCodexMachineContext(project,machine,probe);
    return probe;
  });
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

  handle(IPC.renderEnqueue,(request:RenderRequest)=>{if(keyframeBusy)throw new Error('Wait for keyframe generation to finish before queueing a video render.');return queue.enqueue(request);});
  handle(IPC.renderEnqueueBatch,(request:RenderBatchRequest)=>{if(keyframeBusy)throw new Error('Wait for keyframe generation to finish before queueing video renders.');return queue.enqueueBatch(request);});
  handle(IPC.renderRetry,(jobId:string)=>{if(keyframeBusy)throw new Error('Wait for keyframe generation to finish before retrying a render.');return queue.retry(jobId);});
  handle(IPC.renderCancel,(jobId:string)=>queue.cancel(jobId));
  handle(IPC.renderSnapshot,()=>queue.snapshot());
  handle(IPC.renderOutputDelete,(outputId:string)=>{
    if(activeExportAbortController||activeHandoffPromise)throw new Error('Finish or cancel the active timeline export / CapCut handoff before deleting rendered takes.');
    return projects.deleteRenderOutput(outputId);
  });

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
  handle(IPC.keyframeGenerate,async(request:KeyframeRequest)=>{
    assertGpuGenerationAvailable();keyframeBusy=true;activeKeyframeAbortController=new AbortController();
    const task=generateKeyframe(projects,settings.get(),request,activeKeyframeAbortController.signal);activeKeyframePromise=task;
    try{return await task;}
    finally{keyframeBusy=false;activeKeyframeAbortController=null;activeKeyframePromise=null;}
  });
  handle(IPC.keyframeCancel,async()=>{
    if(!keyframeBusy||!activeKeyframeAbortController)return false;
    activeKeyframeAbortController.abort();
    return true;
  });
  handle(IPC.timelineExport,async()=>{
    if(activeExportAbortController)throw new Error('A timeline export is already running.');
    if(keyframeBusy)throw new Error('Wait for keyframe generation to finish before exporting the timeline.');
    activeExportAbortController=new AbortController();
    const task=exportTimeline(requireProject(projects),settings.get(),activeExportAbortController.signal);activeExportPromise=task;
    try{return{outputPath:await task};}
    finally{activeExportAbortController=null;activeExportPromise=null;}
  });
  handle(IPC.timelineCancelExport,async()=>{activeExportAbortController?.abort();});
  handle(IPC.capcutPrepareHandoff,async()=>{
    if(activeHandoffPromise)throw new Error('A CapCut handoff is already being prepared.');
    if(activeExportAbortController)throw new Error('Wait for the active timeline export to finish before preparing a CapCut handoff.');
    const task=prepareCapCutHandoff(requireProject(projects));activeHandoffPromise=task;
    try{return await task;}finally{activeHandoffPromise=null;}
  });

  queue.on('snapshot',snapshot=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send(IPC.queueEvent,snapshot);});
}

function requireProject(projects: ProjectService): FilmProject {
  const project=projects.getCurrent();
  if(!project)throw new Error('Open a project first.');
  return project;
}


async function autoProvisionWanGpIfNeeded(projects:ProjectService,settings:AppSettingsService):Promise<void>{
  const project=projects.getCurrent(),machine=settings.get();
  if(!project||machine.wangp.executionMode!=='native'||!machine.wangp.rootPath.trim())return;
  const usable=project.settings.workflowProfiles.some(profile=>profile.enabled&&profile.workflowPath&&profile.validation?.structuralStatus==='valid');
  if(usable)return;
  try{await provisionRecommendedWanGpProfiles(projects,settings);}
  catch(error){console.warn('Automatic WanGP profile provisioning was skipped:',error);}
}
