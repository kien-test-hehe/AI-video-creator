import { randomUUID } from 'node:crypto';
import type {
  Asset, AssetKind, ContinuityField, CutRevision, FilmProject, GenerationMode, HumanTask, ModelFamily, ProjectSettings, QualityIntent, QcIssue, RenderJob,
  RenderJobStatus, RenderOutput, Scene, Shot, ShotDependency, ShotQcResult, ShotState, ShotStatus, TimelineClip, WorkflowBinding, WorkflowProfile, WorkflowPurpose
} from '../../shared/types';
import { BUILTIN_WORKFLOW_PROFILES, MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../shared/defaults';
import { duplicateTimelineOrderKey, timelineOutputIssue } from '../../shared/timeline-policy';
import { assertSafeJsonPath, assertSafeObjectKey } from '../../shared/safe-object';
import { WORKFLOW_BINDING_CLASS_TYPE_LIMIT, WORKFLOW_BINDING_INPUT_LIMIT, WORKFLOW_BINDING_JSON_PATH_LIMIT, WORKFLOW_BINDING_LIMIT, WORKFLOW_BINDING_NODE_ID_LIMIT, WORKFLOW_BINDING_TITLE_LIMIT, WORKFLOW_PROFILE_LIMIT, WORKFLOW_PROFILE_NOTES_LIMIT } from '../../shared/workflow-limits';
import { assertAcyclicShotDependencies, defaultSequentialDependencies, invalidateStateCascade } from '../../shared/production-state';

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
  if (version !== 1 && version !== 2 && version !== 3) throw new UnsupportedProjectSchemaError(`Unsupported project schema: ${String(source.schemaVersion)}`);
  const migrationNotes: string[] = [];
  let normalized:Record<string,any>=source;
  if(version===1)normalized=migrateV1ToV2(normalized,migrationNotes);
  if(version<3)normalized=migrateV2ToV3(normalized,migrationNotes);
  const project = sanitizeV3(normalized, openedRoot);
  if(version<3&&project.shotDependencies.length===0)project.shotDependencies=defaultSequentialDependencies(project.shots,project.createdAt);
  return { project, ...(version < 3 ? { migratedFrom: version } : {}), migrationNotes };
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

function migrateV2ToV3(source:Record<string,any>,notes:string[]):Record<string,any>{
  notes.push('Migrated project schema v2 → v3 production-state model.');
  return {
    ...source,
    schemaVersion:3,
    shotStates:source.shotStates??[],
    shotDependencies:source.shotDependencies??[],
    qcResults:source.qcResults??[],
    humanTasks:source.humanTasks??[],
    cutRevisions:source.cutRevisions??[]
  };
}

function sanitizeV3(source: Record<string, any>, openedRoot: string): FilmProject {
  const now = new Date().toISOString();
  const id = safeId(source.id,true);
  const storySource=optionalObject(source.story,'story')??{};
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
  const shotStates = boundedArray(source.shotStates,'shot states',200_000).map(value=>sanitizeShotState(value,shotIds,assetIds,outputById));
  const stateById=new Map(shotStates.map(state=>[state.id,state] as const));
  const shotDependencies = boundedArray(source.shotDependencies,'shot dependencies',200_000).map(value=>sanitizeShotDependency(value,shotIds));
  const qcResults = boundedArray(source.qcResults,'shot QC results',300_000).map(value=>sanitizeShotQcResult(value,shotIds,outputById));
  const humanTasks = boundedArray(source.humanTasks,'human tasks',100_000).map(value=>sanitizeHumanTask(value,shotIds,assetIds,outputById));
  const cutRevisions = boundedArray(source.cutRevisions,'cut revisions',10_000).map(value=>sanitizeCutRevision(value,new Set(timeline.map(clip=>clip.id))));
  const unsafeActualStartStateIds:string[]=[];

  assertUniqueIds('scene',scenes);
  assertUniqueIds('asset',assets);
  assertUniqueIds('shot',shots);
  assertUniqueIds('render output',renderOutputs);
  assertUniqueIds('render job',renderJobs);
  assertUniqueIds('timeline clip',timeline);
  assertUniqueIds('shot state',shotStates);
  assertUniqueIds('shot dependency',shotDependencies);
  assertAcyclicShotDependencies(shots,scenes,shotDependencies);
  assertUniqueIds('shot QC result',qcResults);
  assertUniqueIds('human task',humanTasks);
  assertUniqueIds('cut revision',cutRevisions);
  for(const state of shotStates){
    if(state.derivedFromStateId&&!stateById.has(state.derivedFromStateId))throw new Error(`Shot state ${state.id} derives from missing state ${state.derivedFromStateId}.`);
    if(state.derivedFromStateId===state.id)throw new Error(`Shot state ${state.id} cannot derive from itself.`);
  }
  const humanTaskById=new Map(humanTasks.map(task=>[task.id,task] as const));
  for(const result of qcResults){
    if(!result.humanOverrideTaskId)continue;
    const task=humanTaskById.get(result.humanOverrideTaskId);
    if(!task)throw new Error(`QC result ${result.id} references missing human task ${result.humanOverrideTaskId}.`);
    if(task.shotId!==result.shotId)throw new Error(`QC result ${result.id} links to human task ${task.id} from a different shot.`);
    if(result.renderOutputId&&!task.relatedRenderOutputIds.includes(result.renderOutputId))throw new Error(`QC result ${result.id} links to human task ${task.id} that does not reference render output ${result.renderOutputId}.`);
    const expectedType=result.layer==='continuity'?'verify-continuity':'manual-qc';
    if(result.layer!=='technical'&&task.type!==expectedType)throw new Error(`QC result ${result.id} links to incompatible human task type ${task.type}; expected ${expectedType}.`);
  }
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
    for(const key of ['latestAttemptRenderId','canonicalRenderId'] as const){
      const outputId=shot[key],output=outputId?outputById.get(outputId):undefined;
      if(outputId&&(!output||output.shotId!==shot.id||output.mediaType!=='video'))throw new Error(`Shot ${shot.id} ${key} references an invalid render output: ${outputId}`);
    }
    const stateRefs:[keyof Pick<Shot,'plannedStartStateId'|'plannedEndStateId'|'actualStartStateId'|'observedFinalStateId'>,'planned-start'|'planned-end'|'actual-start'|'observed-final'][]=[
      ['plannedStartStateId','planned-start'],['plannedEndStateId','planned-end'],['actualStartStateId','actual-start'],['observedFinalStateId','observed-final']
    ];
    for(const[key,role]of stateRefs){
      const stateId=shot[key],state=stateId?stateById.get(stateId):undefined;
      if(stateId&&(!state||state.shotId!==shot.id||state.role!==role))throw new Error(`Shot ${shot.id} ${String(key)} references an invalid ${role} state: ${stateId}`);
    }
    const actualStart=shot.actualStartStateId?stateById.get(shot.actualStartStateId):undefined;
    if(actualStart&&actualStart.source!=='human'&&actualStart.status!=='current'&&actualStart.frameAssetId&&shot.startFrameAssetId===actualStart.frameAssetId){
      unsafeActualStartStateIds.push(actualStart.id);
    }
  }

  const jobShotById=new Map(renderJobs.map(job=>[job.id,job.shotId] as const)),outputsByJobShot=new Map<string,RenderOutput[]>();
  for(const output of renderOutputs){
    if(!jobIds.has(output.jobId)||jobShotById.get(output.jobId)!==output.shotId){output.jobId='orphaned';continue;}
    const key=`${output.jobId}\u0000${output.shotId}`,list=outputsByJobShot.get(key)??[];list.push(output);outputsByJobShot.set(key,list);
  }
  for(const job of renderJobs)job.outputs=outputsByJobShot.get(`${job.id}\u0000${job.shotId}`)??[];
  const project:FilmProject={
    schemaVersion: 3,
    id,
    name: str(source.name, 'Untitled Film', 240),
    createdAt: iso(source.createdAt, now),
    updatedAt: iso(source.updatedAt, now),
    rootPath: openedRoot,
    story: {
      title: str(storySource.title, str(source.name, 'Untitled Film', 240), 500),
      logline: str(storySource.logline, '', 10_000),
      script: str(storySource.script, '', 2_000_000),
      notes: str(storySource.notes, '', 200_000)
    },
    scenes, assets, shots, renderJobs, renderOutputs, timeline, shotStates, shotDependencies, qcResults, humanTasks, cutRevisions, settings
  };
  if(unsafeActualStartStateIds.length){
    invalidateStateCascade(project,unsafeActualStartStateIds,'Legacy project contained an unreviewed propagated start frame that could have been used as generation conditioning; downstream derived state was invalidated on load.');
  }
  return project;
}

