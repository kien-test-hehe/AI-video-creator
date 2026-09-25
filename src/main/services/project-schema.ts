import { randomUUID } from 'node:crypto';
import type {
  Asset, AssetKind, FilmProject, GenerationMode, ModelFamily, ProjectSettings, QualityIntent, RenderJob,
  RenderJobStatus, RenderOutput, Scene, Shot, ShotStatus, TimelineClip, WorkflowBinding, WorkflowProfile, WorkflowPurpose
} from '../../shared/types';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';

const ASSET_KINDS = new Set<AssetKind>(['character','location','prop','wardrobe','reference','keyframe','audio','video','image']);
const MODEL_FAMILIES = new Set<ModelFamily>(['ltx-2.5-fast','ltx-2.3','hunyuan-video-1.5','wan-2.2-5b','framepack','custom']);
const MODES = new Set<GenerationMode>(['t2v','i2v','flf2v','ia2v','v2v','t2i','i2i']);
const QUALITIES = new Set<QualityIntent>(['preview','balanced','hero']);
const SHOT_STATUSES = new Set<ShotStatus>(['draft','ready','queued','rendering','rendered','failed']);
const JOB_STATUSES = new Set<RenderJobStatus>(['queued','preparing','uploading','submitted','running','recovering','stalled','orphaned','downloading','done','failed','cancelled']);
const PURPOSES = new Set<WorkflowPurpose>(['video','image','audio','utility']);

export interface LoadedProject {
  project: FilmProject;
  migratedFrom?: number;
  migrationNotes: string[];
}

export function loadPortableProject(raw: unknown, openedRoot: string): LoadedProject {
  const source = asObject(raw, 'project');
  const version = Number(source.schemaVersion ?? 1);
  if (version !== 1 && version !== 2) throw new Error(`Unsupported project schema: ${String(source.schemaVersion)}`);
  const migrationNotes: string[] = [];
  const normalized = version === 1 ? migrateV1ToV2(source, migrationNotes) : source;
  const project = sanitizeV2(normalized, openedRoot);
  return { project, ...(version === 1 ? { migratedFrom: 1 } : {}), migrationNotes };
}

function migrateV1ToV2(source: Record<string, any>, notes: string[]): Record<string, any> {
  notes.push('Migrated project schema v1 → v2.');
  notes.push('Discarded executable paths and AI endpoint URLs from the portable project. Reconfigure them once in CineForge machine settings.');
  const old = asObject(source.settings ?? {}, 'settings');
  return {
    ...source,
    schemaVersion: 2,
    settings: {
      costPolicy: old.costPolicy,
      capcut: {
        enabled: old.capcut?.enabled !== false,
        pro: old.capcut?.pro === true
      },
      defaultFps: old.defaultFps,
      outputContainer: old.outputContainer,
      workflowProfiles: old.workflowProfiles
    }
  };
}

function sanitizeV2(source: Record<string, any>, openedRoot: string): FilmProject {
  const now = new Date().toISOString();
  const id = safeId(source.id);
  const settings = sanitizeProjectSettings(source.settings);
  const scenes = array(source.scenes).map(sanitizeScene);
  const sceneIds = new Set(scenes.map(s=>s.id));
  const assets = array(source.assets).map(sanitizeAsset);
  const assetIds = new Set(assets.map(a=>a.id));
  const shots = array(source.shots).map(value => sanitizeShot(value, sceneIds, assetIds));
  const shotIds = new Set(shots.map(s=>s.id));
  const renderOutputs = array(source.renderOutputs).map(value => sanitizeRenderOutput(value, shotIds));
  const outputIds = new Set(renderOutputs.map(o=>o.id));
  const renderJobs = array(source.renderJobs).map(value => sanitizeRenderJob(value, shotIds, settings.workflowProfiles, sceneIds, assetIds));
  const timeline = array(source.timeline).map(value => sanitizeTimelineClip(value, shotIds, outputIds));

  for (const scene of scenes) scene.shotIds = scene.shotIds.filter(shotId => shotIds.has(shotId));
  return {
    schemaVersion: 2,
    id,
    name: str(source.name, 'Untitled Film', 240),
    createdAt: iso(source.createdAt, now),
    updatedAt: iso(source.updatedAt, now),
    rootPath: openedRoot,
    story: {
      title: str(source.story?.title, str(source.name, 'Untitled Film', 240), 500),
      logline: str(source.story?.logline, '', 10_000),
      script: str(source.story?.script, '', 2_000_000),
      notes: str(source.story?.notes, '', 200_000)
    },
    scenes, assets, shots, renderJobs, renderOutputs, timeline, settings
  };
}

