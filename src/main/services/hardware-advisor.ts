import type { HardwarePlan, SystemProbe } from '../../shared/types';

export function deriveHardwarePlan(input:Pick<SystemProbe,'gpu'|'memory'|'cpu'>):HardwarePlan{
  const name=input.gpu?.name||'',vram=input.gpu?.totalVramMb||0;
  const notes:string[]=[];
  if(/RTX\s*50/i.test(name)&&vram>=15000){
    notes.push('RTX 50-series detected: prefer the current WanGP Python 3.11 / PyTorch 2.10 / CUDA 13.x stack.');
    notes.push('16 GB VRAM: use WanGP profile 4, short 4–6s shots, and avoid 1080p as a default batch resolution.');
    notes.push('LTX-2.5 Distilled NVFP4 is the default general route; use HunyuanVideo 1.5 selectively for hero I2V shots.');
    return{tier:'rtx50-16gb',recommendedWanGpProfile:4,recommendedAttention:'auto',defaultVideoModel:'ltx-2.5-fast',defaultStillStrategy:'Qwen Image 2.1 / Qwen Image Edit for keyframes and identity-aware still edits',notes};
  }
  if(vram>=15000){
    notes.push('16 GB+ NVIDIA VRAM detected: use full local video routes with conservative shot durations.');
    return{tier:'nvidia-16gb-plus',recommendedWanGpProfile:4,recommendedAttention:'auto',defaultVideoModel:'ltx-2.5-fast',defaultStillStrategy:'Qwen Image / Krea identity-edit route',notes};
  }
  if(vram>=11000){
    notes.push('12 GB-class NVIDIA GPU: reduce resolution/frames and prefer quantized checkpoints.');
    return{tier:'nvidia-12gb-plus',recommendedWanGpProfile:4,recommendedAttention:'auto',defaultVideoModel:'wan-2.2-5b',defaultStillStrategy:'efficient local image model / quantized edit model',notes};
  }
  if(vram>0){
    notes.push('Low-VRAM NVIDIA GPU: use aggressive offload/quantization and short preview shots.');
    return{tier:'nvidia-low-vram',recommendedWanGpProfile:5,recommendedAttention:'sdpa',defaultVideoModel:'wan-2.2-5b',defaultStillStrategy:'small/quantized local image route',notes};
  }
  notes.push('No NVIDIA GPU was detected. Local video generation is not considered ready.');
  return{tier:'unknown',recommendedWanGpProfile:5,recommendedAttention:'sdpa',defaultVideoModel:'custom',defaultStillStrategy:'not determined',notes};
}