function sanitizeProjectSettings(value: unknown): ProjectSettings {
  const source = asObject(value ?? {}, 'settings');
  const costPolicy=optionalObject(source.costPolicy,'project cost policy')??{},capcut=optionalObject(source.capcut,'CapCut project settings')??{};
  const profiles = boundedArray(source.workflowProfiles,'workflow profiles',512).map(sanitizeWorkflowProfile);
  for (const builtin of BUILTIN_WORKFLOW_PROFILES) if (!profiles.some(p=>p.id===builtin.id)) profiles.push(structuredClone(builtin));
  if(profiles.length>WORKFLOW_PROFILE_LIMIT)throw new Error(`workflow profiles exceed the safety limit of ${WORKFLOW_PROFILE_LIMIT} items after required built-ins are added.`);
  assertUniqueIds('workflow profile',profiles);
  return {
    costPolicy: {
      mode: 'codex-capcut-only',
      allowCapcutAiCredits: booleanOrDefault(costPolicy.allowCapcutAiCredits,false,'CapCut AI credits policy')
    },
    capcut: {
      enabled: booleanOrDefault(capcut.enabled,true,'CapCut enabled setting'),
      pro: booleanOrDefault(capcut.pro,false,'CapCut Pro setting')
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
    bindings: boundedArray(source.bindings,'workflow bindings',WORKFLOW_BINDING_LIMIT).map(sanitizeBinding),
    enabled: booleanOrDefault(source.enabled,false,'workflow enabled flag'),
    notes: str(source.notes, '', WORKFLOW_PROFILE_NOTES_LIMIT) || undefined,
    modelFingerprint: str(source.modelFingerprint, '', 512) || undefined,
    validation: {
      structuralStatus: enumOrDefault(validationSource.structuralStatus,new Set(['valid','invalid','unvalidated'] as const),'unvalidated','workflow validation status'),
      validatedAt: maybeIso(validationSource.validatedAt),
      sourceSha256: sha(validationSource.sourceSha256),
      runtimeFingerprint: str(validationSource.runtimeFingerprint, '', 512) || undefined,
      lastSuccessfulRenderAt: maybeIso(validationSource.lastSuccessfulRenderAt),
      successfulRenderCount: boundedOptionalNumber(validationSource.successfulRenderCount,0,1_000_000,'workflow successful render count'),
      lastRenderWallSec: boundedOptionalNumber(validationSource.lastRenderWallSec,0,7*24*60*60,'workflow last render wall seconds'),
      lastRenderWidth: boundedOptionalNumber(validationSource.lastRenderWidth,64,16_384,'workflow last render width'),
      lastRenderHeight: boundedOptionalNumber(validationSource.lastRenderHeight,64,16_384,'workflow last render height'),
      lastRenderFrames: boundedOptionalNumber(validationSource.lastRenderFrames,1,100_000,'workflow last render frames'),
      lastError: str(validationSource.lastError, '', 10_000) || undefined
    }
  };
}

function sanitizeBinding(value: unknown): WorkflowBinding {
  const source = asObject(value, 'binding');
  const keys = new Set(['prompt','negativePrompt','width','height','resolution','frames','fps','steps','cfg','seed','startImage','endImage','locationImage','characterImage1','characterImage2','characterImage3','characterImage4','propImage1','propImage2','referenceImages','referenceImage1','referenceImage2','referenceImage3','referenceImage4','inputAudio','inputVideo','includeAudio','filenamePrefix']);
  if (!keys.has(source.key)) throw new Error(`Invalid workflow binding key: ${String(source.key)}`);
  const selector = source.selector && typeof source.selector === 'object' ? {
    ...(str(source.selector.nodeId, '', WORKFLOW_BINDING_NODE_ID_LIMIT) ? { nodeId: str(source.selector.nodeId, '', 128) } : {}),
    ...(str(source.selector.classType, '', WORKFLOW_BINDING_CLASS_TYPE_LIMIT) ? { classType: str(source.selector.classType, '', 256) } : {}),
    ...(str(source.selector.titleIncludes, '', WORKFLOW_BINDING_TITLE_LIMIT) ? { titleIncludes: str(source.selector.titleIncludes, '', 256) } : {})
  } : undefined;
  const input=str(source.input,'',WORKFLOW_BINDING_INPUT_LIMIT)||undefined,jsonPath=str(source.jsonPath,'',WORKFLOW_BINDING_JSON_PATH_LIMIT)||undefined;
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
    shotIds: boundedArray(source.shotIds,'scene shot ids',100_000).map(value=>safeId(value))
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
    continuity: sanitizeAssetContinuity(source.continuity),
    createdAt: iso(source.createdAt, new Date().toISOString())
  };
}