function sanitizeProjectSettings(value: unknown): ProjectSettings {
  const source = asObject(value ?? {}, 'settings');
  const profiles = array(source.workflowProfiles).map(sanitizeWorkflowProfile);
  for (const builtin of BUILTIN_WORKFLOW_PROFILES) if (!profiles.some(p=>p.id===builtin.id)) profiles.push(structuredClone(builtin));
  return {
    costPolicy: {
      mode: 'codex-capcut-only',
      allowCapcutAiCredits: Boolean(source.costPolicy?.allowCapcutAiCredits)
    },
    capcut: {
      enabled: source.capcut?.enabled !== false,
      pro: source.capcut?.pro === true
    },
    defaultFps: clampInt(source.defaultFps, 1, 120, 24),
    outputContainer: ['mp4','mov','webm'].includes(source.outputContainer) ? source.outputContainer : 'mp4',
    workflowProfiles: profiles
  };
}

function sanitizeWorkflowProfile(value: unknown): WorkflowProfile {
  const source = asObject(value, 'workflow profile');
  const runtime = source.runtime === 'wangp' ? 'wangp' : 'comfyui';
  const format = source.workflowFormat === 'wangp-settings' ? 'wangp-settings' : source.workflowFormat === 'ui' ? 'ui' : 'api';
  const validationSource = source.validation && typeof source.validation === 'object' ? source.validation : {};
  return {
    id: safeId(source.id),
    runtime,
    purpose: PURPOSES.has(source.purpose) ? source.purpose : 'video',
    name: str(source.name, 'Workflow', 240),
    modelFamily: MODEL_FAMILIES.has(source.modelFamily) ? source.modelFamily : 'custom',
    mode: MODES.has(source.mode) ? source.mode : 'i2v',
    workflowPath: str(source.workflowPath, '', 4096),
    workflowFormat: format,
    bindings: array(source.bindings).map(sanitizeBinding),
    enabled: Boolean(source.enabled),
    notes: str(source.notes, '', 20_000) || undefined,
    modelFingerprint: str(source.modelFingerprint, '', 512) || undefined,
    validation: {
      structuralStatus: ['valid','invalid'].includes(validationSource.structuralStatus) ? validationSource.structuralStatus : 'unvalidated',
      validatedAt: maybeIso(validationSource.validatedAt),
      sourceSha256: sha(validationSource.sourceSha256),
      runtimeFingerprint: str(validationSource.runtimeFingerprint, '', 512) || undefined,
      lastSuccessfulRenderAt: maybeIso(validationSource.lastSuccessfulRenderAt),
      lastError: str(validationSource.lastError, '', 10_000) || undefined
    }
  };
}

function sanitizeBinding(value: unknown): WorkflowBinding {
  const source = asObject(value, 'binding');
  const keys = new Set(['prompt','negativePrompt','width','height','resolution','frames','fps','steps','cfg','seed','startImage','endImage','locationImage','characterImage1','characterImage2','characterImage3','characterImage4','propImage1','propImage2','referenceImages','referenceImage1','referenceImage2','referenceImage3','referenceImage4','inputAudio','inputVideo','filenamePrefix']);
  if (!keys.has(source.key)) throw new Error(`Invalid workflow binding key: ${String(source.key)}`);
  const selector = source.selector && typeof source.selector === 'object' ? {
    ...(str(source.selector.nodeId, '', 128) ? { nodeId: str(source.selector.nodeId, '', 128) } : {}),
    ...(str(source.selector.classType, '', 256) ? { classType: str(source.selector.classType, '', 256) } : {}),
    ...(str(source.selector.titleIncludes, '', 256) ? { titleIncludes: str(source.selector.titleIncludes, '', 256) } : {})
  } : undefined;
  return {
    key: source.key,
    selector,
    input: str(source.input, '', 256) || undefined,
    jsonPath: str(source.jsonPath, '', 1024) || undefined,
    transform: ['integer','float','boolean','string'].includes(source.transform) ? source.transform : 'identity',
    required: Boolean(source.required)
  } as WorkflowBinding;
}

function sanitizeScene(value: unknown): Scene {
  const source = asObject(value, 'scene');
  return {
    id: safeId(source.id),
    index: clampInt(source.index, 1, 1_000_000, 1),
    heading: str(source.heading, 'SCENE', 2000),
    body: str(source.body, '', 500_000),
    location: str(source.location, '', 2000) || undefined,
    timeOfDay: str(source.timeOfDay, '', 500) || undefined,
    shotIds: array(source.shotIds).map(safeId)
  };
}

function sanitizeAsset(value: unknown): Asset {
  const source = asObject(value, 'asset');
  if (!ASSET_KINDS.has(source.kind)) throw new Error(`Invalid asset kind: ${String(source.kind)}`);
  const path = str(source.projectPath, '', 4096);
  if (!path) throw new Error('Asset projectPath is required.');
  return {
    id: safeId(source.id),
    kind: source.kind,
    name: str(source.name, 'Asset', 1000),
    sourcePath: str(source.sourcePath, '', 4096),
    projectPath: path,
    mimeType: str(source.mimeType, '', 512) || undefined,
    tags: array(source.tags).map(v=>str(v,'',256)).filter(Boolean).slice(0,128),
    notes: str(source.notes, '', 100_000),
    createdAt: iso(source.createdAt, new Date().toISOString())
  };
}

