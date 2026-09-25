import { basename, join, resolve, sep } from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '../shared/ipc';
import type { AssetKind, FilmProject, KeyframeRequest, RenderBatchRequest, RenderRequest } from '../shared/types';
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
import { assertPathInside } from './services/path-safety';
import { prepareCapCutHandoff } from './services/capcut-handoff';

export function registerIpc(projects: ProjectService, queue: RenderQueueService): void {
  ipcMain.handle(IPC.projectCreate, (_event, name?: string) => {
    if (queue.isBusy()) throw new Error('Finish or cancel the active render queue before switching projects.');
    return projects.createWithDialog(name);
  });
  ipcMain.handle(IPC.projectOpen, () => {
    if (queue.isBusy()) throw new Error('Finish or cancel the active render queue before switching projects.');
    return projects.openWithDialog();
  });
  ipcMain.handle(IPC.projectSave, (_event, project: FilmProject) => projects.saveFromRenderer(project));
  ipcMain.handle(IPC.projectGet, () => projects.getCurrent());
  ipcMain.handle(IPC.projectParseScript, (_event, script: string) => parseScreenplay(script));
  ipcMain.handle(IPC.projectPreflight, async () => {
    const project = projects.getCurrent(); if (!project) throw new Error('Open a project first.'); return preflightProject(project);
  });
  ipcMain.handle(IPC.assetImport, (_event, kind: AssetKind) => projects.importAsset(kind));

  ipcMain.handle(IPC.workflowImportComfy, async () => {
    const project = projects.getCurrent(); if (!project) throw new Error('Open a project first.');
    const result = await dialog.showOpenDialog({ title: 'Import ComfyUI workflow JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const source=result.filePaths[0]; const target=join(project.rootPath,'workflows',`${Date.now()}-${basename(source)}`); await copyFile(source,target);
    const rawWorkflow=await readWorkflow(target); const format=detectWorkflowFormat(rawWorkflow);
    if(format==='api'){const inspected=await inspectWorkflow(target);return{path:target,...inspected,warnings:[]};}
    const client=new ComfyClient(project.settings.comfyUrl,project.settings.localOnly); const ping=await client.ping();
    if(!ping.reachable)return{path:target,format:'ui' as const,suggestedBindings:[],warnings:[`ComfyUI is offline, so UI workflow conversion could not run: ${ping.error||'unknown error'}`]};
    const converted=uiWorkflowToApi(rawWorkflow,await client.objectInfo());
    if(converted.requiresApiExport)return{path:target,format:'ui' as const,suggestedBindings:[],warnings:[...converted.warnings,'CineForge refused to create a partial API graph. Load it in ComfyUI, Save (API Format), and import that JSON.']};
    const apiPath=target.replace(/\.json$/i,'.api.json'); await writeFile(apiPath,JSON.stringify(converted.workflow,null,2),'utf8');
    return{path:apiPath,format:'api' as const,suggestedBindings:suggestBindings(converted.workflow),warnings:converted.warnings};
  });

  ipcMain.handle(IPC.workflowImportWanGp, async () => {
    const project=projects.getCurrent(); if(!project)throw new Error('Open a project first.');
    const result=await dialog.showOpenDialog({title:'Import WanGP exported settings JSON',properties:['openFile'],filters:[{name:'WanGP settings',extensions:['json']}]});
    if(result.canceled||!result.filePaths[0])return null;
    const source=result.filePaths[0]; const target=join(project.rootPath,'workflows',`${Date.now()}-wangp-${basename(source)}`); await copyFile(source,target);
    const inspected=await inspectWanGpSettings(target);
    return{path:target,...inspected,warnings:['WanGP settings are version/model specific. CineForge patches only the JSON paths shown in this profile and executes the file through WanGP headless mode.']};
  });

  ipcMain.handle(IPC.workflowInspect, async (_event,path:string)=>{
    const project=projects.getCurrent(); if(!project)throw new Error('Open a project first.');
    const safe=assertPathInside(join(project.rootPath,'workflows'),path,'workflow path');
    try{return await inspectWorkflow(safe);}catch{return inspectWanGpSettings(safe);}
  });

  ipcMain.handle(IPC.systemProbe, async()=>{const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');return probeSystem(project);});
  ipcMain.handle(IPC.comfyPing, async(_event,url?:string)=>{const project=projects.getCurrent();const target=url||project?.settings.comfyUrl||'http://127.0.0.1:8188';return new ComfyClient(target,project?.settings.localOnly??true).ping();});
  ipcMain.handle(IPC.systemReveal,(_event,path:string)=>{const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');const root=resolve(project.rootPath),target=resolve(path);if(!(target===root||target.startsWith(`${root}${sep}`)))throw new Error('Refusing to reveal a path outside the current project.');shell.showItemInFolder(target);});

  ipcMain.handle(IPC.renderEnqueue,(_event,request:RenderRequest)=>queue.enqueue(request));
  ipcMain.handle(IPC.renderEnqueueBatch,(_event,request:RenderBatchRequest)=>queue.enqueueBatch(request));
  ipcMain.handle(IPC.renderRetry,(_event,jobId:string)=>queue.retry(jobId));
  ipcMain.handle(IPC.renderCancel,(_event,jobId:string)=>queue.cancel(jobId));
  ipcMain.handle(IPC.renderSnapshot,()=>queue.snapshot());

  ipcMain.handle(IPC.directorPlanScene,async(_event,sceneId:string)=>{const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');const scene=project.scenes.find(s=>s.id===sceneId);if(!scene)throw new Error('Scene not found.');return planSceneWithLocalDirector(project,scene);});
  ipcMain.handle(IPC.directorReviewShot,async(_event,shotId:string)=>{const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');const shot=project.shots.find(s=>s.id===shotId);if(!shot)throw new Error('Shot not found.');return reviewShotWithLocalDirector(project,shot);});
  ipcMain.handle(IPC.keyframeGenerate,(_event,request:KeyframeRequest)=>generateKeyframe(projects,request));
  ipcMain.handle(IPC.timelineExport,async()=>{const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');return{outputPath:await exportTimeline(project)};});
  ipcMain.handle(IPC.capcutPrepareHandoff,async()=>{const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');return prepareCapCutHandoff(project);});

  queue.on('snapshot',snapshot=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send(IPC.queueEvent,snapshot);});
}