function sanitizeAssetContinuity(value:unknown):Asset['continuity']{
  if(value==null)return undefined;
  const source=asObject(value,'asset continuity profile');
  const list=(raw:unknown,label:string)=>[...new Set(boundedArray(raw,label,64).map(item=>str(item,'',1000).trim()).filter(Boolean))];
  const profile={
    identityAnchors:list(source.identityAnchors,'asset identity anchors'),
    forbiddenChanges:list(source.forbiddenChanges,'asset forbidden changes'),
    appearance:str(source.appearance,'',20_000)||undefined,
    geometry:str(source.geometry,'',20_000)||undefined,
    state:str(source.state,'',20_000)||undefined,
    lighting:str(source.lighting,'',20_000)||undefined,
    spatialRules:str(source.spatialRules,'',20_000)||undefined
  };
  return profile.identityAnchors.length||profile.forbiddenChanges.length||profile.appearance||profile.geometry||profile.state||profile.lighting||profile.spatialRules?profile:undefined;
}

function sanitizeShot(value: unknown, sceneIds: Set<string>, assetIds: Set<string>, assetKinds: Map<string,AssetKind>): Shot {
  const source = asObject(value, 'shot');
  const sceneId = safeId(source.sceneId);
  if (!sceneIds.has(sceneId)) throw new Error(`Shot references unknown scene: ${sceneId}`);
  const generationSource = asObject(source.generation ?? {}, 'shot generation');
  const modelFamily=enumOrDefault(generationSource.modelFamily,MODEL_FAMILIES,PRIMARY_VIDEO_MODEL,'shot model family');
  const defaults = MODEL_DEFAULTS[modelFamily];
  const rawIds = (value: unknown) => boundedArray(value,'shot asset references',128).map(item=>safeId(item)).filter(id=>assetIds.has(id));
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
    previz:sanitizePrevizSpec(source.previz,assetIds),
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
    latestRenderId: optionalString(source.latestRenderId,'shot latest render id'),
    latestAttemptRenderId:optionalString(source.latestAttemptRenderId,'shot latest attempt render id'),
    canonicalRenderId:optionalString(source.canonicalRenderId,'shot canonical render id'),
    plannedStartStateId:optionalString(source.plannedStartStateId,'shot planned start state id'),
    plannedEndStateId:optionalString(source.plannedEndStateId,'shot planned end state id'),
    actualStartStateId:optionalString(source.actualStartStateId,'shot actual start state id'),
    observedFinalStateId:optionalString(source.observedFinalStateId,'shot observed final state id')
  };
}