function sanitizeShot(value: unknown, sceneIds: Set<string>, assetIds: Set<string>): Shot {
  const source = asObject(value, 'shot');
  const sceneId = safeId(source.sceneId);
  if (!sceneIds.has(sceneId)) throw new Error(`Shot references unknown scene: ${sceneId}`);
  const generationSource = asObject(source.generation ?? {}, 'shot generation');
  const rawModelFamily=typeof generationSource.modelFamily==='string'?generationSource.modelFamily:'';
  const modelFamily:ModelFamily = MODEL_FAMILIES.has(rawModelFamily as ModelFamily) ? rawModelFamily as ModelFamily : PRIMARY_VIDEO_MODEL;
  const defaults = MODEL_DEFAULTS[modelFamily];
  const filterIds = (value: unknown, max:number) => array(value).map(safeId).filter(id=>assetIds.has(id)).slice(0,max);
  const optionalAsset = (value: unknown) => {
    if (typeof value !== 'string' || !value) return undefined;
    return assetIds.has(value) ? value : undefined;
  };
  return {
    id: safeId(source.id),
    sceneId,
    index: clampInt(source.index,1,1_000_000,1),
    title: str(source.title,'Shot',2000),
    prompt: str(source.prompt,'',200_000),
    camera: str(source.camera,'',20_000),
    action: str(source.action,'',100_000),
    dialogue: str(source.dialogue,'',100_000),
    continuityNotes: str(source.continuityNotes,'',100_000),
    characterAssetIds: filterIds(source.characterAssetIds,4),
    locationAssetId: optionalAsset(source.locationAssetId),
    propAssetIds: filterIds(source.propAssetIds,2),
    startFrameAssetId: optionalAsset(source.startFrameAssetId),
    endFrameAssetId: optionalAsset(source.endFrameAssetId),
    referenceVideoAssetId: optionalAsset(source.referenceVideoAssetId),
    audioAssetId: optionalAsset(source.audioAssetId),
    status: SHOT_STATUSES.has(source.status) ? source.status : 'draft',
    generation: {
      modelFamily,
      mode: MODES.has(generationSource.mode) ? generationSource.mode : (defaults.mode ?? 'i2v'),
      quality: QUALITIES.has(generationSource.quality) ? generationSource.quality : (defaults.quality ?? 'balanced'),
      width: clampInt(generationSource.width,256,8192,defaults.width ?? 768),
      height: clampInt(generationSource.height,256,8192,defaults.height ?? 432),
      frames: clampInt(generationSource.frames,1,100_000,defaults.frames ?? 121),
      fps: clampInt(generationSource.fps,1,240,defaults.fps ?? 24),
      steps: generationSource.steps == null ? defaults.steps : clampInt(generationSource.steps,1,1000,defaults.steps ?? 20),
      cfg: generationSource.cfg == null ? defaults.cfg : clampNumber(generationSource.cfg,0,100,defaults.cfg ?? 1),
      seed: clampInt(generationSource.seed,0,2_147_483_647,Math.floor(Math.random()*2_147_483_647)),
      negativePrompt: str(generationSource.negativePrompt,'',100_000),
      includeAudio: Boolean(generationSource.includeAudio),
      workflowProfileId: typeof generationSource.workflowProfileId === 'string' ? generationSource.workflowProfileId : undefined
    },
    latestRenderId: typeof source.latestRenderId === 'string' ? source.latestRenderId : undefined
  };
}

function sanitizeRenderOutput(value: unknown, shotIds: Set<string>): RenderOutput {
  const source = asObject(value, 'render output');
  const shotId = safeId(source.shotId);
  if (!shotIds.has(shotId)) throw new Error(`Render output references unknown shot: ${shotId}`);
  return {
    id:safeId(source.id), jobId:safeId(source.jobId), shotId,
    path:str(source.path,'',4096), filename:str(source.filename,'output',2048),
    mediaType:['video','image','audio'].includes(source.mediaType) ? source.mediaType : 'unknown',
    createdAt:iso(source.createdAt,new Date().toISOString()),
    comfyMeta: source.comfyMeta && typeof source.comfyMeta === 'object' ? structuredClone(source.comfyMeta) : undefined,
    technicalQc: source.technicalQc && typeof source.technicalQc === 'object' ? structuredClone(source.technicalQc) : undefined
  };
}

