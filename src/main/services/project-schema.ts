import { randomUUID } from 'node:crypto';
import type {
  Asset, AssetKind, FilmProject, GenerationMode, ModelFamily, ProjectSettings, QualityIntent, RenderJob,
  RenderJobStatus, RenderOutput, Scene, Shot, ShotStatus, TimelineClip, WorkflowBinding, WorkflowProfile, WorkflowPurpose
} from '../../shared/types';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';
import { duplicateTimelineOrderKey, timelineOutputIssue } from '../../shared/timeline-policy';

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
  const scenes = array(source.scenes).slice(0,10_000).map(sanitizeScene);
  const sceneIds = new Set(scenes.map(s=>s.id));
  const assets = array(source.assets).slice(0,100_000).map(sanitizeAsset);
  const assetIds = new Set(assets.map(a=>a.id));
  const assetKinds = new Map(assets.map(a=>[a.id,a.kind] as const));
  const shots = array(source.shots).slice(0,100_000).map(value => sanitizeShot(value, sceneIds, assetIds, assetKinds));
  const shotIds = new Set(shots.map(s=>s.id));
  const renderOutputs = array(source.renderOutputs).slice(0,100_000).map(value => sanitizeRenderOutput(value, shotIds));
  const outputById = new Map(renderOutputs.map(output=>[output.id,output] as const));
  const renderJobs = array(source.renderJobs).slice(0,100_000).map(value => sanitizeRenderJob(value, shotIds, settings.workflowProfiles, sceneIds, assetIds, assetKinds));
  const jobIds=new Set(renderJobs.map(job=>job.id));
  const timeline = array(source.timeline).slice(0,100_000).map(value => sanitizeTimelineClip(value, shotIds, outputById));

  assertUniqueIds('scene',scenes);
  assertUniqueIds('asset',assets);
  assertUniqueIds('shot',shots);
  assertUniqueIds('render output',renderOutputs);
  assertUniqueIds('render job',renderJobs);
  assertUniqueIds('timeline clip',timeline);
  const duplicateTimelineOrder=duplicateTimelineOrderKey(timeline);
  if(duplicateTimelineOrder)throw new Error(`Duplicate timeline track/order slot: ${duplicateTimelineOrder}`);

  for (const scene of scenes){
    scene.shotIds=shots.filter(shot=>shot.sceneId===scene.id).sort((a,b)=>a.index-b.index).map(shot=>shot.id);
  }
  for(const shot of shots){
    const validLatest=shot.latestRenderId?renderOutputs.find(output=>output.id===shot.latestRenderId&&output.shotId===shot.id&&output.mediaType==='video'):undefined;
    if(!validLatest){
      const fallback=[...renderOutputs].filter(output=>output.shotId===shot.id&&output.mediaType==='video'&&output.technicalQc?.passed===true).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
      shot.latestRenderId=fallback?.id;
      if(shot.status==='rendered'&&!fallback)shot.status='ready';
    }
  }
  for(const job of renderJobs)job.outputs=renderOutputs.filter(output=>output.jobId===job.id&&output.shotId===job.shotId);
  for(const output of renderOutputs)if(!jobIds.has(output.jobId))output.jobId='orphaned';
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
  const profiles = array(source.workflowProfiles).slice(0,512).map(sanitizeWorkflowProfile);
  for (const builtin of BUILTIN_WORKFLOW_PROFILES) if (!profiles.some(p=>p.id===builtin.id)) profiles.push(structuredClone(builtin));
  assertUniqueIds('workflow profile',profiles);
  return {
    costPolicy: {
      mode: 'codex-capcut-only',
      allowCapcutAiCredits: source.costPolicy?.allowCapcutAiCredits===true
    },
    capcut: {
      enabled: typeof source.capcut?.enabled==='boolean'?source.capcut.enabled:true,
      pro: source.capcut?.pro === true
    },
    defaultFps: clampInt(source.defaultFps, 1, 120, 24),
    outputContainer: ['mp4','mov','webm'].includes(source.outputContainer) ? source.outputContainer : 'mp4',
    workflowProfiles: profiles
  };
}

function sanitizeWorkflowProfile(value: unknown): WorkflowProfile {
  const source = asObject(value, 'workflow profile');
  const format = source.workflowFormat === 'wangp-settings' ? 'wangp-settings' : source.workflowFormat === 'ui' ? 'ui' : 'api';
  const runtime = source.runtime === 'wangp' ? 'wangp' : source.runtime === 'comfyui' ? 'comfyui' : format === 'wangp-settings' ? 'wangp' : 'comfyui';
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
    enabled: source.enabled===true,
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
    required: source.required===true
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
    shotIds: array(source.shotIds).slice(0,100_000).map(safeId)
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
    sourcePath: sourceLabel(source.sourcePath),
    projectPath: path,
    mimeType: str(source.mimeType, '', 512) || undefined,
    tags: array(source.tags).map(v=>str(v,'',256)).filter(Boolean).slice(0,128),
    notes: str(source.notes, '', 100_000),
    createdAt: iso(source.createdAt, new Date().toISOString())
  };
}