function sanitizePrevizSpec(value:unknown,assetIds:Set<string>):Shot['previz']{
  const source=optionalObject(value,'shot previz')??{};
  const previewAssetId=optionalString(source.previewAssetId,'previz preview asset id');
  return{
    requirement:enumOrDefault(source.requirement,new Set(['none','optional','required'] as const),'none','previz requirement'),
    status:enumOrDefault(source.status,new Set(['not-needed','pending','ready','failed','human-verify'] as const),'not-needed','previz status'),
    reason:str(source.reason,'',20_000)||undefined,
    manifestPath:str(source.manifestPath,'',4096)||undefined,
    previewAssetId:previewAssetId&&assetIds.has(previewAssetId)?previewAssetId:undefined,
    createdAt:maybeIso(source.createdAt),
    updatedAt:maybeIso(source.updatedAt)
  };
}

function sanitizeShotState(value:unknown,shotIds:Set<string>,assetIds:Set<string>,outputs:Map<string,RenderOutput>):ShotState{
  const source=asObject(value,'shot state'),shotId=safeId(source.shotId);
  if(!shotIds.has(shotId))throw new Error(`Shot state references unknown shot: ${shotId}`);
  const optionalAssetId=(raw:unknown,label:string)=>{const id=optionalString(raw,label);return id&&assetIds.has(id)?id:undefined;};
  const sourceRenderOutputId=optionalString(source.sourceRenderOutputId,'shot state source render output id');
  if(sourceRenderOutputId){
    const output=outputs.get(sourceRenderOutputId);
    if(!output||output.shotId!==shotId)throw new Error(`Shot state source render output does not belong to shot ${shotId}: ${sourceRenderOutputId}`);
  }
  return{
    id:safeId(source.id),
    shotId,
    role:enumOrDefault(source.role,new Set(['planned-start','planned-end','actual-start','observed-final'] as const),'planned-start','shot state role'),
    source:enumOrDefault(source.source,new Set(['planned','keyframe','generated','human','previz'] as const),'planned','shot state source'),
    status:enumOrDefault(source.status,new Set(['current','stale','unreviewed'] as const),'unreviewed','shot state status'),
    frameAssetId:optionalAssetId(source.frameAssetId,'shot state frame asset id'),
    sourceRenderOutputId,
    derivedFromStateId:optionalString(source.derivedFromStateId,'derived shot state id'),
    characters:boundedArray(source.characters,'shot state characters',32).map(item=>sanitizeCharacterState(item,assetIds)),
    props:boundedArray(source.props,'shot state props',64).map(item=>sanitizePropState(item,assetIds)),
    environment:sanitizeEnvironmentState(source.environment,assetIds),
    camera:sanitizeCameraState(source.camera),
    actionPhase:str(source.actionPhase,'',20_000),
    dialogueState:str(source.dialogueState,'',20_000),
    confidence:finiteOptional(source.confidence,0,1),
    fingerprint:str(source.fingerprint,'',4096)||undefined,
    staleReason:str(source.staleReason,'',4096)||undefined,
    createdAt:iso(source.createdAt,new Date().toISOString())
  };
}

