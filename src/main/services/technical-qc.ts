import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppMachineSettings, Shot, TechnicalQcResult } from '../../shared/types';

const execFileAsync=promisify(execFile);

export async function technicalQcVideo(machine:AppMachineSettings,path:string,shot?:Shot):Promise<TechnicalQcResult>{
  const issues:string[]=[],warnings:string[]=[];
  const probe=await probeMedia(machine.ffmpeg.ffprobePath,path);
  if(!probe.video)issues.push('No video stream found.');
  const duration=probe.durationSec;
  if(shot)issues.push(...technicalQcStructuralIssues(shot,probe));

  try{
    const visual=await detectVisualProblems(machine.ffmpeg.path,path);
    if(visual.black)warnings.push('Black segment ≥0.5s detected; verify that the blackout/fade is intentional.');
    if(visual.freeze)warnings.push('Frozen segment ≥2s detected; verify that the held frame is intentional.');
  }catch(error){issues.push(`Visual QC could not complete: ${error instanceof Error?error.message:String(error)}`);}
  let audioPeakDb:number|undefined,audioSilent=false;
  if(probe.hasAudio){
    try{const peak=await detectPeak(machine.ffmpeg.path,path);audioPeakDb=peak.peakDb;audioSilent=peak.silent;}
    catch(error){issues.push(`Audio QC could not complete: ${error instanceof Error?error.message:String(error)}`);}
  }
  if(shot?.generation.includeAudio&&probe.hasAudio&&audioSilent)issues.push('Shot requested audio, but the output audio stream is silent.');
  if(audioPeakDb!=null&&audioPeakDb>-0.1)warnings.push(`Audio peak is ${audioPeakDb.toFixed(1)} dB; clipping risk.`);
  return{checkedAt:new Date().toISOString(),passed:issues.length===0,warnings:warnings.slice(0,128).map(value=>value.slice(0,4096)),durationSec:duration,width:probe.video?.width,height:probe.video?.height,fps:probe.video?.fps,hasAudio:probe.hasAudio,audioPeakDb,issues:issues.slice(0,128).map(value=>value.slice(0,4096))};
}

export function technicalQcStructuralIssues(
  shot:Shot,
  probe:{durationSec?:number;video?:{width:number;height:number;fps:number};hasAudio:boolean}
):string[]{
  const issues:string[]=[];
  if(probe.durationSec==null)issues.push('Video duration could not be measured.');
  else{
    const expected=shot.generation.frames/Math.max(1,shot.generation.fps);
    if(Math.abs(probe.durationSec-expected)>Math.max(0.75,expected*0.2))issues.push(`Duration ${probe.durationSec.toFixed(2)}s differs materially from expected ${expected.toFixed(2)}s.`);
  }
  if(probe.video){
    if(probe.video.width!==shot.generation.width||probe.video.height!==shot.generation.height)issues.push(`Resolution is ${probe.video.width}×${probe.video.height}; expected ${shot.generation.width}×${shot.generation.height}.`);
    if(Math.abs(probe.video.fps-shot.generation.fps)>0.5)issues.push(`FPS is ${probe.video.fps.toFixed(2)}; expected ${shot.generation.fps}.`);
  }
  if(shot.generation.includeAudio&&!probe.hasAudio)issues.push('Shot requested audio but output has no audio stream.');
  return issues;
}

export function parseVolumeDetectPeak(text:string):{peakDb?:number;silent:boolean}{
  if(/max_volume:\s*-inf\s*dB/i.test(text))return{silent:true};
  const match=text.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  return{peakDb:match?Number(match[1]):undefined,silent:false};
}

async function probeMedia(ffprobe:string,path:string):Promise<{durationSec?:number;video?:{width:number;height:number;fps:number};hasAudio:boolean}>{
  const{stdout}=await execFileAsync(ffprobe,['-v','error','-print_format','json','-show_streams','-show_format',path],{timeout:30_000,maxBuffer:8*1024*1024});
  const parsed=JSON.parse(stdout) as any;const video=parsed.streams?.find((s:any)=>s.codec_type==='video');
  const rate=String(video?.avg_frame_rate||video?.r_frame_rate||'0/1').split('/').map(Number);const fps=rate[1]?rate[0]/rate[1]:rate[0]||0;const duration=Number(parsed.format?.duration??video?.duration);
  return{durationSec:Number.isFinite(duration)?duration:undefined,video:video?{width:Number(video.width)||0,height:Number(video.height)||0,fps:Number.isFinite(fps)?fps:0}:undefined,hasAudio:Boolean(parsed.streams?.some((s:any)=>s.codec_type==='audio'))};
}

async function detectVisualProblems(ffmpeg:string,path:string):Promise<{black:boolean;freeze:boolean}>{
  const result=await execFileAsync(ffmpeg,['-hide_banner','-nostats','-i',path,'-vf','blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2','-an','-f','null','-'],{timeout:180_000,maxBuffer:16*1024*1024});
  const stderr=String(result.stderr||'');
  return{black:/black_start:/i.test(stderr),freeze:/freeze_start:/i.test(stderr)};
}

async function detectPeak(ffmpeg:string,path:string):Promise<{peakDb?:number;silent:boolean}>{
  const result=await execFileAsync(ffmpeg,['-hide_banner','-nostats','-i',path,'-vn','-af','volumedetect','-f','null','-'],{timeout:120_000,maxBuffer:8*1024*1024});
  return parseVolumeDetectPeak(String(result.stderr||''));
}
