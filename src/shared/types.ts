export type UUID = string;
export type ISODate = string;

export type AssetKind = 'character' | 'location' | 'prop' | 'wardrobe' | 'reference' | 'keyframe' | 'audio' | 'video' | 'image';
export type ShotStatus = 'draft' | 'ready' | 'queued' | 'rendering' | 'rendered' | 'failed';
export type RenderJobStatus = 'queued' | 'preparing' | 'uploading' | 'submitted' | 'running' | 'recovering' | 'stalled' | 'orphaned' | 'downloading' | 'done' | 'failed' | 'cancelled';
export type ModelFamily = 'ltx-2.5-fast' | 'ltx-2.3' | 'hunyuan-video-1.5' | 'wan-2.2-5b' | 'framepack' | 'custom';
export type GenerationMode = 't2v' | 'i2v' | 'flf2v' | 'ia2v' | 'v2v' | 't2i' | 'i2i';
export type WorkflowPurpose = 'video' | 'image' | 'audio' | 'utility';
export type RuntimeBackend = 'wangp' | 'comfyui';
export type QualityIntent = 'preview' | 'balanced' | 'hero';
export type WanGpExecutionMode = 'native' | 'docker';

export type ShotStateRole = 'planned-start' | 'planned-end' | 'actual-start' | 'observed-final';
export type ShotStateSource = 'planned' | 'keyframe' | 'generated' | 'human' | 'previz';
export type ShotStateStatus = 'current' | 'stale' | 'unreviewed';
export type ShotDependencyRelation = 'continuity' | 'temporal' | 'parallel' | 'cutaway' | 'reverse-angle' | 'insert' | 'montage';
export type ShotDependencyStrength = 'soft' | 'hard';
export type ContinuityField = 'character' | 'wardrobe' | 'prop' | 'location' | 'lighting' | 'action' | 'camera' | 'dialogue';
export type QcLayer = 'technical' | 'visual' | 'semantic' | 'continuity';
export type QcStatus = 'pass' | 'fail' | 'unknown' | 'human-verify';
export type HumanTaskType = 'create-asset' | 'approve-asset' | 'verify-keyframe' | 'verify-previz' | 'verify-continuity' | 'choose-take' | 'manual-qc' | 'route-unsupported';
export type HumanTaskStatus = 'open' | 'resolved' | 'dismissed';
export type PrevizRequirement = 'none' | 'optional' | 'required';
export type PrevizStatus = 'not-needed' | 'pending' | 'ready' | 'failed' | 'human-verify';

export interface AppMachineSettings {
  schemaVersion: 1;
  endpointPolicy: 'loopback-only';
  ffmpeg: {
    path: string;
    ffprobePath: string;
    preferredH264Encoder: 'libx264' | 'h264_nvenc';
  };
  wangp: {
    executionMode: WanGpExecutionMode;
    rootPath: string;
    pythonPath: string;
    entrypoint: string;
    profile: 1 | 2 | 3 | 4 | 5;
    attention: 'auto' | 'sdpa' | 'flash' | 'sage' | 'sage2';
    dryRunBeforeRender: boolean;
    docker: {
      command: string;
      image: string;
      projectMount: string;
      wangpMount: string;
    };
  };
  comfy: {
    url: string;
    inputDir: string;
    dedicatedInstance: boolean;
  };
  director: {
    baseUrl: string;
    model: string;
    temperature: number;
  };
  diagnostics: {
    persistVerboseLogs: boolean;
  };
}

export interface ProjectSettings {
  costPolicy: { mode: 'codex-capcut-only'; allowCapcutAiCredits: boolean; };
  capcut: { enabled: boolean; pro: boolean; };
  defaultFps: number;
  outputContainer: 'mp4' | 'mov' | 'webm';
  workflowProfiles: WorkflowProfile[];
}

export interface StoryDocument { title:string;logline:string;script:string;notes:string; }

export interface CharacterContinuityState {
  characterAssetId?: UUID;
  label?: string;
  visible?: boolean;
  screenPosition?: 'left' | 'center' | 'right' | 'offscreen' | 'unknown';
  pose?: string;
  facing?: string;
  gaze?: string;
  expression?: string;
  wardrobeAssetId?: UUID;
  heldPropAssetIds: UUID[];
  notes?: string;
}

