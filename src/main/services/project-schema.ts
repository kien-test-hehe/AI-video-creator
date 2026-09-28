import { randomUUID } from 'node:crypto';
import type {
  Asset, AssetKind, FilmProject, GenerationMode, ModelFamily, ProjectSettings, QualityIntent, RenderJob,
  RenderJobStatus, RenderOutput, Scene, Shot, ShotStatus, TimelineClip, WorkflowBinding, WorkflowProfile, WorkflowPurpose
} from '../../shared/types';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';
import { duplicateTimelineOrderKey, timelineOutputIssue } from '../../shared/timeline-policy';
import { assertSafeJsonPath, assertSafeObjectKey } from '../../shared/safe-object';

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

export class UnsupportedProjectSchemaError extends Error {}

export function loadPortableProject(raw: unknown, openedRoot: string): LoadedProject {
  const source = asObject(raw, 'project');
  const version = Number(source.schemaVersion ?? 1);
  if (version !== 1 && version !== 2) throw new UnsupportedProjectSchemaError(`Unsupported project schema: ${String(source.schemaVersion)}`);
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
  const id = safeId(source.id,true);
  const settings = sanitizeProjectSettings(source.settings);
  const scenes = boundedArray(source.scenes,'project scenes',10_000).map(sanitizeScene);
  const sceneIds = new Set(scenes.map(s=>s.id));
  const assets = boundedArray(source.assets,'project assets',100_000).map(sanitizeAsset);
  const assetIds = new Set(assets.map(a=>a.id));
  const assetKinds = new Map(assets.map(a=>[a.id,a.kind] as const));
  const shots = boundedArray(source.shots,'project shots',100_000).map(value => sanitizeShot(value, sceneIds, assetIds, assetKinds));
  const shotIds = new Set(shots.map(s=>s.id));
  const renderOutputs = boundedArray(source.renderOutputs,'project render outputs',100_000).map(value => sanitizeRenderOutput(value, shotIds));
  const outputById = new Map(renderOutputs.map(output=>[output.id,output] as const));
  const renderJobs = boundedArray(source.renderJobs,'project render jobs',100_000).map(value => sanitizeRenderJob(value, shotIds, settings.workflowProfiles, sceneIds, assetIds, assetKinds));
  const jobIds=new Set(renderJobs.map(job=>job.id));
  const timeline = boundedArray(source.timeline,'project timeline clips',100_000).map(value => sanitizeTimelineClip(value, shotIds, outputById));

  assertUniqueIds('scene',scenes);
  assertUniqueIds('asset',assets);
  assertUniqueIds('shot',shots);
  assertUniqueIds('render output',renderOutputs);
  assertUniqueIds('render job',renderJobs);
  assertUniqueIds('timeline clip',timeline);
  const duplicateTimelineOrder=duplicateTimelineOrderKey(timeline);
  if(duplicateTimelineOrder)throw new Error(`Duplicate timeline track/order slot: ${duplicateTimelineOrder}`);

  const shotsByScene=new Map<string,Shot[]>();
  for(const shot of shots){const list=shotsByScene.get(shot.sceneId)??[];list.push(shot);shotsByScene.set(shot.sceneId,list);}
  for(const scene of scenes)scene.shotIds=(shotsByScene.get(scene.id)??[]).sort((a,b)=>a.index-b.index).map(shot=>shot.id);

  for(const shot of shots){
    const latest=shot.latestRenderId?outputById.get(shot.latestRenderId):undefined;
    const validLatest=latest&&latest.shotId===shot.id&&latest.mediaType==='video'?latest:undefined;
    if(!validLatest){
      shot.latestRenderId=undefined;
      if(shot.status==='rendered')shot.status='ready';
    }
  }

  const jobShotById=new Map(renderJobs.map(job=>[job.id,job.shotId] as const)),outputsByJobShot=new Map<string,RenderOutput[]>();
  for(const output of renderOutputs){
    if(!jobIds.has(output.jobId)||jobShotById.get(output.jobId)!==output.shotId){output.jobId='orphaned';continue;}
    const key=`${output.jobId}\u0000${output.shotId}`,list=outputsByJobShot.get(key)??[];list.push(output);outputsByJobShot.set(key,list);
  }
  for(const job of renderJobs)job.outputs=outputsByJobShot.get(`${job.id}\u0000${job.shotId}`)??[];
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
  const profiles = boundedArray(source.workflowProfiles,'workflow profiles',512).map(sanitizeWorkflowProfile);
  for (const builtin of BUILTIN_WORKFLOW_PROFILES) if (!profiles.some(p=>p.id===builtin.id)) profiles.push(structuredClone(builtin));
  if(profiles.length>512)throw new Error('workflow profiles exceed the safety limit of 512 items after required built-ins are added.');
  assertUniqueIds('workflow profile',profiles);
  return {
    costPolicy: {
      mode: 'codex-capcut-only',
      allowCapcutAiCredits: booleanOrDefault(source.costPolicy?.allowCapcutAiCredits,false,'CapCut AI credits policy')
    },
    capcut: {
      enabled: booleanOrDefault(source.capcut?.enabled,true,'CapCut enabled setting'),
      pro: booleanOrDefault(source.capcut?.pro,false,'CapCut Pro setting')
    },
    defaultFps: clampInt(source.defaultFps, 1, 120, 24),
    outputContainer: enumOrDefault(source.outputContainer,new Set(['mp4','mov','webm'] as const),'mp4','project output container'),
    workflowProfiles: profiles
  };
}