function sanitizeCharacterState(value:unknown,assetIds:Set<string>):ShotState['characters'][number]{
  const source=asObject(value,'character continuity state');
  const asset=(raw:unknown,label:string)=>{const id=optionalString(raw,label);return id&&assetIds.has(id)?id:undefined;};
  return{
    characterAssetId:asset(source.characterAssetId,'character continuity asset id'),
    label:str(source.label,'',1000)||undefined,
    visible:optionalBoolean(source.visible,'character visibility'),
    screenPosition:optionalEnum(source.screenPosition,new Set(['left','center','right','offscreen','unknown'] as const),'character screen position'),
    pose:str(source.pose,'',5000)||undefined,
    facing:str(source.facing,'',2000)||undefined,
    gaze:str(source.gaze,'',2000)||undefined,
    expression:str(source.expression,'',5000)||undefined,
    wardrobeAssetId:asset(source.wardrobeAssetId,'wardrobe continuity asset id'),
    heldPropAssetIds:[...new Set(boundedArray(source.heldPropAssetIds,'held prop asset ids',32).map(item=>safeId(item)).filter(id=>assetIds.has(id)))],
    notes:str(source.notes,'',10_000)||undefined
  };
}

function sanitizePropState(value:unknown,assetIds:Set<string>):ShotState['props'][number]{
  const source=asObject(value,'prop continuity state');
  const asset=(raw:unknown,label:string)=>{const id=optionalString(raw,label);return id&&assetIds.has(id)?id:undefined;};
  return{
    propAssetId:asset(source.propAssetId,'prop continuity asset id'),
    label:str(source.label,'',1000)||undefined,
    holderCharacterAssetId:asset(source.holderCharacterAssetId,'prop holder character asset id'),
    position:str(source.position,'',5000)||undefined,
    state:str(source.state,'',5000)||undefined,
    notes:str(source.notes,'',10_000)||undefined
  };
}