function sanitizeShot(value: unknown, sceneIds: Set<string>, assetIds: Set<string>, assetKinds: Map<string,AssetKind>): Shot {
  const source = asObject(value, 'shot');
  const sceneId = safeId(source.sceneId);
  if (!sceneIds.has(sceneId)) throw new Error(`Shot references unknown scene: ${sceneId}`);
  const generationSource = asObject(source.generation ?? {}, 'shot generation');
  const rawModelFamily=typeof generationSource.modelFamily==='string'?generationSource.modelFamily:'';
  const modelFamily:ModelFamily = MODEL_FAMILIES.has(rawModelFamily as ModelFamily) ? rawModelFamily as ModelFamily : PRIMARY_VIDEO_MODEL;
  const defaults = MODEL_DEFAULTS[modelFamily];
  const rawIds = (value: unknown) => array(value).map(safeId).filter(id=>assetIds.has(id));
  const filterIds = (value: unknown, max:number, allowed:ReadonlySet<AssetKind>) => rawIds(value).filter(id=>allowed.has(assetKinds.get(id)!)).slice(0,max);
  const optionalAsset = (value: unknown, allowed:ReadonlySet<AssetKind>) => {
    if (typeof value !== 'string' || !value) return undefined;
    return assetIds.has(value)&&allowed.has(assetKinds.get(value)!) ? value : undefined;
  };
  const characterKinds=new Set<AssetKind>(['character']),locationKinds=new Set<AssetKind>(['location']),propKinds=new Set<AssetKind>(['prop','wardrobe']),referenceKinds=new Set<AssetKind>(['reference']);
  const startKinds=new Set<AssetKind>(['image','reference','keyframe','character','location']),endKinds=new Set<AssetKind>(['image','reference','keyframe']),videoKinds=new Set<AssetKind>(['video']),audioKinds=new Set<AssetKind>(['audio']);
  const rawPropIds=rawIds(source.propAssetIds);
  const legacyReferenceIds=source.referenceAssetIds==null?rawPropIds.filter(id=>assetKinds.get(id)==='reference'):[];
  const referenceAssetIds=[...new Set([...filterIds(source.referenceAssetIds,4,referenceKinds),...legacyReferenceIds])].slice(0,4);
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
    characterAssetIds: filterIds(source.characterAssetIds,4,characterKinds),
    locationAssetId: optionalAsset(source.locationAssetId,locationKinds),
    propAssetIds: rawPropIds.filter(id=>propKinds.has(assetKinds.get(id)!)).slice(0,2),
    referenceAssetIds,
    startFrameAssetId: optionalAsset(source.startFrameAssetId,startKinds),
    endFrameAssetId: optionalAsset(source.endFrameAssetId,endKinds),
    referenceVideoAssetId: optionalAsset(source.referenceVideoAssetId,videoKinds),
    audioAssetId: optionalAsset(source.audioAssetId,audioKinds),
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
      includeAudio: typeof generationSource.includeAudio==='boolean'?generationSource.includeAudio:(defaults.includeAudio??false),
      workflowProfileId: typeof generationSource.workflowProfileId === 'string' ? generationSource.workflowProfileId : undefined
    },
    latestRenderId: typeof source.latestRenderId === 'string' ? source.latestRenderId : undefined
  };
}

function sanitizeRenderOutput(value: unknown, shotIds: Set<string>): RenderOutput {
  const source = asObject(value, 'render output');
  const shotId = safeId(source.shotId),path=str(source.path,'',4096);
  if (!shotIds.has(shotId)) throw new Error(`Render output references unknown shot: ${shotId}`);
  if(!path)throw new Error('Render output path is required.');
  return {
    id:safeId(source.id), jobId:safeId(source.jobId), shotId,
    path, filename:str(source.filename,'output',2048),
    mediaType:['video','image','audio'].includes(source.mediaType) ? source.mediaType : 'unknown',
    createdAt:iso(source.createdAt,new Date().toISOString()),
    comfyMeta:sanitizeComfyMeta(source.comfyMeta),
    technicalQc:sanitizeTechnicalQc(source.technicalQc)
  };
}