export interface PropContinuityState {
  propAssetId?: UUID;
  label?: string;
  holderCharacterAssetId?: UUID;
  position?: string;
  state?: string;
  notes?: string;
}

export interface EnvironmentContinuityState {
  locationAssetId?: UUID;
  timeOfDay?: string;
  lighting?: string;
  weather?: string;
  notes?: string;
}

export interface CameraContinuityState {
  shotSize?: string;
  angle?: string;
  screenDirection?: string;
  movement?: string;
  lensMm?: number;
  notes?: string;
}

export interface ShotState {
  id: UUID;
  shotId: UUID;
  role: ShotStateRole;
  source: ShotStateSource;
  status: ShotStateStatus;
  frameAssetId?: UUID;
  sourceRenderOutputId?: UUID;
  derivedFromStateId?: UUID;
  characters: CharacterContinuityState[];
  props: PropContinuityState[];
  environment: EnvironmentContinuityState;
  camera: CameraContinuityState;
  actionPhase: string;
  dialogueState: string;
  confidence?: number;
  fingerprint?: string;
  staleReason?: string;
  createdAt: ISODate;
}

export interface ShotDependency {
  id: UUID;
  fromShotId: UUID;
  toShotId: UUID;
  relation: ShotDependencyRelation;
  strength: ShotDependencyStrength;
  propagate: ContinuityField[];
  createdAt: ISODate;
}

export interface QcIssue {
  code: string;
  severity: 'info' | 'warning' | 'major' | 'blocker';
  message: string;
  expected?: string;
  observed?: string;
}

export interface ShotQcResult {
  id: UUID;
  shotId: UUID;
  renderOutputId?: UUID;
  layer: QcLayer;
  status: QcStatus;
  issues: QcIssue[];
  inputKey?: string;
  createdAt: ISODate;
  humanOverrideTaskId?: UUID;
}

export interface HumanTask {
  id: UUID;
  type: HumanTaskType;
  status: HumanTaskStatus;
  shotId?: UUID;
  title: string;
  reason: string;
  recommendedAction?: string;
  relatedAssetIds: UUID[];
  relatedRenderOutputIds: UUID[];
  createdAt: ISODate;
  resolvedAt?: ISODate;
  resolution?: string;
}

export interface PrevizSpec {
  requirement: PrevizRequirement;
  status: PrevizStatus;
  reason?: string;
  manifestPath?: string;
  previewAssetId?: UUID;
  createdAt?: ISODate;
  updatedAt?: ISODate;
}

export interface CutRevision {
  id: UUID;
  name: string;
  clipIds: UUID[];
  locked: boolean;
  createdAt: ISODate;
}
export interface Scene { id:UUID;index:number;heading:string;body:string;location?:string;timeOfDay?:string;shotIds:UUID[]; }
export interface Asset { id:UUID;kind:AssetKind;name:string;sourcePath:string;projectPath:string;mimeType?:string;tags:string[];notes:string;createdAt:ISODate; }
export interface ShotGenerationSettings { modelFamily:ModelFamily;mode:GenerationMode;quality:QualityIntent;width:number;height:number;frames:number;fps:number;steps?:number;cfg?:number;seed:number;negativePrompt:string;includeAudio:boolean;workflowProfileId?:UUID; }
export interface Shot { id:UUID;sceneId:UUID;index:number;title:string;prompt:string;camera:string;action:string;dialogue:string;continuityNotes:string;characterAssetIds:UUID[];locationAssetId?:UUID;propAssetIds:UUID[];referenceAssetIds?:UUID[];startFrameAssetId?:UUID;endFrameAssetId?:UUID;referenceVideoAssetId?:UUID;audioAssetId?:UUID;status:ShotStatus;generation:ShotGenerationSettings;latestRenderId?:UUID;latestAttemptRenderId?:UUID;canonicalRenderId?:UUID;plannedStartStateId?:UUID;plannedEndStateId?:UUID;actualStartStateId?:UUID;observedFinalStateId?:UUID;previz?:PrevizSpec; }