function sanitizeEnvironmentState(value:unknown,assetIds:Set<string>):ShotState['environment']{
  const source=optionalObject(value,'environment continuity state')??{};
  const locationAssetId=optionalString(source.locationAssetId,'environment location asset id');
  return{
    locationAssetId:locationAssetId&&assetIds.has(locationAssetId)?locationAssetId:undefined,
    timeOfDay:str(source.timeOfDay,'',1000)||undefined,
    lighting:str(source.lighting,'',10_000)||undefined,
    weather:str(source.weather,'',5000)||undefined,
    notes:str(source.notes,'',10_000)||undefined
  };
}

function sanitizeCameraState(value:unknown):ShotState['camera']{
  const source=optionalObject(value,'camera continuity state')??{};
  return{
    shotSize:str(source.shotSize,'',1000)||undefined,
    angle:str(source.angle,'',2000)||undefined,
    screenDirection:str(source.screenDirection,'',2000)||undefined,
    movement:str(source.movement,'',5000)||undefined,
    lensMm:finiteOptional(source.lensMm,1,1000),
    notes:str(source.notes,'',10_000)||undefined
  };
}

function sanitizeShotDependency(value:unknown,shotIds:Set<string>):ShotDependency{
  const source=asObject(value,'shot dependency'),fromShotId=safeId(source.fromShotId),toShotId=safeId(source.toShotId);
  if(!shotIds.has(fromShotId)||!shotIds.has(toShotId))throw new Error(`Shot dependency references unknown shot: ${fromShotId} → ${toShotId}`);
  if(fromShotId===toShotId)throw new Error('Shot dependency cannot point a shot to itself.');
  const allowed=new Set<ContinuityField>(['character','wardrobe','prop','location','lighting','action','camera','dialogue']);
  const propagate=[...new Set(boundedArray(source.propagate,'shot dependency propagation fields',16).map(item=>enumOrDefault(item,allowed,'character','continuity propagation field')))];
  return{
    id:safeId(source.id),fromShotId,toShotId,
    relation:enumOrDefault(source.relation,new Set(['continuity','temporal','parallel','cutaway','reverse-angle','insert','montage'] as const),'continuity','shot dependency relation'),
    strength:enumOrDefault(source.strength,new Set(['soft','hard'] as const),'soft','shot dependency strength'),
    propagate,
    createdAt:iso(source.createdAt,new Date().toISOString())
  };
}

function sanitizeQcIssue(value:unknown):QcIssue{
  const source=asObject(value,'QC issue');
  return{
    code:str(source.code,'UNKNOWN',256),
    severity:enumOrDefault(source.severity,new Set(['info','warning','major','blocker'] as const),'warning','QC issue severity'),
    message:str(source.message,'',4096),
    expected:str(source.expected,'',4096)||undefined,
    observed:str(source.observed,'',4096)||undefined
  };
}

function sanitizeShotQcResult(value:unknown,shotIds:Set<string>,outputs:Map<string,RenderOutput>):ShotQcResult{
  const source=asObject(value,'shot QC result'),shotId=safeId(source.shotId),renderOutputId=optionalString(source.renderOutputId,'QC render output id');
  if(!shotIds.has(shotId))throw new Error(`QC result references unknown shot: ${shotId}`);
  if(renderOutputId){
    const output=outputs.get(renderOutputId);
    if(!output||output.shotId!==shotId)throw new Error(`QC result render output does not belong to shot ${shotId}: ${renderOutputId}`);
  }
  return{
    id:safeId(source.id),shotId,renderOutputId,
    layer:enumOrDefault(source.layer,new Set(['technical','visual','semantic','continuity'] as const),'technical','QC layer'),
    status:enumOrDefault(source.status,new Set(['pass','fail','unknown','human-verify'] as const),'unknown','QC status'),
    issues:boundedArray(source.issues,'QC issues',128).map(sanitizeQcIssue),
    inputKey:str(source.inputKey,'',20_000)||undefined,
    createdAt:iso(source.createdAt,new Date().toISOString()),
    humanOverrideTaskId:optionalString(source.humanOverrideTaskId,'QC human override task id')
  };
}