function sanitizeRenderJob(value: unknown, shotIds: Set<string>, profiles: WorkflowProfile[], sceneIds:Set<string>, assetIds:Set<string>, assetKinds:Map<string,AssetKind>): RenderJob {
  const source = asObject(value, 'render job');
  const shotId = safeId(source.shotId);
  if (!shotIds.has(shotId)) throw new Error(`Render job references unknown shot: ${shotId}`);
  const profileId = typeof source.workflowProfileId === 'string' ? source.workflowProfileId : undefined;
  let spec: RenderJob['spec'];
  if(source.spec&&typeof source.spec==='object'){
    const rawSpec=asObject(source.spec,'render job spec');
    const workflowProfile=sanitizeWorkflowProfile(rawSpec.workflowProfile);
    const runtimeRaw=rawSpec.runtimeFingerprint&&typeof rawSpec.runtimeFingerprint==='object'?rawSpec.runtimeFingerprint:{};
    const specShot=sanitizeShot(rawSpec.shot,sceneIds,assetIds,assetKinds);
    if(specShot.id!==shotId)throw new Error(`Render job ${String(source.id)} immutable spec shot id ${specShot.id} does not match job shotId ${shotId}.`);
    spec={
      shot:specShot,
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
    workflowProfileId: profileId && profiles.some(p=>p.id===profileId) ? profileId : undefined,
    comfyPromptId:str(source.comfyPromptId,'',512)||undefined,
    backendPid:Number.isInteger(source.backendPid)&&source.backendPid>0?source.backendPid:undefined,
    lastHeartbeatAt:maybeIso(source.lastHeartbeatAt),
    error:str(source.error,'',50_000)||undefined,
    outputs:[],
    spec
  };
}

function sanitizeTimelineClip(value: unknown, shotIds: Set<string>, outputs: Map<string,RenderOutput>): TimelineClip {
  const source = asObject(value, 'timeline clip');
  const id=safeId(source.id),shotId=safeId(source.shotId),renderOutputId=safeId(source.renderOutputId);
  if(!shotIds.has(shotId))throw new Error(`Timeline references unknown shot: ${shotId}`);
  const issue=timelineOutputIssue({id,shotId,renderOutputId},outputs.get(renderOutputId));if(issue)throw new Error(issue);
  const trimIn=clampNumber(source.trimInSec,0,1_000_000,0);
  const trimOut=source.trimOutSec==null?undefined:clampNumber(source.trimOutSec,0,1_000_000,undefined as any);
  if(trimOut!=null&&trimOut<=trimIn)throw new Error('Timeline trimOutSec must be greater than trimInSec.');
  return { id,shotId,renderOutputId,track:clampInt(source.track,0,128,0),order:clampInt(source.order,0,1_000_000,0),trimInSec:trimIn,trimOutSec:trimOut,volume:clampNumber(source.volume,0,8,1) };
}

function sanitizeComfyMeta(value:unknown):Record<string,unknown>|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const source=value as Record<string,unknown>,out:Record<string,unknown>={};
  for(const key of ['filename','subfolder','type','runtime','profile']){
    const v=source[key];if(typeof v==='string')out[key]=v.slice(0,4096);
  }
  return Object.keys(out).length?out:undefined;
}
function sanitizeTechnicalQc(value:unknown):RenderOutput['technicalQc']{
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const source=value as Record<string,unknown>;
  return{
    checkedAt:iso(source.checkedAt,new Date().toISOString()),
    passed:source.passed===true,
    durationSec:finiteOptional(source.durationSec,0,1_000_000),
    width:intOptional(source.width,1,16384),
    height:intOptional(source.height,1,16384),
    fps:finiteOptional(source.fps,0,1000),
    hasAudio:typeof source.hasAudio==='boolean'?source.hasAudio:undefined,
    audioPeakDb:finiteOptional(source.audioPeakDb,-300,100),
    issues:array(source.issues).slice(0,128).map(item=>str(item,'',4096)).filter(Boolean),
    warnings:array(source.warnings).slice(0,128).map(item=>str(item,'',4096)).filter(Boolean)
  };
}
function finiteOptional(value:unknown,min:number,max:number):number|undefined{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):undefined;}
function intOptional(value:unknown,min:number,max:number):number|undefined{const n=Number(value);return Number.isInteger(n)?Math.min(max,Math.max(min,n)):undefined;}

function assertUniqueIds(label:string,items:Array<{id:string}>):void{
  const seen=new Set<string>();for(const item of items){if(seen.has(item.id))throw new Error(`Duplicate ${label} id: ${item.id}`);seen.add(item.id);}
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
function sourceLabel(value:unknown):string{
  if(typeof value!=='string')return'';
  const parts=value.replace(/\\/g,'/').split('/').filter(Boolean);
  return (parts.at(-1)||'').slice(0,2048);
}
function sha(value: unknown): string | undefined { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined; }
