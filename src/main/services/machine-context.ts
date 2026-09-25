import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMachineSettings, FilmProject, SystemProbe } from '../../shared/types';
import { assertSafeWritePath } from './path-safety';

export async function writeCodexMachineContext(project:FilmProject,machine:AppMachineSettings,probe:SystemProbe):Promise<string>{
  const dir=join(project.rootPath,'.cineforge');await mkdir(dir,{recursive:true});
  const jsonPath=await assertSafeWritePath(dir,join(dir,'machine-context.json'),'Codex machine context');
  const mdPath=await assertSafeWritePath(dir,join(dir,'CODEX_MACHINE_CONTEXT.md'),'Codex machine context');
  const snapshot={
    generatedAt:new Date().toISOString(),projectId:project.id,
    policy:{capcutTier:project.settings.capcut.pro?'pro':'free',capcutAiCreditsAllowed:project.settings.costPolicy.allowCapcutAiCredits,cloudGenerationAllowed:false},
    platform:probe.platform,cpu:probe.cpu,gpu:probe.gpu,memory:probe.memory,disk:probe.disk,ffmpeg:probe.ffmpeg,capcut:probe.capcut,wangp:probe.wangp,docker:probe.docker,hardwarePlan:probe.hardwarePlan,
    runtimePolicy:{aiEndpoints:'loopback-only',wanGpExecutionMode:machine.wangp.executionMode,comfyDedicated:machine.comfy.dedicatedInstance}
  };
  await writeFile(jsonPath,JSON.stringify(snapshot,null,2),'utf8');
  const ram=probe.memory?`${(probe.memory.totalMb/1024).toFixed(1)} GB total · ${(probe.memory.freeMb/1024).toFixed(1)} GB free`:'unknown';
  const vram=probe.gpu?.totalVramMb?`${(probe.gpu.totalVramMb/1024).toFixed(1)} GB total · ${((probe.gpu.freeVramMb||0)/1024).toFixed(1)} GB free`:'unknown';
  const disk=probe.disk?`${(probe.disk.freeBytes/1024/1024/1024).toFixed(1)} GB`:'unknown';
  const md=[
    '# CineForge machine context','',`Generated: ${snapshot.generatedAt}`,'','## Hardware','',
    `- Platform: ${probe.platform.platform} ${probe.platform.release} (${probe.platform.arch})`,
    `- CPU: ${probe.cpu.model} · ${probe.cpu.physicalCores??'?'} physical / ${probe.cpu.logicalCores} logical cores`,
    `- RAM: ${ram}`,`- GPU: ${probe.gpu?.name||'not detected'}`,`- VRAM: ${vram}`,
    `- NVIDIA driver: ${probe.gpu?.driver||'unknown'}`,`- Compute capability: ${probe.gpu?.computeCapability||'unknown'}`,`- Driver CUDA: ${probe.gpu?.cudaVersion||'unknown'}`,`- Project disk free: ${disk}`,'',
    '## Runtime','',`- WanGP: ${probe.wangp.available?'ready':'not ready'} · ${probe.wangp.executionMode}`,`- WanGP runtime: ${probe.wangp.runtimeVersion||probe.wangp.error||'unknown'}`,`- WanGP Python: ${probe.wangp.pythonVersion||'unknown'}`,`- PyTorch / CUDA: ${probe.wangp.torchVersion||'unknown'} / ${probe.wangp.torchCudaVersion||'unknown'}`,`- FFmpeg/FFprobe: ${probe.ffmpeg.available?'yes':'no'} / ${probe.ffmpeg.ffprobeAvailable?'yes':'no'}`,`- CapCut installed: ${probe.capcut.installed?'yes':'no'}`,`- CapCut configured tier: ${project.settings.capcut.pro?'PRO':'FREE / NO PRO'}`,`- CapCut AI credits: ${project.settings.costPolicy.allowCapcutAiCredits?'ALLOWED':'DISABLED'}`,'',
    '## Orchestrator defaults','',`- Hardware tier: ${probe.hardwarePlan.tier}`,`- WanGP profile: ${probe.hardwarePlan.recommendedWanGpProfile}`,`- Attention: ${probe.hardwarePlan.recommendedAttention}`,`- Default video route: ${probe.hardwarePlan.defaultVideoModel}`,`- Still/keyframe strategy: ${probe.hardwarePlan.defaultStillStrategy}`,'',
    ...probe.hardwarePlan.notes.map(n=>`- ${n}`),'','Codex should read this file before choosing models, resolution, duration, concurrency, or GPU-heavy post-processing for this project.',''
  ].join('\n');
  await writeFile(mdPath,md,'utf8');return mdPath;
}
