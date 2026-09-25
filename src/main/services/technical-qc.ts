import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppMachineSettings, Shot, TechnicalQcResult } from '../../shared/types';

const execFileAsync=promisify(execFile);

export async function technicalQcVideo(machine:AppMachineSettings,path:string,shot?:Shot):Promise<TechnicalQcResult>{
  const issues:string[]=[];
  const probe=await probeMedia(machine.ffmpeg.ffprobePath,path);
  if(!probe.video)issues.push('No video stream found.');
  const duration=probe.durationSec;
  if(shot&&duration!=null){
    const expected=shot.generation.frames/Math.max(1,shot.generation.fps);
    if(Math.abs(duration-expected)>Math.max(0.75,expected*0.2))issues.push(`Duration ${duration.toFixed(2)}s differs materially from expected ${expected.toFixed(2)}s.`);
  }
  if(shot&&probe.video){
    if(probe.video.width!==shot.generation.width||probe.video.height!==shot.generation.height)issues.push(`Resolution is ${probe.video.width}×${probe.video.height}; expected ${shot.generation.width}×${shot.generation.height}.`);
    if(Math.abs(probe.video.fps-shot.generation.fps)>0.5)issues.push(`FPS is ${probe.video.fps.toFixed(2)}; expected ${shot.generation.fps}.`);
    if(shot.generation.includeAudio&&!probe.hasAudio)issues.push('Shot requested audio but output has no audio stream.');
  }
  const visual=await detectVisualProblems(machine.ffmpeg.path,path).catch(()=>({black:false,freeze:false}));
  if(visual.black)issues.push('Black segment ≥0.5s detected.');
  if(visual.freeze)issues.push('Frozen segment ≥2s detected.');
  const audioPeakDb=probe.hasAudio?await detectPeak(machine.ffmpeg.path,path).catch(()=>undefined):undefined;
  if(audioPeakDb!=null&&audioPeakDb>-0.1)issues.push(`Audio peak is ${audioPeakDb.toFixed(1)} dB; clipping risk.`);
  return{checkedAt:new Date().toISOString(),passed:issues.length===0,durationSec:duration,width:probe.video?.width,height:probe.video?.height,fps:probe.video?.fps,hasAudio:probe.hasAudio,audioPeakDb,issues};
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

async function detectPeak(ffmpeg:string,path:string):Promise<number|undefined>{
  const result=await execFileAsync(ffmpeg,['-hide_banner','-nostats','-i',path,'-vn','-af','volumedetect','-f','null','-'],{timeout:120_000,maxBuffer:8*1024*1024});
  const text=String(result.stderr||'');const match=text.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);return match?Number(match[1]):undefined;
}
