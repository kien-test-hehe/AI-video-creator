import type { AppMachineSettings, AssetKind, ContinuityReview, DirectorShotDraft, FilmProject, KeyframeRequest, ParsedScene, PreflightReport, QueueSnapshot, RenderBatchRequest, RenderRequest, SystemProbe, WanGpCatalogEntry, WorkflowProfile } from './types';

export interface CapCutHandoffResult { directory: string; manifestPath: string; taskPath: string; prompt: string; }

export interface CineforgeApi {
  project: {
    create(name?: string): Promise<FilmProject | null>;
    open(): Promise<FilmProject | null>;
    save(project: FilmProject): Promise<FilmProject>;
    get(): Promise<FilmProject | null>;
    parseScript(script: string): Promise<ParsedScene[]>;
    preflight(): Promise<PreflightReport>;
  };
  settings: {
    get(): Promise<AppMachineSettings>;
    save(settings: AppMachineSettings): Promise<AppMachineSettings>;
  };
  asset: { import(kind: AssetKind): Promise<FilmProject | null>; delete(assetId: string): Promise<FilmProject>; };
  workflow: {
    importComfy(): Promise<{ path: string; format: 'api' | 'ui'; suggestedBindings: WorkflowProfile['bindings']; warnings?: string[] } | null>;
    importWanGp(): Promise<{ path: string; format: 'wangp-settings'; suggestedBindings: WorkflowProfile['bindings']; warnings?: string[] } | null>;
    inspect(path: string): Promise<{ format: 'api' | 'ui' | 'wangp-settings'; suggestedBindings: WorkflowProfile['bindings'] }>;
    validate(profileId: string): Promise<FilmProject>;
    wanGpCatalog(): Promise<WanGpCatalogEntry[]>;
    provisionRecommendedWanGp(): Promise<FilmProject>;
  };
  system: {
    probe(): Promise<SystemProbe>;
    pingComfy(url?: string): Promise<SystemProbe['comfy']>;
    reveal(path: string): Promise<void>;
  };
  render: {
    enqueue(request: RenderRequest): Promise<QueueSnapshot>;
    enqueueBatch(request: RenderBatchRequest): Promise<QueueSnapshot>;
    retry(jobId: string): Promise<QueueSnapshot>;
    cancel(jobId: string): Promise<QueueSnapshot>;
    snapshot(): Promise<QueueSnapshot>;
    onQueueEvent(handler: (snapshot: QueueSnapshot) => void): () => void;
  };
  timeline: { export(): Promise<{ outputPath: string } | null>; cancelExport(): Promise<void>; };
  director: {
    planScene(sceneId: string): Promise<DirectorShotDraft[]>;
    reviewShot(shotId: string): Promise<ContinuityReview>;
  };
  keyframe: { generate(request: KeyframeRequest): Promise<FilmProject>; cancel(): Promise<boolean>; };
  capcut: { prepareHandoff(): Promise<CapCutHandoffResult>; };
}
