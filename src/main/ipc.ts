import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { AppMachineSettings, AssetKind, FilmProject, KeyframeRequest, RenderBatchRequest, RenderRequest } from '../shared/types';
import { removedActiveRenderShotIds } from '../shared/project-guards';
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
import type { KeyframeLeaseStore } from './services/keyframe-lease';
import { listWanGpCatalog, provisionRecommendedWanGpProfiles } from './services/wangp-catalog-service';

type Handler = (...args: any[]) => any;

let activeExportAbortController:AbortController|null=null;
let activeKeyframeAbortController:AbortController|null=null;
let activeExportPromise:Promise<unknown>|null=null;
let activeKeyframePromise:Promise<unknown>|null=null;
let activeDirectorPromise:Promise<unknown>|null=null;
let activeWorkflowMaintenancePromise:Promise<unknown>|null=null;
let activeHandoffPromise:Promise<unknown>|null=null;
let activeProjectFileOperations=0;

export async function shutdownForegroundOperations():Promise<void>{
  activeExportAbortController?.abort();
  activeKeyframeAbortController?.abort();
  const pending=[activeExportPromise,activeKeyframePromise,activeDirectorPromise,activeWorkflowMaintenancePromise,activeHandoffPromise].filter((value):value is Promise<unknown>=>Boolean(value));
  if(pending.length)await Promise.allSettled(pending);
}