export interface WorkflowValidation {
  structuralStatus: 'unvalidated' | 'valid' | 'invalid';
  validatedAt?: ISODate;
  sourceSha256?: string;
  runtimeFingerprint?: string;
  lastSuccessfulRenderAt?: ISODate;
  lastError?: string;
}

export interface WorkflowNodeSelector { nodeId?:string;classType?:string;titleIncludes?:string; }
export type WorkflowBindingKey='prompt'|'negativePrompt'|'width'|'height'|'resolution'|'frames'|'fps'|'steps'|'cfg'|'seed'|'startImage'|'endImage'|'locationImage'|'characterImage1'|'characterImage2'|'characterImage3'|'characterImage4'|'propImage1'|'propImage2'|'referenceImages'|'referenceImage1'|'referenceImage2'|'referenceImage3'|'referenceImage4'|'inputAudio'|'inputVideo'|'filenamePrefix';
export interface WorkflowBinding { key:WorkflowBindingKey;selector?:WorkflowNodeSelector;input?:string;jsonPath?:string;transform?:'identity'|'integer'|'float'|'boolean'|'string';required?:boolean; }
export interface WorkflowProfile {
  id:UUID;
  runtime?:RuntimeBackend;
  purpose:WorkflowPurpose;
  name:string;
  modelFamily:ModelFamily;
  mode:GenerationMode;
  workflowPath:string;
  workflowFormat:'api'|'ui'|'wangp-settings';
  bindings:WorkflowBinding[];
  enabled:boolean;
  notes?:string;
  modelFingerprint?:string;
  validation?:WorkflowValidation;
}

export interface AssetFingerprint { assetId: UUID; projectPath: string; sha256: string; }
export interface RenderRuntimeFingerprint {
  backend: RuntimeBackend;
  executionMode?: WanGpExecutionMode;
  runtimeVersion?: string;
  runtimeSha256?: string;
  environmentSha256: string;
}
export interface RenderOutput { id:UUID;jobId:UUID;shotId:UUID;path:string;filename:string;mediaType:'video'|'image'|'audio'|'unknown';createdAt:ISODate;comfyMeta?:Record<string,unknown>;technicalQc?:TechnicalQcResult; }
export interface RenderJobSpec {
  shot:Shot;
  workflowProfile:WorkflowProfile;
  effectivePrompt:string;
  queuedProjectUpdatedAt:ISODate;
  workflowSha256:string;
  assetFingerprints:AssetFingerprint[];
  runtimeFingerprint:RenderRuntimeFingerprint;
  modelFingerprint?:string;
}
export interface RenderJob {
  id:UUID;shotId:UUID;createdAt:ISODate;updatedAt:ISODate;status:RenderJobStatus;progress:number;message:string;
  modelFamily:ModelFamily;workflowProfileId?:UUID;comfyPromptId?:string;backendPid?:number;lastHeartbeatAt?:ISODate;
  error?:string;outputs:RenderOutput[];spec?:RenderJobSpec;
}
export interface TimelineClip { id:UUID;shotId:UUID;renderOutputId:UUID;track:number;order:number;trimInSec:number;trimOutSec?:number;volume:number;approval?:'legacy'|'canonical'|'human-override';approvalReason?:string; }
export interface FilmProject {
  schemaVersion:3;
  id:UUID;
  name:string;
  createdAt:ISODate;
  updatedAt:ISODate;
  rootPath:string;
  story:StoryDocument;
  scenes:Scene[];
  assets:Asset[];
  shots:Shot[];
  renderJobs:RenderJob[];
  renderOutputs:RenderOutput[];
  timeline:TimelineClip[];
  shotStates:ShotState[];
  shotDependencies:ShotDependency[];
  qcResults:ShotQcResult[];
  humanTasks:HumanTask[];
  cutRevisions:CutRevision[];
  settings:ProjectSettings;
}

export interface RecordObservedFinalStateRequest {
  projectRoot:string;
  shotId:UUID;
  renderOutputId:UUID;
  frameAssetId?:UUID;
  characters:CharacterContinuityState[];
  props:PropContinuityState[];
  environment:EnvironmentContinuityState;
  camera:CameraContinuityState;
  actionPhase:string;
  dialogueState:string;
  confidence?:number;
}