function sanitizeRenderJob(value: unknown, shotIds: Set<string>, profiles: WorkflowProfile[], sceneIds:Set<string>, assetIds:Set<string>): RenderJob {
  const source = asObject(value, 'render job');
  const shotId = safeId(source.shotId);
  if (!shotIds.has(shotId)) throw new Error(`Render job references unknown shot: ${shotId}`);
  const profileId = typeof source.workflowProfileId === 'string' ? source.workflowProfileId : undefined;
  let spec: RenderJob['spec'];
  if(source.spec&&typeof source.spec==='object'){
    const rawSpec=asObject(source.spec,'render job spec');
    const workflowProfile=sanitizeWorkflowProfile(rawSpec.workflowProfile);
    const runtimeRaw=rawSpec.runtimeFingerprint&&typeof rawSpec.runtimeFingerprint==='object'?rawSpec.runtimeFingerprint:{};
    spec={
      shot:sanitizeShot(rawSpec.shot,sceneIds,assetIds),
      workflowProfile,
      effectivePrompt:str(rawSpec.effectivePrompt,'',300_000),
      queuedProjectUpdatedAt:iso(rawSpec.queuedProjectUpdatedAt,new Date().toISOString()),
      workflowSha256:sha(rawSpec.workflowSha256)??'0'.repeat(64),
      assetFingerprints:array(rawSpec.assetFingerprints).slice(0,32).map(item=>{
        const fp=asObject(item,'asset fingerprint');return{assetId:safeId(fp.assetId),projectPath:str(fp.projectPath,'',4096),sha256:sha(fp.sha256)??'0'.repeat(64)};
      }),
      runtimeFingerprint:{
        backend:runtimeRaw.backend==='wangp'?'wangp':'comfyui',
        executionMode:runtimeRaw.executionMode==='docker'?'docker':runtimeRaw.executionMode==='native'?'native':undefined,
        runtimeVersion:str(runtimeRaw.runtimeVersion,'',2048)||undefined,
        runtimeSha256:sha(runtimeRaw.runtimeSha256),
        environmentSha256:sha(runtimeRaw.environmentSha256)??'0'.repeat(64)
      },
      modelFingerprint:str(rawSpec.modelFingerprint,'',512)||undefined
    };
  }
  return {
    id:safeId(source.id), shotId, createdAt:iso(source.createdAt,new Date().toISOString()), updatedAt:iso(source.updatedAt,new Date().toISOString()),
    status:JOB_STATUSES.has(source.status) ? source.status : 'failed', progress:clampNumber(source.progress,0,1,0),
    message:str(source.message,'',10_000), modelFamily:MODEL_FAMILIES.has(source.modelFamily)?source.modelFamily:'custom',
    workflowProfileId: profileId && profiles.some(p=>p.id===profileId) ? profileId : profileId,
    comfyPromptId:str(source.comfyPromptId,'',512)||undefined,
    backendPid:Number.isInteger(source.backendPid)&&source.backendPid>0?source.backendPid:undefined,
    lastHeartbeatAt:maybeIso(source.lastHeartbeatAt),
    error:str(source.error,'',50_000)||undefined,
    outputs:[],
    spec
  };
}

function sanitizeTimelineClip(value: unknown, shotIds: Set<string>, outputIds: Set<string>): TimelineClip {
  const source = asObject(value, 'timeline clip');
  const shotId=safeId(source.shotId), renderOutputId=safeId(source.renderOutputId);
  if(!shotIds.has(shotId))throw new Error(`Timeline references unknown shot: ${shotId}`);
  if(!outputIds.has(renderOutputId))throw new Error(`Timeline references unknown output: ${renderOutputId}`);
  const trimIn=clampNumber(source.trimInSec,0,1_000_000,0);
  const trimOut=source.trimOutSec==null?undefined:clampNumber(source.trimOutSec,0,1_000_000,undefined as any);
  if(trimOut!=null&&trimOut<=trimIn)throw new Error('Timeline trimOutSec must be greater than trimInSec.');
  return { id:safeId(source.id),shotId,renderOutputId,track:clampInt(source.track,0,128,0),order:clampInt(source.order,0,1_000_000,0),trimInSec:trimIn,trimOutSec:trimOut,volume:clampNumber(source.volume,0,8,1) };
}

function asObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected an object.`);
  return value as Record<string, any>;
}
function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function str(value: unknown, fallback: string, max: number): string { return typeof value === 'string' ? value.slice(0,max) : fallback; }
function safeId(value: unknown): string {
  if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(value)) return value;
  return randomUUID();
}
function clampInt(value: unknown,min:number,max:number,fallback:number):number{const n=Number(value);return Number.isInteger(n)?Math.min(max,Math.max(min,n)):fallback;}
function clampNumber(value: unknown,min:number,max:number,fallback:number):number{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function iso(value: unknown, fallback: string): string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback; }
function maybeIso(value: unknown): string | undefined { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined; }
function sha(value: unknown): string | undefined { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined; }