export function registerIpc(projects: ProjectService, queue: RenderQueueService, settings: AppSettingsService,keyframeLeases:KeyframeLeaseStore,trustedRendererUrl:string): void {
  let keyframeBusy = false;
  let directorBusy = false;
  let workflowValidationBusy = false;
  let projectSwitchBusy = false;
  const handle = (channel: string, handler: Handler) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: any[]) => {
      assertTrustedIpcSender(event,trustedRendererUrl);
      return handler(...args);
    });
  };

  const assertProjectStable=()=>{if(projectSwitchBusy)throw new Error('Wait for the current project open/create operation to finish.');};
  const assertProjectSwitchAllowed=()=>{if(projectSwitchBusy||activeProjectFileOperations>0||queue.isBusy()||keyframeBusy||directorBusy||workflowValidationBusy||activeExportAbortController||activeHandoffPromise)throw new Error('Finish the current project file operation/switch or cancel active renders, local Director work, keyframe generation, workflow validation/provisioning, timeline export, or CapCut handoff before switching projects.');};
  const assertGpuGenerationAvailable=()=>{assertProjectStable();if(activeExportAbortController)throw new Error('Wait for the GPU-assisted timeline export to finish or cancel it before starting generation.');if(workflowValidationBusy)throw new Error('Wait for workflow validation/provisioning to finish before starting GPU generation.');if(directorBusy)throw new Error('Wait for the local Director request to finish before starting keyframe generation.');if(keyframeBusy)throw new Error('A keyframe generation is already using the local generation runtime.');if(queue.isBusy())throw new Error('Finish or cancel the active render queue before generating a keyframe.');};
  const assertDirectorAvailable=()=>{assertProjectStable();if(activeExportAbortController)throw new Error('Wait for the timeline export to finish or cancel it before using the local Director.');if(workflowValidationBusy)throw new Error('Wait for workflow validation/provisioning to finish before using the local Director.');if(directorBusy)throw new Error('A local Director request is already running.');if(keyframeBusy)throw new Error('Wait for keyframe generation to finish before using the local Director.');if(queue.isBusy())throw new Error('Finish or cancel the active render queue before using the local Director on this GPU workstation.');};
  const assertWorkflowMaintenanceAvailable=()=>{assertProjectStable();if(activeExportAbortController||queue.isBusy()||keyframeBusy||directorBusy)throw new Error('Finish or cancel active timeline export, render, keyframe, or Director work before validating or provisioning workflow profiles.');};
  const withWorkflowValidationLock=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    if(workflowValidationBusy)throw new Error('A workflow validation/provisioning task is already running.');
    workflowValidationBusy=true;const task=operation();activeWorkflowMaintenancePromise=task;
    try{return await task;}finally{workflowValidationBusy=false;activeWorkflowMaintenancePromise=null;}
  };
  const withProjectSwitchLock=async<T>(operation:()=>Promise<T>):Promise<T>=>{assertProjectSwitchAllowed();projectSwitchBusy=true;try{return await operation();}finally{projectSwitchBusy=false;}};
  const withProjectFileOperation=async<T>(operation:()=>Promise<T>):Promise<T>=>{assertProjectStable();activeProjectFileOperations+=1;try{return await operation();}finally{activeProjectFileOperations=Math.max(0,activeProjectFileOperations-1);}};
  const runPostSwitchStep=async(operation:()=>Promise<unknown>):Promise<string|undefined>=>{try{await operation();return undefined;}catch(error){const message=error instanceof Error?error.message:String(error);console.warn('Post-switch project task failed:',message);return message;}};
  const showPostSwitchWarning=(label:string,message:string)=>{void dialog.showMessageBox({type:'warning',title:'CineForge project warning',message:`Project opened, but ${label} did not complete.`,detail:`${message}\n\nReview System / Preflight before rendering.`}).catch(()=>undefined);};

  handle(IPC.projectCreate, (name?: string) => withProjectSwitchLock(async()=>{
    const created=await projects.createWithDialog(name);
    if(created){
      const provisionWarning=await runPostSwitchStep(()=>withWorkflowValidationLock(()=>autoProvisionWanGpIfNeeded(projects,settings)));if(provisionWarning){console.warn('WanGP auto-provision warning:',provisionWarning);showPostSwitchWarning('WanGP auto-provisioning',provisionWarning);}
      const queueWarning=await runPostSwitchStep(()=>queue.reconcileAfterProjectOpen());if(queueWarning){console.warn('Queue reset warning:',queueWarning);showPostSwitchWarning('render queue reset',queueWarning);}
    }
    return projects.getCurrent();
  }));
  handle(IPC.projectOpen, () => withProjectSwitchLock(async()=>{
    const opened = await projects.openWithDialog();
    if (opened) {
      const provisionWarning=await runPostSwitchStep(()=>withWorkflowValidationLock(()=>autoProvisionWanGpIfNeeded(projects,settings)));if(provisionWarning){console.warn('WanGP auto-provision warning:',provisionWarning);showPostSwitchWarning('WanGP auto-provisioning',provisionWarning);}
      const recoveryWarning=await runPostSwitchStep(()=>queue.reconcileAfterProjectOpen());if(recoveryWarning){console.warn('Render recovery warning:',recoveryWarning);showPostSwitchWarning('render recovery',recoveryWarning);}
    }
    return projects.getCurrent();
  }));
  handle(IPC.projectSave, (project: FilmProject) => {
    assertProjectStable();
    const removedActive=removedActiveRenderShotIds(project,queue.snapshot().jobs);
    if(removedActive.length)throw new Error(`Cannot remove ${removedActive.length} shot(s) while their render jobs are active. Finish or cancel those renders before changing scene/shot structure.`);
    return projects.saveFromRenderer(project);
  });
  handle(IPC.projectGet, () => projects.getCurrent());
  handle(IPC.projectParseScript, (script: string) => parseScreenplay(script));
  handle(IPC.projectPreflight, async () => {
    assertProjectStable();
    const project = requireProject(projects);
    return preflightProject(project, settings.get());
  });
  handle(IPC.assetImport, (kind: AssetKind) => withProjectFileOperation(()=>projects.importAsset(kind)));
  handle(IPC.assetDelete, (assetId:string) => withProjectFileOperation(async()=>{
    if(queue.isBusy()||keyframeBusy||directorBusy||activeExportAbortController||activeHandoffPromise)throw new Error('Finish or cancel active generation/Director/export/handoff before deleting project assets.');
    return projects.deleteAsset(assetId);
  }));

  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsSave, async (next: AppMachineSettings) => {
    if (queue.isBusy()||keyframeBusy||directorBusy||workflowValidationBusy) throw new Error('Machine runtime settings cannot change while render jobs, keyframe generation, local Director work, or workflow validation/provisioning are active.');
    return settings.save(next);
  });

  handle(IPC.workflowImportComfy, () => withProjectFileOperation(async () => {
    const project = requireProject(projects);
    const result = await dialog.showOpenDialog({ title: 'Import ComfyUI workflow JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const source=result.filePaths[0];
    await readWorkflow(source);
    const target=await assertSafeWritePath(join(project.rootPath,'workflows'),join(project.rootPath,'workflows',`${randomUUID()}-${basename(source)}`),'workflow import target');
    await copyFile(source,target);
    let rawWorkflow:any,format:'api'|'ui';
    try{rawWorkflow=await readWorkflow(target);format=detectWorkflowFormat(rawWorkflow);}
    catch(error){await rm(target,{force:true}).catch(()=>undefined);throw error;}
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
  }));

  handle(IPC.workflowImportWanGp, () => withProjectFileOperation(async () => {
    const project=requireProject(projects);
    const result=await dialog.showOpenDialog({title:'Import WanGP exported settings JSON',properties:['openFile'],filters:[{name:'WanGP settings',extensions:['json']}]});
    if(result.canceled||!result.filePaths[0])return null;
    const source=result.filePaths[0];
    await inspectWanGpSettings(source);
    const target=await assertSafeWritePath(join(project.rootPath,'workflows'),join(project.rootPath,'workflows',`${randomUUID()}-wangp-${basename(source)}`),'WanGP settings import');
    await copyFile(source,target);
    try{
      const inspected=await inspectWanGpSettings(target);
      return{path:target,...inspected,warnings:inspected.warnings};
    }catch(error){await rm(target,{force:true}).catch(()=>undefined);throw error;}
  }));

  handle(IPC.workflowInspect, async (path:string)=>{
    assertProjectStable();
    const project=requireProject(projects);
    const safe=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),path,'workflow path'),'workflow path');
    try{return await inspectWorkflow(safe);}catch{return inspectWanGpSettings(safe);}
  });
  handle(IPC.workflowValidate, (profileId:string) => {assertWorkflowMaintenanceAvailable();return withWorkflowValidationLock(()=>validateAndRecordProfile(projects, settings.get(), profileId));});
  handle(IPC.workflowWanGpCatalog, () => listWanGpCatalog(settings.get()));
  handle(IPC.workflowProvisionWanGp, () => {assertWorkflowMaintenanceAvailable();return withWorkflowValidationLock(()=>provisionRecommendedWanGpProfiles(projects,settings));});

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

  handle(IPC.renderEnqueue,(request:RenderRequest)=>{assertProjectStable();if(activeExportAbortController||workflowValidationBusy||keyframeBusy||directorBusy)throw new Error('Wait for active timeline export, workflow validation, keyframe, or Director work to finish before queueing a video render.');return queue.enqueue(request);});
  handle(IPC.renderEnqueueBatch,(request:RenderBatchRequest)=>{assertProjectStable();if(activeExportAbortController||workflowValidationBusy||keyframeBusy||directorBusy)throw new Error('Wait for active timeline export, workflow validation, keyframe, or Director work to finish before queueing video renders.');return queue.enqueueBatch(request);});
  handle(IPC.renderRetry,(jobId:string)=>{assertProjectStable();if(activeExportAbortController||workflowValidationBusy||keyframeBusy||directorBusy)throw new Error('Wait for active timeline export, workflow validation, keyframe, or Director work to finish before retrying a render.');return queue.retry(jobId);});
  handle(IPC.renderCancel,(jobId:string)=>queue.cancel(jobId));
  handle(IPC.renderSnapshot,()=>queue.snapshot());
  handle(IPC.renderOutputDelete,(outputId:string)=>withProjectFileOperation(async()=>{
    if(activeExportAbortController||activeHandoffPromise)throw new Error('Finish or cancel the active timeline export / CapCut handoff before deleting rendered takes.');
    return projects.deleteRenderOutput(outputId);
  }));

  handle(IPC.directorPlanScene,async(sceneId:string)=>{
    assertDirectorAvailable();directorBusy=true;
    const project=requireProject(projects),scene=project.scenes.find(s=>s.id===sceneId);
    if(!scene){directorBusy=false;throw new Error('Scene not found.');}
    const task=planSceneWithLocalDirector(project,scene,settings.get());activeDirectorPromise=task;
    try{return await task;}
    finally{directorBusy=false;activeDirectorPromise=null;}
  });
  handle(IPC.directorReviewShot,async(shotId:string)=>{
    assertDirectorAvailable();directorBusy=true;
    const project=requireProject(projects),shot=project.shots.find(s=>s.id===shotId);
    if(!shot){directorBusy=false;throw new Error('Shot not found.');}
    const task=reviewShotWithLocalDirector(project,shot,settings.get());activeDirectorPromise=task;
    try{return await task;}
    finally{directorBusy=false;activeDirectorPromise=null;}
  });
  handle(IPC.keyframeGenerate,async(request:KeyframeRequest)=>{
    assertGpuGenerationAvailable();keyframeBusy=true;activeKeyframeAbortController=new AbortController();
    const task=generateKeyframe(projects,settings.get(),request,keyframeLeases,activeKeyframeAbortController.signal);activeKeyframePromise=task;
    try{return await task;}
    finally{keyframeBusy=false;activeKeyframeAbortController=null;activeKeyframePromise=null;}
  });
  handle(IPC.keyframeCancel,async()=>{
    if(!keyframeBusy||!activeKeyframeAbortController)return false;
    activeKeyframeAbortController.abort();
    return true;
  });
  handle(IPC.timelineExport,async()=>{
    assertProjectStable();
    if(activeExportAbortController)throw new Error('A timeline export is already running.');
    if(queue.isBusy()||keyframeBusy||directorBusy||workflowValidationBusy)throw new Error('Finish or cancel active render, keyframe, Director, or workflow maintenance work before starting the GPU-assisted timeline export.');
    activeExportAbortController=new AbortController();
    const task=exportTimeline(requireProject(projects),settings.get(),activeExportAbortController.signal);activeExportPromise=task;
    try{return{outputPath:await task};}
    finally{activeExportAbortController=null;activeExportPromise=null;}
  });
  handle(IPC.timelineCancelExport,async()=>{activeExportAbortController?.abort();});
  handle(IPC.capcutPrepareHandoff,async()=>{
    assertProjectStable();
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
  const usable=project.settings.workflowProfiles.some(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid');
  if(usable)return;
  try{await provisionRecommendedWanGpProfiles(projects,settings);}
  catch(error){console.warn('Automatic WanGP profile provisioning was skipped:',error);}
}
