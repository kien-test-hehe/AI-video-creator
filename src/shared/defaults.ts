import type { ModelFamily, ShotGenerationSettings, WorkflowProfile } from './types';

export const PRIMARY_VIDEO_MODEL: ModelFamily = 'ltx-2.5-fast';

export const MODEL_DEFAULTS: Record<ModelFamily, Partial<ShotGenerationSettings>> = {
  'ltx-2.5-fast': { mode: 'i2v', quality: 'balanced', width: 768, height: 432, frames: 121, fps: 24, steps: 8, cfg: 1, includeAudio: true },
  'ltx-2.3': { mode: 'flf2v', quality: 'balanced', width: 768, height: 432, frames: 121, fps: 24, steps: 8, cfg: 1, includeAudio: true },
  'hunyuan-video-1.5': { mode: 'i2v', quality: 'hero', width: 832, height: 480, frames: 97, fps: 24, steps: 20, cfg: 1, includeAudio: false },
  'wan-2.2-5b': { mode: 'i2v', quality: 'balanced', width: 832, height: 480, frames: 81, fps: 24, steps: 20, cfg: 5, includeAudio: false },
  framepack: { mode: 'i2v', quality: 'balanced', width: 640, height: 384, frames: 241, fps: 24, steps: 25, cfg: 1, includeAudio: false },
  custom: { mode: 'i2v', quality: 'balanced', width: 768, height: 432, frames: 97, fps: 24, steps: 20, cfg: 1, includeAudio: false }
};

export const BUILTIN_WORKFLOW_PROFILES: WorkflowProfile[] = [
  { id:'builtin-wangp-ltx25-i2v',runtime:'wangp',name:'WanGP · LTX-2.5 Fast I2V / AV',purpose:'video',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'',workflowFormat:'wangp-settings',enabled:false,notes:'Export a working LTX-2.5 settings JSON from WanGP, import it here, then bind prompt/seed/dimensions and references by JSON path.',bindings:[] },
  { id:'builtin-wangp-hunyuan15-i2v',runtime:'wangp',name:'WanGP · HunyuanVideo-1.5 I2V',purpose:'video',modelFamily:'hunyuan-video-1.5',mode:'i2v',workflowPath:'',workflowFormat:'wangp-settings',enabled:false,notes:'Quality-biased hero-shot profile using a WanGP-exported HunyuanVideo-1.5 settings JSON.',bindings:[] },
  { id:'builtin-wangp-wan22-5b-i2v',runtime:'wangp',name:'WanGP · Wan 2.2 TI2V 5B',purpose:'video',modelFamily:'wan-2.2-5b',mode:'i2v',workflowPath:'',workflowFormat:'wangp-settings',enabled:false,notes:'General/motion-heavy low-VRAM route using an exported WanGP settings JSON.',bindings:[] },
  { id:'builtin-comfy-ltx25-i2v',runtime:'comfyui',name:'ComfyUI · LTX-2.5 Fast I2V / AV',purpose:'video',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'',workflowFormat:'api',enabled:false,notes:'R&D/fallback graph. Import an API-format ComfyUI workflow and bind its nodes.',bindings:[] },
  { id:'builtin-comfy-hunyuan15-i2v',runtime:'comfyui',name:'ComfyUI · HunyuanVideo-1.5 I2V',purpose:'video',modelFamily:'hunyuan-video-1.5',mode:'i2v',workflowPath:'',workflowFormat:'api',enabled:false,notes:'R&D/fallback graph for a locally validated HunyuanVideo-1.5 API workflow.',bindings:[] },
  { id:'builtin-comfy-wan22-5b-i2v',runtime:'comfyui',name:'ComfyUI · Wan 2.2 TI2V 5B',purpose:'video',modelFamily:'wan-2.2-5b',mode:'i2v',workflowPath:'',workflowFormat:'api',enabled:false,notes:'R&D/fallback graph for a locally validated Wan 2.2 TI2V 5B API workflow.',bindings:[] },
  { id:'builtin-comfy-ltx23-flf2v',runtime:'comfyui',name:'ComfyUI · LTX-2.3 FLF2V / legacy controls',purpose:'video',modelFamily:'ltx-2.3',mode:'flf2v',workflowPath:'',workflowFormat:'api',enabled:false,notes:'Compatibility route for older Retake/Extend-era local graphs.',bindings:[] },
  { id:'builtin-comfy-framepack-i2v',runtime:'comfyui',name:'ComfyUI · FramePack long-shot I2V',purpose:'video',modelFamily:'framepack',mode:'i2v',workflowPath:'',workflowFormat:'api',enabled:false,notes:'Optional long-shot route when a validated FramePack graph is available.',bindings:[] }
];