function sanitizeHumanTask(value:unknown,shotIds:Set<string>,assetIds:Set<string>,outputs:Map<string,RenderOutput>):HumanTask{
  const source=asObject(value,'human task'),shotId=optionalString(source.shotId,'human task shot id');
  if(shotId&&!shotIds.has(shotId))throw new Error(`Human task references unknown shot: ${shotId}`);
  const relatedAssetIds=[...new Set(boundedArray(source.relatedAssetIds,'human task asset ids',64).map(item=>safeId(item)).filter(id=>assetIds.has(id)))];
  const relatedRenderOutputIds=[...new Set(boundedArray(source.relatedRenderOutputIds,'human task render output ids',64).map(item=>safeId(item)).filter(id=>outputs.has(id)))];
  if(shotId){
    const mismatched=relatedRenderOutputIds.find(id=>outputs.get(id)?.shotId!==shotId);
    if(mismatched)throw new Error(`Human task for shot ${shotId} cannot reference render output ${mismatched} from shot ${outputs.get(mismatched)?.shotId}.`);
  }
  return{
    id:safeId(source.id),
    type:enumOrDefault(source.type,new Set(['create-asset','approve-asset','verify-keyframe','verify-previz','verify-continuity','choose-take','manual-qc','route-unsupported'] as const),'manual-qc','human task type'),
    status:enumOrDefault(source.status,new Set(['open','resolved','dismissed'] as const),'open','human task status'),
    shotId,
    title:str(source.title,'Human review',2000),
    reason:str(source.reason,'',20_000),
    recommendedAction:str(source.recommendedAction,'',20_000)||undefined,
    relatedAssetIds,relatedRenderOutputIds,
    createdAt:iso(source.createdAt,new Date().toISOString()),
    resolvedAt:maybeIso(source.resolvedAt),
    resolution:str(source.resolution,'',20_000)||undefined
  };
}

function sanitizeCutRevision(value:unknown,timelineClipIds:Set<string>):CutRevision{
  const source=asObject(value,'cut revision');
  return{
    id:safeId(source.id),
    name:str(source.name,'Cut',1000),
    clipIds:[...new Set(boundedArray(source.clipIds,'cut revision clip ids',100_000).map(item=>safeId(item)).filter(id=>timelineClipIds.has(id)))],
    locked:booleanOrDefault(source.locked,false,'cut revision locked flag'),
    createdAt:iso(source.createdAt,new Date().toISOString())
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
    productionInputKey:str(source.productionInputKey,'',512)||undefined,
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
      productionInputKey:str(rawSpec.productionInputKey,'',512)||undefined,
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
  return {
    id,shotId,renderOutputId,
    track:clampInt(source.track,0,128,0),order:clampInt(source.order,0,1_000_000,0),
    trimInSec:trimIn,trimOutSec:trimOut,volume:clampNumber(source.volume,0,8,1),
    approval:enumOrDefault(source.approval,new Set(['legacy','canonical','human-override'] as const),'legacy','timeline take approval'),
    approvalReason:str(source.approvalReason,'',10_000)||undefined,
    approvalInputKey:str(source.approvalInputKey,'',256)||undefined
  };
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
function booleanOrDefault(value:unknown,fallback:boolean,_label:string):boolean{
  if(value==null||value==='')return fallback;
  return typeof value==='boolean'?value:false;
}
function optionalBoolean(value:unknown,_label:string):boolean|undefined{
  if(value==null||value==='')return undefined;
  return typeof value==='boolean'?value:undefined;
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


function boundedOptionalNumber(value:unknown,min:number,max:number,label:string):number|undefined{
  if(value==null||value==='')return undefined;
  const number=Number(value);
  if(!Number.isFinite(number)||number<min||number>max)throw new Error(`Invalid ${label}.`);
  return number;
}