export interface RecordShotQcRequest {
  projectRoot:string;
  shotId:UUID;
  renderOutputId:UUID;
  layer:Exclude<QcLayer,'technical'>;
  status:QcStatus;
  issues:QcIssue[];
  inputKey?:string;
}

export interface CreateHumanTaskRequest {
  projectRoot:string;
  type:HumanTaskType;
  shotId?:UUID;
  title:string;
  reason:string;
  recommendedAction?:string;
  relatedAssetIds?:UUID[];
  relatedRenderOutputIds?:UUID[];
}

export interface ResolveHumanTaskRequest {
  projectRoot:string;
  taskId:UUID;
  status:'resolved'|'dismissed';
  resolution:string;
}

export interface PromoteCanonicalTakeRequest {
  projectRoot:string;
  shotId:UUID;
  renderOutputId:UUID;
}

export interface KeyframeRequest { projectRoot:string;shotId:UUID;role:'start'|'end';workflowProfileId:UUID; }
export interface RenderRequest { projectRoot:string;shotId:UUID;forceWorkflowProfileId?:UUID; }
export interface RenderBatchRequest { projectRoot:string;shotIds:UUID[];skipIfRendered?:boolean; }
export interface QueueSnapshot { runningJobId?:UUID;blockedReason?:string;jobs:RenderJob[]; }

export interface HardwarePlan {
  tier:'rtx50-16gb'|'nvidia-16gb-plus'|'nvidia-12gb-plus'|'nvidia-low-vram'|'unknown';
  recommendedWanGpProfile:1|2|3|4|5;
  recommendedAttention:'auto'|'sdpa'|'flash'|'sage'|'sage2';
  defaultVideoModel:ModelFamily;
  defaultStillStrategy:string;
  notes:string[];
}
export interface SystemProbe {
  platform:{platform:string;release:string;arch:string;hostname:string;};
  cpu:{model:string;logicalCores:number;physicalCores?:number;};
  gpu?:{name:string;totalVramMb?:number;freeVramMb?:number;driver?:string;computeCapability?:string;cudaVersion?:string;};
  memory?:{totalMb:number;freeMb:number;};
  disk?:{path:string;freeBytes:number;totalBytes:number;};
  ffmpeg:{available:boolean;version?:string;ffprobeAvailable:boolean;encoderAvailable?:boolean;};
  capcut:{installed:boolean;path?:string;configuredTier:'free'|'pro';};
  comfy:{reachable:boolean;url:string;systemStats?:unknown;error?:string;};
  wangp:{configured:boolean;available:boolean;executionMode:WanGpExecutionMode;rootPath:string;entrypoint?:string;pythonPath?:string;runtimeVersion?:string;pythonVersion?:string;torchVersion?:string;torchCudaVersion?:string;cudaAvailable?:boolean;torchError?:string;error?:string;};
  docker?:{available:boolean;version?:string;gpuAccessible?:boolean;error?:string;};
  hardwarePlan:HardwarePlan;
  codexContextPath?:string;
}
export interface WanGpCatalogEntry {
  modelType:string;
  name:string;
  family?:string;
  familyLabel?:string;
  mainOutput:string[];
  outputs:string[];
  inputs:string[];
  capabilities?:Record<string,boolean>;
  description?:string;
}
export type ValidationLevel='error'|'warning'|'info';
export interface ValidationIssue { level:ValidationLevel;code:string;message:string;shotId?:UUID;profileId?:UUID;assetId?:UUID; }
export interface PreflightReport { createdAt:ISODate;ready:boolean;issues:ValidationIssue[];probe:SystemProbe; }

export interface TechnicalQcResult {
  checkedAt: ISODate;
  passed: boolean;
  warnings?: string[];
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  audioPeakDb?: number;
  issues: string[];
}

export interface ContinuityReview { issues:string[];suggestedContinuityNotes:string;promptAddendum:string; }
export interface DirectorShotDraft { title:string;prompt:string;camera:string;action:string;dialogue:string;continuityNotes:string;quality:QualityIntent;preferredModel?:ModelFamily;characterAssetIds?:UUID[];locationAssetId?:UUID;propAssetIds?:UUID[];referenceAssetIds?:UUID[]; }
export interface ParsedScene { heading:string;body:string;location?:string;timeOfDay?:string; }
