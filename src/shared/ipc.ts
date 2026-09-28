export const IPC = {
  projectCreate: 'project:create', projectOpen: 'project:open', projectSave: 'project:save', projectGet: 'project:get',
  projectParseScript: 'project:parse-script', projectPreflight: 'project:preflight', assetImport: 'asset:import', assetDelete: 'asset:delete',
  workflowImportComfy: 'workflow:import-comfy', workflowImportWanGp: 'workflow:import-wangp', workflowInspect: 'workflow:inspect', workflowValidate: 'workflow:validate', workflowWanGpCatalog: 'workflow:wangp-catalog', workflowProvisionWanGp: 'workflow:provision-wangp',
  settingsGet: 'settings:get', settingsSave: 'settings:save',
  systemProbe: 'system:probe', systemReveal: 'system:reveal', comfyPing: 'comfy:ping',
  renderEnqueue: 'render:enqueue', renderEnqueueBatch: 'render:enqueue-batch', renderRetry: 'render:retry', renderCancel: 'render:cancel', renderSnapshot: 'render:snapshot', renderOutputDelete: 'render:output-delete',
  timelineExport: 'timeline:export', timelineCancelExport: 'timeline:cancel-export', queueEvent: 'queue:event', directorPlanScene: 'director:plan-scene', directorReviewShot: 'director:review-shot', keyframeGenerate: 'keyframe:generate', keyframeCancel: 'keyframe:cancel',
  productionRecordObservedFinal: 'production:record-observed-final',
  productionRecordQc: 'production:record-qc',
  productionCreateHumanTask: 'production:create-human-task',
  productionResolveHumanTask: 'production:resolve-human-task',
  productionPromoteCanonical: 'production:promote-canonical',
  capcutPrepareHandoff: 'capcut:prepare-handoff'
} as const;