function sanitizeWorkflowProfile(value: unknown): WorkflowProfile {
  const source = asObject(value, 'workflow profile');
  const format = enumOrDefault(source.workflowFormat,new Set(['wangp-settings','ui','api'] as const),'api','workflow format');
  const runtime = source.runtime==null||source.runtime===''?(format==='wangp-settings'?'wangp':'comfyui'):enumOrDefault(source.runtime,new Set(['wangp','comfyui'] as const),'comfyui','workflow runtime');
  const validationSource = optionalObject(source.validation,'workflow validation') ?? {};
  return {
    id: safeId(source.id),
    runtime,
    purpose: enumOrDefault(source.purpose,PURPOSES,'video','workflow purpose'),
    name: str(source.name, 'Workflow', 240),
    modelFamily: enumOrDefault(source.modelFamily,MODEL_FAMILIES,'custom','workflow model family'),
    mode: enumOrDefault(source.mode,MODES,'i2v','workflow generation mode'),
    workflowPath: str(source.workflowPath, '', 4096),
    workflowFormat: format,
    bindings: boundedArray(source.bindings,'workflow bindings',256).map(sanitizeBinding),
    enabled: booleanOrDefault(source.enabled,false,'workflow enabled flag'),
    notes: str(source.notes, '', 20_000) || undefined,
    modelFingerprint: str(source.modelFingerprint, '', 512) || undefined,
    validation: {
      structuralStatus: enumOrDefault(validationSource.structuralStatus,new Set(['valid','invalid','unvalidated'] as const),'unvalidated','workflow validation status'),
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
  const input=str(source.input,'',256)||undefined,jsonPath=str(source.jsonPath,'',1024)||undefined;
  if(input)assertSafeObjectKey(input,'Workflow binding input');
  if(jsonPath)assertSafeJsonPath(jsonPath,'Workflow binding JSON path');
  return {
    key: source.key,
    selector,
    input,
    jsonPath,
    transform: enumOrDefault(source.transform,new Set(['integer','float','boolean','string','identity'] as const),'identity','workflow binding transform'),
    required: booleanOrDefault(source.required,false,'workflow binding required flag')
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
    shotIds: boundedArray(source.shotIds,'scene shot ids',100_000).map(safeId)
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
    tags: boundedArray(source.tags,'asset tags',128).map(v=>str(v,'',256)).filter(Boolean),
    notes: str(source.notes, '', 100_000),
    createdAt: iso(source.createdAt, new Date().toISOString())
  };
}

function sanitizeShot(value: unknown, sceneIds: Set<string>, assetIds: Set<string>, assetKinds: Map<string,AssetKind>): Shot {
  const source = asObject(value, 'shot');
  const sceneId = safeId(source.sceneId);
  if (!sceneIds.has(sceneId)) throw new Error(`Shot references unknown scene: ${sceneId}`);
  const generationSource = asObject(source.generation ?? {}, 'shot generation');
  const modelFamily=enumOrDefault(generationSource.modelFamily,MODEL_FAMILIES,PRIMARY_VIDEO_MODEL,'shot model family');
  const defaults = MODEL_DEFAULTS[modelFamily];
  const rawIds = (value: unknown) => boundedArray(value,'shot asset references',128).map(safeId).filter(id=>assetIds.has(id));
  const filterIds = (value: unknown, max:number, allowed:ReadonlySet<AssetKind>) => {const filtered=rawIds(value).filter(id=>allowed.has(assetKinds.get(id)!));if(filtered.length>max)throw new Error(`Shot asset role exceeds the ${max}-item safety limit.`);return filtered;};
  const optionalAsset = (value: unknown, allowed:ReadonlySet<AssetKind>) => {
    const id=optionalString(value,'shot asset reference');if(!id)return undefined;
    return assetIds.has(id)&&allowed.has(assetKinds.get(id)!) ? id : undefined;
  };
  const characterKinds=new Set<AssetKind>(['character']),locationKinds=new Set<AssetKind>(['location']),propKinds=new Set<AssetKind>(['prop','wardrobe']),referenceKinds=new Set<AssetKind>(['reference']);
  const startKinds=new Set<AssetKind>(['image','reference','keyframe','character','location']),endKinds=new Set<AssetKind>(['image','reference','keyframe']),videoKinds=new Set<AssetKind>(['video']),audioKinds=new Set<AssetKind>(['audio']);
  const rawPropIds=rawIds(source.propAssetIds);
  const legacyReferenceIds=source.referenceAssetIds==null?rawPropIds.filter(id=>assetKinds.get(id)==='reference'):[];
  const referenceAssetIds=[...new Set([...filterIds(source.referenceAssetIds,4,referenceKinds),...legacyReferenceIds])];if(referenceAssetIds.length>4)throw new Error('Shot reference assets exceed the 4-item safety limit.');
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
    propAssetIds: (()=>{const ids=rawPropIds.filter(id=>propKinds.has(assetKinds.get(id)!));if(ids.length>2)throw new Error('Shot prop/wardrobe assets exceed the 2-item safety limit.');return ids;})(),
    referenceAssetIds,
    startFrameAssetId: optionalAsset(source.startFrameAssetId,startKinds),
    endFrameAssetId: optionalAsset(source.endFrameAssetId,endKinds),
    referenceVideoAssetId: optionalAsset(source.referenceVideoAssetId,videoKinds),
    audioAssetId: optionalAsset(source.audioAssetId,audioKinds),
    status: enumOrDefault(source.status,SHOT_STATUSES,'draft','shot status'),
    generation: {
      modelFamily,
      mode: enumOrDefault(generationSource.mode,MODES,defaults.mode ?? 'i2v','shot generation mode'),
      quality: enumOrDefault(generationSource.quality,QUALITIES,defaults.quality ?? 'balanced','shot quality intent'),
      width: clampInt(generationSource.width,256,8192,defaults.width ?? 768),
      height: clampInt(generationSource.height,256,8192,defaults.height ?? 432),
      frames: clampInt(generationSource.frames,1,100_000,defaults.frames ?? 121),
      fps: clampInt(generationSource.fps,1,240,defaults.fps ?? 24),
      steps: generationSource.steps == null ? defaults.steps : clampInt(generationSource.steps,1,1000,defaults.steps ?? 20),
      cfg: generationSource.cfg == null ? defaults.cfg : clampNumber(generationSource.cfg,0,100,defaults.cfg ?? 1),
      seed: clampInt(generationSource.seed,0,2_147_483_647,Math.floor(Math.random()*2_147_483_647)),
      negativePrompt: str(generationSource.negativePrompt,'',100_000),
      includeAudio: booleanOrDefault(generationSource.includeAudio,defaults.includeAudio??false,'shot includeAudio flag'),
      workflowProfileId: optionalString(generationSource.workflowProfileId,'shot workflow profile id')
    },
    latestRenderId: optionalString(source.latestRenderId,'shot latest render id')
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
    mediaType:enumOrDefault(source.mediaType,new Set(['video','image','audio','unknown'] as const),'unknown','render output media type'),
    createdAt:iso(source.createdAt,new Date().toISOString()),
    comfyMeta:sanitizeComfyMeta(source.comfyMeta),
    technicalQc:sanitizeTechnicalQc(source.technicalQc)
  };
}

function sanitizeRenderJob(value: unknown, shotIds: Set<string>, profiles: WorkflowProfile[], sceneIds:Set<string>, assetIds:Set<string>, assetKinds:Map<string,AssetKind>): RenderJob {
  const source = asObject(value, 'render job');
  const shotId = safeId(source.shotId);
  if (!shotIds.has(shotId)) throw new Error(`Render job references unknown shot: ${shotId}`);
  const profileId = optionalString(source.workflowProfileId,'render job workflow profile id');
  let spec: RenderJob['spec'];
  const rawSpec=optionalObject(source.spec,'render job spec');
  if(rawSpec){
    const workflowProfile=sanitizeWorkflowProfile(rawSpec.workflowProfile);
    const runtimeRaw=optionalObject(rawSpec.runtimeFingerprint,'runtime fingerprint') ?? {};
    const specShot=sanitizeShot(rawSpec.shot,sceneIds,assetIds,assetKinds);
    if(specShot.id!==shotId)throw new Error(`Render job ${String(source.id)} immutable spec shot id ${specShot.id} does not match job shotId ${shotId}.`);
    spec={
      shot:specShot,
      workflowProfile,
      effectivePrompt:str(rawSpec.effectivePrompt,'',300_000),
      queuedProjectUpdatedAt:iso(rawSpec.queuedProjectUpdatedAt,new Date().toISOString()),
      workflowSha256:sha(rawSpec.workflowSha256)??'0'.repeat(64),
      assetFingerprints:boundedArray(rawSpec.assetFingerprints,'render job asset fingerprints',32).map(item=>{
        const fp=asObject(item,'asset fingerprint');return{assetId:safeId(fp.assetId),projectPath:str(fp.projectPath,'',4096),sha256:sha(fp.sha256)??'0'.repeat(64)};
      }),
      runtimeFingerprint:{
        backend:enumOrDefault(runtimeRaw.backend,new Set(['wangp','comfyui'] as const),'comfyui','runtime fingerprint backend'),
        executionMode:optionalEnum(runtimeRaw.executionMode,new Set(['docker','native'] as const),'runtime fingerprint execution mode'),
        runtimeVersion:str(runtimeRaw.runtimeVersion,'',2048)||undefined,
        runtimeSha256:sha(runtimeRaw.runtimeSha256),
        environmentSha256:sha(runtimeRaw.environmentSha256)??'0'.repeat(64)
      },
      modelFingerprint:str(rawSpec.modelFingerprint,'',512)||undefined
    };
  }
  return {
    id:safeId(source.id), shotId, createdAt:iso(source.createdAt,new Date().toISOString()), updatedAt:iso(source.updatedAt,new Date().toISOString()),
    status:enumOrDefault(source.status,JOB_STATUSES,'failed','render job status'), progress:clampNumber(source.progress,0,1,0),
    message:str(source.message,'',10_000), modelFamily:enumOrDefault(source.modelFamily,MODEL_FAMILIES,'custom','render job model family'),
    workflowProfileId: profileId && profiles.some(p=>p.id===profileId) ? profileId : undefined,
    comfyPromptId:str(source.comfyPromptId,'',512)||undefined,
    backendPid:optionalPositiveInteger(source.backendPid,'render job backend pid'),
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
  const source=optionalObject(value,'Comfy metadata');if(!source)return undefined;const out:Record<string,unknown>={};
  for(const key of ['filename','subfolder','type','runtime','profile']){
    const v=source[key];if(v==null)continue;if(typeof v!=='string')throw new Error(`Comfy metadata ${key} must be a string.`);if(v.length>4096)throw new Error(`Comfy metadata ${key} exceeds the 4096-character project safety limit.`);out[key]=v;
  }
  return Object.keys(out).length?out:undefined;
}
function sanitizeTechnicalQc(value:unknown):RenderOutput['technicalQc']{
  const source=optionalObject(value,'technical QC');if(!source)return undefined;
  return{
    checkedAt:iso(source.checkedAt,new Date().toISOString()),
    passed:booleanOrDefault(source.passed,false,'technical QC passed flag'),
    durationSec:finiteOptional(source.durationSec,0,1_000_000),
    width:intOptional(source.width,1,16384),
    height:intOptional(source.height,1,16384),
    fps:finiteOptional(source.fps,0,1000),
    hasAudio:optionalBoolean(source.hasAudio,'technical QC hasAudio flag'),
    audioPeakDb:finiteOptional(source.audioPeakDb,-300,100),
    issues:boundedArray(source.issues,'technical QC issues',128).map(item=>str(item,'',4096)).filter(Boolean),
    warnings:boundedArray(source.warnings,'technical QC warnings',128).map(item=>str(item,'',4096)).filter(Boolean)
  };
}
function finiteOptional(value:unknown,min:number,max:number):number|undefined{if(value==null||value==='')return undefined;const n=Number(value);if(!Number.isFinite(n))throw new Error(`Project optional number is not finite: ${String(value).slice(0,128)}`);if(n<min||n>max)throw new Error(`Project optional number is outside the allowed range ${min}..${max}: ${n}`);return n;}
function intOptional(value:unknown,min:number,max:number):number|undefined{if(value==null||value==='')return undefined;const n=Number(value);if(!Number.isInteger(n))throw new Error(`Project optional integer is invalid: ${String(value).slice(0,128)}`);if(n<min||n>max)throw new Error(`Project optional integer is outside the allowed range ${min}..${max}: ${n}`);return n;}

function assertUniqueIds(label:string,items:Array<{id:string}>):void{
  const seen=new Set<string>();for(const item of items){if(seen.has(item.id))throw new Error(`Duplicate ${label} id: ${item.id}`);seen.add(item.id);}
}

function optionalObject(value:unknown,label:string):Record<string,any>|undefined{
  if(value==null)return undefined;
  if(typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid ${label}: expected an object.`);
  return value as Record<string,any>;
}
function optionalString(value:unknown,label:string):string|undefined{
  if(value==null||value==='')return undefined;
  if(typeof value!=='string')throw new Error(`Invalid ${label}: expected a string.`);
  return value;
}
function optionalPositiveInteger(value:unknown,label:string):number|undefined{
  if(value==null||value==='')return undefined;
  const n=Number(value);if(!Number.isInteger(n)||n<=0)throw new Error(`Invalid ${label}: expected a positive integer.`);return n;
}
function asObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected an object.`);
  return value as Record<string, any>;
}
function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function boundedArray(value:unknown,label:string,max:number):any[]{const items=array(value);if(items.length>max)throw new Error(`${label} exceed the safety limit of ${max} items.`);return items;}
function str(value: unknown, fallback: string, max: number): string { if(value==null)return fallback;if(typeof value!=='string')throw new Error(`Project string must be a string, got ${typeof value}.`);if(value.length>max)throw new Error(`Project string exceeds the ${max}-character safety limit.`);return value; }
function booleanOrDefault(value:unknown,fallback:boolean,label:string):boolean{
  if(value==null||value==='')return fallback;
  if(typeof value==='boolean')return value;
  throw new Error(`Invalid ${label}: expected boolean.`);
}
function optionalBoolean(value:unknown,label:string):boolean|undefined{
  if(value==null||value==='')return undefined;
  if(typeof value==='boolean')return value;
  throw new Error(`Invalid ${label}: expected boolean.`);
}
function enumOrDefault<T extends string>(value:unknown,allowed:ReadonlySet<T>,fallback:T,label:string):T{
  if(value==null||value==='')return fallback;
  if(typeof value==='string'&&allowed.has(value as T))return value as T;
  throw new Error(`Invalid ${label}: ${String(value).slice(0,128)}`);
}
function optionalEnum<T extends string>(value:unknown,allowed:ReadonlySet<T>,label:string):T|undefined{
  if(value==null||value==='')return undefined;
  if(typeof value==='string'&&allowed.has(value as T))return value as T;
  throw new Error(`Invalid ${label}: ${String(value).slice(0,128)}`);
}
function safeId(value: unknown,allowMissing=false): string {
  if(value==null||value===''){if(allowMissing)return randomUUID();throw new Error('Missing canonical project entity identifier.');}
  if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(value)) return value;
  throw new Error(`Invalid project identifier: ${typeof value==='string'?value.slice(0,128):String(value)}`);
}
function clampInt(value: unknown,min:number,max:number,fallback:number):number{if(value==null||value==='')return fallback;const n=Number(value);if(!Number.isInteger(n))throw new Error(`Project integer is invalid: ${String(value).slice(0,128)}`);if(n<min||n>max)throw new Error(`Project integer is outside the allowed range ${min}..${max}: ${n}`);return n;}
function clampNumber(value: unknown,min:number,max:number,fallback:number):number{if(value==null||value==='')return fallback;const n=Number(value);if(!Number.isFinite(n))throw new Error(`Project number is invalid: ${String(value).slice(0,128)}`);if(n<min||n>max)throw new Error(`Project number is outside the allowed range ${min}..${max}: ${n}`);return n;}
function iso(value: unknown, fallback: string): string { if(value==null||value==='')return fallback;if(typeof value!=='string')throw new Error('Project timestamp must be an ISO-compatible string.');const time=Date.parse(value);if(!Number.isFinite(time))throw new Error(`Invalid project timestamp: ${value.slice(0,128)}`);return new Date(time).toISOString(); }
function maybeIso(value: unknown): string | undefined { if(value==null||value==='')return undefined;if(typeof value!=='string')throw new Error('Optional project timestamp must be an ISO-compatible string.');const time=Date.parse(value);if(!Number.isFinite(time))throw new Error(`Invalid optional project timestamp: ${value.slice(0,128)}`);return new Date(time).toISOString(); }
function sourceLabel(value:unknown):string{
  if(typeof value!=='string')return'';
  const parts=value.replace(/\\/g,'/').split('/').filter(Boolean),label=parts.at(-1)||'';
  if(label.length>2048)throw new Error('Asset source label exceeds the 2048-character project safety limit.');
  return label;
}
function sha(value: unknown): string | undefined { if(value==null||value==='')return undefined;if(typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value))return value.toLowerCase();throw new Error('Invalid SHA-256 project fingerprint.'); }
