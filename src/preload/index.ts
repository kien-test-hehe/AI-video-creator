import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { CineforgeApi } from '../shared/api';

const api: CineforgeApi = {
  project: {
    create: name => ipcRenderer.invoke(IPC.projectCreate, name),
    open: () => ipcRenderer.invoke(IPC.projectOpen),
    save: project => ipcRenderer.invoke(IPC.projectSave, project),
    get: () => ipcRenderer.invoke(IPC.projectGet),
    parseScript: script => ipcRenderer.invoke(IPC.projectParseScript, script),
    preflight: () => ipcRenderer.invoke(IPC.projectPreflight)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    save: settings => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  asset: { import: kind => ipcRenderer.invoke(IPC.assetImport, kind), delete: assetId => ipcRenderer.invoke(IPC.assetDelete, assetId) },
  workflow: {
    importComfy: () => ipcRenderer.invoke(IPC.workflowImportComfy),
    importWanGp: () => ipcRenderer.invoke(IPC.workflowImportWanGp),
    inspect: path => ipcRenderer.invoke(IPC.workflowInspect, path),
    validate: profileId => ipcRenderer.invoke(IPC.workflowValidate, profileId),
    wanGpCatalog: () => ipcRenderer.invoke(IPC.workflowWanGpCatalog),
    provisionRecommendedWanGp: () => ipcRenderer.invoke(IPC.workflowProvisionWanGp)
  },
  system: {
    probe: () => ipcRenderer.invoke(IPC.systemProbe),
    pingComfy: url => ipcRenderer.invoke(IPC.comfyPing, url),
    reveal: path => ipcRenderer.invoke(IPC.systemReveal, path),
    readiness: () => ipcRenderer.invoke(IPC.systemReadiness)
  },
  render: {
    enqueue: request => ipcRenderer.invoke(IPC.renderEnqueue, request),
    enqueueBatch: request => ipcRenderer.invoke(IPC.renderEnqueueBatch, request),
    retry: jobId => ipcRenderer.invoke(IPC.renderRetry, jobId),
    cancel: jobId => ipcRenderer.invoke(IPC.renderCancel, jobId),
    snapshot: () => ipcRenderer.invoke(IPC.renderSnapshot),
    deleteOutput: outputId => ipcRenderer.invoke(IPC.renderOutputDelete, outputId),
    onQueueEvent: handler => {
      const listener = (_event: unknown, snapshot: any) => handler(snapshot);
      ipcRenderer.on(IPC.queueEvent, listener);
      return () => ipcRenderer.removeListener(IPC.queueEvent, listener);
    }
  },
  timeline: { export: () => ipcRenderer.invoke(IPC.timelineExport), cancelExport: () => ipcRenderer.invoke(IPC.timelineCancelExport) },
  director: { planScene: sceneId => ipcRenderer.invoke(IPC.directorPlanScene, sceneId), reviewShot: shotId => ipcRenderer.invoke(IPC.directorReviewShot, shotId) },
  keyframe: { generate: request => ipcRenderer.invoke(IPC.keyframeGenerate, request), cancel: () => ipcRenderer.invoke(IPC.keyframeCancel) },
  production: {
    recordObservedFinalState: request => ipcRenderer.invoke(IPC.productionRecordObservedFinal, request),
    recordQc: request => ipcRenderer.invoke(IPC.productionRecordQc, request),
    createHumanTask: request => ipcRenderer.invoke(IPC.productionCreateHumanTask, request),
    resolveHumanTask: request => ipcRenderer.invoke(IPC.productionResolveHumanTask, request),
    promoteCanonicalTake: request => ipcRenderer.invoke(IPC.productionPromoteCanonical, request)
  },
  automation: {
    start: request => ipcRenderer.invoke(IPC.automationStart, request),
    pause: () => ipcRenderer.invoke(IPC.automationPause),
    resume: () => ipcRenderer.invoke(IPC.automationResume),
    stop: () => ipcRenderer.invoke(IPC.automationStop),
    status: () => ipcRenderer.invoke(IPC.automationStatus),
    onStatus: handler => {
      const listener=(_event:unknown,status:any)=>handler(status);
      ipcRenderer.on(IPC.automationEvent,listener);
      return()=>ipcRenderer.removeListener(IPC.automationEvent,listener);
    }
  },
  capcut: { prepareHandoff: () => ipcRenderer.invoke(IPC.capcutPrepareHandoff) }
};

contextBridge.exposeInMainWorld('cineforge', api);
