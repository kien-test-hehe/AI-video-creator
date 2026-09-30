import type { AppMachineSettings, FilmProject, WorkstationReadiness, WorkstationReadinessItem } from '../../shared/types';
import { probeSystem } from './system-probe';

export async function assessWorkstationReadiness(project:FilmProject|undefined,machine:AppMachineSettings):Promise<WorkstationReadiness>{
  const probe=await probeSystem(project,machine);
  const items:WorkstationReadinessItem[]=[];
  const add=(id:string,label:string,level:WorkstationReadinessItem['level'],detail:string,action?:string)=>items.push({id,label,level,detail,action});

  if(!probe.gpu)add('gpu','NVIDIA GPU','blocked','No NVIDIA GPU was detected through nvidia-smi.','Install/update the NVIDIA driver and reboot.');
  else if((probe.gpu.totalVramMb??0)<15000)add('gpu','GPU / VRAM','warning',`${probe.gpu.name} · ${((probe.gpu.totalVramMb??0)/1024).toFixed(1)} GB VRAM. CineForge is tuned around a 16 GB production envelope.`,'Use lower validated profiles and shorter shots.');
  else if((probe.gpu.freeVramMb??0)<4096)add('gpu','GPU / VRAM','blocked',`${probe.gpu.name} · only ${((probe.gpu.freeVramMb??0)/1024).toFixed(1)} GB VRAM free right now.`,'Close CapCut, browsers, games or other GPU workloads before generation.');
  else if((probe.gpu.freeVramMb??0)<8192)add('gpu','GPU / VRAM','warning',`${probe.gpu.name} · ${((probe.gpu.totalVramMb??0)/1024).toFixed(1)} GB total · only ${((probe.gpu.freeVramMb??0)/1024).toFixed(1)} GB free.`,'Generation can proceed, but close other GPU-heavy applications for long/hero shots.');
  else add('gpu','GPU / VRAM','ready',`${probe.gpu.name} · ${((probe.gpu.totalVramMb??0)/1024).toFixed(1)} GB total · ${((probe.gpu.freeVramMb??0)/1024).toFixed(1)} GB free.`);

  if(!probe.memory)add('ram','System RAM','warning','RAM availability could not be measured.');
  else if(probe.memory.freeMb<6*1024)add('ram','System RAM','blocked',`Only ${(probe.memory.freeMb/1024).toFixed(1)} GB RAM is free.`,'Close heavy applications before generation.');
  else if(probe.memory.freeMb<10*1024)add('ram','System RAM','warning',`${(probe.memory.freeMb/1024).toFixed(1)} GB RAM free of ${(probe.memory.totalMb/1024).toFixed(1)} GB.`,'Close browsers/NLE work before long batches.');
  else add('ram','System RAM','ready',`${(probe.memory.freeMb/1024).toFixed(1)} GB free of ${(probe.memory.totalMb/1024).toFixed(1)} GB.`);

  if(!probe.ffmpeg.available||!probe.ffmpeg.ffprobeAvailable)add('ffmpeg','FFmpeg / FFprobe','blocked','FFmpeg and FFprobe are required for QC, frame extraction and export.','Run setup.cmd again.');
  else add('ffmpeg','FFmpeg / FFprobe','ready',probe.ffmpeg.encoderAvailable?'Media analysis and preferred encoder are available.':'Media analysis is available; preferred H.264 encoder was not detected.');

  const localRuntimeReady=probe.wangp.available||probe.comfy.reachable;
  add('runtime','Local generation runtime',localRuntimeReady?'ready':'blocked',probe.wangp.available?'WanGP is ready.':probe.comfy.reachable?'ComfyUI is reachable.':'Neither WanGP nor ComfyUI is ready.','Run setup.cmd or configure a dedicated local ComfyUI instance.');

  const profiles=(project?.settings.workflowProfiles??[]).filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid');
  const validatedProfiles=profiles.filter(profile=>Boolean(profile.validation?.lastSuccessfulRenderAt));
  if(!project)add('profiles','Production profiles','warning','Open a project to inspect production workflow qualification.');
  else if(validatedProfiles.length)add('profiles','Production profiles','ready',`${validatedProfiles.length} video profile(s) have a recorded successful render on this workstation/project.`);
  else if(profiles.length)add('profiles','Production profiles','warning',`${profiles.length} structurally valid video profile(s), but none has a recorded successful render yet.`,'Run one short qualification render per intended production route.');
  else add('profiles','Production profiles','blocked','No enabled structurally valid video workflow profile is available.','Provision/import and validate at least one local video workflow.');

  const autoQcAvailable=Boolean(machine.director.model.trim());
  add(
    'auto-qc',
    'Automatic visual QC',
    'warning',
    autoQcAvailable
      ? `Local Director/VLM model configured: ${machine.director.model}. Configuration alone does not prove multimodal compatibility; CineForge verifies it on real QC calls and fails safely to Human Review if image input/JSON output is unsupported.`
      : 'No local Director/VLM model is configured. CineForge will fail safely to Human Review for visual/semantic QC.',
    autoQcAvailable?'Run a short qualification take to verify real image-input QC before relying on AUTO RUN.':'Configure a local OpenAI-compatible multimodal model in Machine Settings.'
  );

  add('blender','Blender previz',probe.blender?.available?'ready':'warning',probe.blender?.available?(probe.blender.version||'Blender detected.'):'Blender was not detected. Required previz shots will become Human Tasks instead of blocking the app.','Install Blender or keep previz optional.');
  add('capcut','CapCut finishing',probe.capcut.installed?'ready':'warning',probe.capcut.installed?`CapCut detected${probe.capcut.path?` at ${probe.capcut.path}`:''}.`:'CapCut was not detected. Local master export still works; finishing handoff can be used after CapCut is installed.');

  if(probe.disk){
    const freeGb=probe.disk.freeBytes/1024/1024/1024;
    add('disk','Project disk',freeGb<10?'blocked':freeGb<40?'warning':'ready',`${freeGb.toFixed(1)} GB free on the project volume.`,freeGb<40?'Free more space before model downloads or long batches.':undefined);
  }

  return{checkedAt:new Date().toISOString(),readyForProduction:!items.some(item=>item.level==='blocked'),autoQcAvailable,blenderAvailable:Boolean(probe.blender?.available),validatedVideoProfiles:validatedProfiles.length,items,probe};
}
