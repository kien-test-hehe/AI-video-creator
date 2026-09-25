export type UUID = string;
export type ISODate = string;

export type AssetKind = 'character' | 'location' | 'prop' | 'wardrobe' | 'reference' | 'keyframe' | 'audio' | 'video' | 'image';
export type ShotStatus = 'draft' | 'ready' | 'queued' | 'rendering' | 'rendered' | 'failed';
export type RenderJobStatus = 'queued' | 'preparing' | 'uploading' | 'submitted' | 'running' | 'downloading' | 'done' | 'failed' | 'cancelled';
export type ModelFamily = 'ltx-2.5-fast' | 'ltx-2.3' | 'hunyuan-video-1.5' | 'wan-2.2-5b' | 'framepack' | 'custom';
export type GenerationMode = 't2v' | 'i2v' | 'flf2v' | 'ia2v' | 'v2v' | 't2i' | 'i2i';
export type WorkflowPurpose = 'video' | 'image' | 'audio' | 'utility';
export type RuntimeBackend = 'wangp' | 'comfyui';
export type QualityIntent = 'preview' | 'balanced' | 'hero';

export interface ProjectSettings {
  costPolicy: { mode: 'codex-capcut-only'; allowCapcutAiCredits: boolean; };
  wangp: { rootPath: string; pythonPath: string; entrypoint: string; profile: 1|2|3|4|5; attention: 'auto'|'sdpa'|'flash'|'sage'|'sage2'; dryRunBeforeRender: boolean; };
  capcut: { enabled: boolean; pro: boolean; handoffDirName: string; };
  comfyUrl: string;
  ffmpegPath: string;
  comfyInputDir: string;
  localOnly: boolean;
  defaultFps: number;
  outputContainer: 'mp4'|'mov'|'webm';
  workflowProfiles: WorkflowProfile[];
  director: { baseUrl: string; model: string; temperature: number; };
}
export interface StoryDocument { title:string;logline:string;script:string;notes:string; }
export interface Scene { id:UUID;index:number;heading:string;body:string;location?:string;timeOfDay?:string;shotIds:UUID[]; }
export interface Asset { id:UUID;kind:AssetKind;name:string;sourcePath:string;projectPath:string;mimeType?:string;tags:string[];notes:string;createdAt:ISODate; }
export interface ShotGenerationSettings { modelFamily:ModelFamily;mode:GenerationMode;quality:QualityIntent;width:number;height:number;frames:number;fps:number;steps?:number;cfg?:number;seed:number;negativePrompt:string;includeAudio:boolean;workflowProfileId?:UUID; }
export interface Shot { id:UUID;sceneId:UUID;index:number;title:string;prompt:string;camera:string;action:string;dialogue:string;continuityNotes:string;characterAssetIds:UUID[];locationAssetId?:UUID;propAssetIds:UUID[];startFrameAssetId?:UUID;endFrameAssetId?:UUID;referenceVideoAssetId?:UUID;audioAssetId?:UUID;status:ShotStatus;generation:ShotGenerationSettings;latestRenderId?:UUID; }
export interface RenderOutput { id:UUID;jobId:UUID;shotId:UUID;path:string;filename:string;mediaType:'video'|'image'|'audio'|'unknown';createdAt:ISODate;comfyMeta?:Record<string,unknown>; }
export interface RenderJobSpec { shot:Shot;workflowProfile:WorkflowProfile;effectivePrompt:string;queuedProjectUpdatedAt:ISODate;workflowSha256?:string; }
export interface RenderJob { id:UUID;shotId:UUID;createdAt:ISODate;updatedAt:ISODate;status:RenderJobStatus;progress:number;message:string;modelFamily:ModelFamily;workflowProfileId?:UUID;comfyPromptId?:string;error?:string;outputs:RenderOutput[];spec?:RenderJobSpec; }
export interface TimelineClip { id:UUID;shotId:UUID;renderOutputId:UUID;track:number;order:number;trimInSec:number;trimOutSec?:number;volume:number; }
export interface FilmProject { schemaVersion:1;id:UUID;name:string;createdAt:ISODate;updatedAt:ISODate;rootPath:string;story:StoryDocument;scenes:Scene[];assets:Asset[];shots:Shot[];renderJobs:RenderJob[];renderOutputs:RenderOutput[];timeline:TimelineClip[];settings:ProjectSettings; }
export interface WorkflowNodeSelector { nodeId?:string;classType?:string;titleIncludes?:string; }
export type WorkflowBindingKey='prompt'|'negativePrompt'|'width'|'height'|'frames'|'fps'|'steps'|'cfg'|'seed'|'startImage'|'endImage'|'locationImage'|'characterImage1'|'characterImage2'|'characterImage3'|'characterImage4'|'propImage1'|'propImage2'|'referenceImage1'|'referenceImage2'|'referenceImage3'|'referenceImage4'|'inputAudio'|'inputVideo'|'filenamePrefix';
export interface WorkflowBinding { key:WorkflowBindingKey;selector?:WorkflowNodeSelector;input?:string;jsonPath?:string;transform?:'identity'|'integer'|'float'|'boolean'|'string';required?:boolean; }
export interface WorkflowProfile { id:UUID;runtime?:RuntimeBackend;purpose:WorkflowPurpose;name:string;modelFamily:ModelFamily;mode:GenerationMode;workflowPath:string;workflowFormat:'api'|'ui'|'wangp-settings';bindings:WorkflowBinding[];enabled:boolean;notes?:string; }
export interface KeyframeRequest { projectRoot:string;shotId:UUID;role:'start'|'end';workflowProfileId:UUID; }
export interface RenderRequest { projectRoot:string;shotId:UUID;forceWorkflowProfileId?:UUID; }
export interface RenderBatchRequest { projectRoot:string;shotIds:UUID[];skipIfRendered?:boolean; }
export interface QueueSnapshot { runningJobId?:UUID;jobs:RenderJob[]; }
export interface SystemProbe {
  gpu?:{name:string;totalVramMb?:number;freeVramMb?:number;driver?:string;};
  ffmpeg:{available:boolean;version?:string;};
  comfy:{reachable:boolean;url:string;systemStats?:unknown;error?:string;};
  wangp:{configured:boolean;available:boolean;rootPath:string;entrypoint?:string;pythonPath?:string;error?:string;};
}
export type ValidationLevel='error'|'warning'|'info';
export interface ValidationIssue { level:ValidationLevel;code:string;message:string;shotId?:UUID;profileId?:UUID;assetId?:UUID; }
export interface PreflightReport { createdAt:ISODate;ready:boolean;issues:ValidationIssue[];probe:SystemProbe; }
export interface ContinuityReview { issues:string[];suggestedContinuityNotes:string;promptAddendum:string; }
export interface DirectorShotDraft { title:string;prompt:string;camera:string;action:string;dialogue:string;continuityNotes:string;quality:QualityIntent;preferredModel?:ModelFamily;characterAssetIds?:UUID[];locationAssetId?:UUID;propAssetIds?:UUID[]; }
export interface ParsedScene { heading:string;body:string;location?:string;timeOfDay?:string; }
