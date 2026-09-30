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
    const findings=technicalQcVisualFindings(duration,visual);
    issues.push(...findings.issues);warnings.push(...findings.warnings);
  }catch(error){issues.push(`Visual QC could not complete: ${error instanceof Error?error.message:String(error)}`);}
  let audioPeakDb:number|undefined,audioSilent=false,audioIntegratedLufs:number|undefined,maxSilenceSec:number|undefined,totalSilenceSec:number|undefined;
  if(probe.hasAudio){
    try{const peak=await detectPeak(machine.ffmpeg.path,path);audioPeakDb=peak.peakDb;audioSilent=peak.silent;}
    catch(error){issues.push(`Audio peak QC could not complete: ${error instanceof Error?error.message:String(error)}`);}
    try{
      const audio=await detectAudioProblems(machine.ffmpeg.path,path);
      audioIntegratedLufs=audio.integratedLufs;maxSilenceSec=audio.maxSilenceSec;totalSilenceSec=audio.totalSilenceSec;
      const findings=technicalAudioFindings(shot,duration,audio);
      issues.push(...findings.issues);warnings.push(...findings.warnings);
    }catch(error){issues.push(`Audio temporal QC could not complete: ${error instanceof Error?error.message:String(error)}`);}
  }
  const expectsAudio=Boolean(shot&&(shot.generation.includeAudio||shot.dialogue.trim()));
  if(expectsAudio&&probe.hasAudio&&audioSilent)issues.push('Shot expects audible dialogue/audio, but the output audio stream is silent.');
  if(audioPeakDb!=null&&audioPeakDb>-0.1)warnings.push(`Audio peak is ${audioPeakDb.toFixed(1)} dBFS; clipping risk.`);
  return{checkedAt:new Date().toISOString(),passed:issues.length===0,warnings:warnings.slice(0,128).map(value=>value.slice(0,4096)),durationSec:duration,width:probe.video?.width,height:probe.video?.height,fps:probe.video?.fps,hasAudio:probe.hasAudio,audioPeakDb,audioIntegratedLufs,maxSilenceSec,totalSilenceSec,issues:issues.slice(0,128).map(value=>value.slice(0,4096))};
}

export function technicalQcStructuralIssues(
  shot:Shot,
  probe:{durationSec?:number;video?:{width:number;height:number;fps:number};hasAudio:boolean}
):string[]{
  const issues:string[]=[];
  if(probe.durationSec==null)issues.push('Video duration could not be measured.');
  else{
    const expected=shot.generation.frames/Math.max(1,shot.generation.fps);
    if(Math.abs(probe.durationSec-expected)>Math.max(0.5,expected*0.1))issues.push(`Duration ${probe.durationSec.toFixed(2)}s differs materially from expected ${expected.toFixed(2)}s.`);
  }
  if(probe.video){
    if(probe.video.width!==shot.generation.width||probe.video.height!==shot.generation.height)issues.push(`Resolution is ${probe.video.width}×${probe.video.height}; expected ${shot.generation.width}×${shot.generation.height}.`);
    if(Math.abs(probe.video.fps-shot.generation.fps)>0.5)issues.push(`FPS is ${probe.video.fps.toFixed(2)}; expected ${shot.generation.fps}.`);
  }
  if((shot.generation.includeAudio||shot.dialogue.trim())&&!probe.hasAudio)issues.push('Shot expects dialogue/audio but output has no audio stream.');
  return issues;
}

export function parseVolumeDetectPeak(text:string):{peakDb?:number;silent:boolean}{
  if(/max_volume:\s*-inf\s*dB/i.test(text))return{silent:true};
  const match=text.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  return{peakDb:match?Number(match[1]):undefined,silent:false};
}

export interface AudioProblemMetrics{
  integratedLufs?:number;
  maxSilenceSec:number;
  totalSilenceSec:number;
}

export function parseAudioProblemMetrics(text:string):AudioProblemMetrics{
  const silenceDurations=[...text.matchAll(/silence_duration\s*:\s*([0-9]+(?:\.[0-9]+)?)/gi)]
    .map(match=>Number(match[1])).filter(Number.isFinite);
  const lufs=[...text.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi)]
    .map(match=>Number(match[1])).filter(Number.isFinite);
  return{
    integratedLufs:lufs.length?lufs[lufs.length-1]:undefined,
    maxSilenceSec:silenceDurations.length?Math.max(...silenceDurations):0,
    totalSilenceSec:silenceDurations.reduce((sum,value)=>sum+value,0)
  };
}

export function technicalAudioFindings(
  shot:Shot|undefined,
  durationSec:number|undefined,
  audio:AudioProblemMetrics
):{issues:string[];warnings:string[]}{
  const issues:string[]=[],warnings:string[]=[];
  const expectsAudio=Boolean(shot&&(shot.generation.includeAudio||shot.dialogue.trim()));
  if(expectsAudio&&durationSec&&durationSec>0){
    if(audio.totalSilenceSec>=Math.max(1.5,durationSec*.8)){
      issues.push(`Audio is mostly silent (${audio.totalSilenceSec.toFixed(2)}s detected silence across ${durationSec.toFixed(2)}s) despite dialogue/audio intent.`);
    }else if(audio.maxSilenceSec>=Math.max(2.5,durationSec*.65)){
      warnings.push(`Long silent span detected (${audio.maxSilenceSec.toFixed(2)}s). Verify that the pause is intentional.`);
    }
  }
  if(audio.integratedLufs!=null){
    if(audio.integratedLufs>-8)warnings.push(`Integrated loudness is ${audio.integratedLufs.toFixed(1)} LUFS; the take is unusually hot and may need normalization.`);
    else if(audio.integratedLufs<-32)warnings.push(`Integrated loudness is ${audio.integratedLufs.toFixed(1)} LUFS; dialogue/audio may be too quiet.`);
  }
  return{issues,warnings};
}

async function probeMedia(ffprobe:string,path:string):Promise<{durationSec?:number;video?:{width:number;height:number;fps:number};hasAudio:boolean}>{
  const{stdout}=await execFileAsync(ffprobe,['-v','error','-print_format','json','-show_streams','-show_format',path],{timeout:30_000,maxBuffer:8*1024*1024});
  const parsed=JSON.parse(stdout) as any;const video=parsed.streams?.find((s:any)=>s.codec_type==='video');
  const rate=String(video?.avg_frame_rate||video?.r_frame_rate||'0/1').split('/').map(Number);const fps=rate[1]?rate[0]/rate[1]:rate[0]||0;const duration=Number(parsed.format?.duration??video?.duration);
  return{durationSec:Number.isFinite(duration)?duration:undefined,video:video?{width:Number(video.width)||0,height:Number(video.height)||0,fps:Number.isFinite(fps)?fps:0}:undefined,hasAudio:Boolean(parsed.streams?.some((s:any)=>s.codec_type==='audio'))};
}

export interface VisualProblemDurations{
  blackDetected:boolean;
  freezeDetected:boolean;
  maxBlackSec:number;
  maxFreezeSec:number;
}

export function parseVisualProblemDurations(text:string):VisualProblemDurations{
  const values=(pattern:RegExp)=>[...text.matchAll(pattern)].map(match=>Number(match[1])).filter(Number.isFinite);
  const black=values(/black_duration\s*:\s*([0-9]+(?:\.[0-9]+)?)/gi);
  const freeze=values(/freeze_duration\s*:\s*([0-9]+(?:\.[0-9]+)?)/gi);
  const blackDetected=/black_start\s*:/i.test(text);
  const freezeDetected=/freeze_start\s*:/i.test(text);
  return{
    blackDetected,
    freezeDetected,
    maxBlackSec:black.length?Math.max(...black):(blackDetected?0.5:0),
    maxFreezeSec:freeze.length?Math.max(...freeze):(freezeDetected?2:0)
  };
}

export function technicalQcVisualFindings(
  durationSec:number|undefined,
  visual:VisualProblemDurations
):{issues:string[];warnings:string[]}{
  const issues:string[]=[],warnings:string[]=[];
  if(visual.blackDetected){
    const materialThreshold=durationSec!=null?Math.max(1,durationSec*.2):1.5;
    const detail=`Black segment up to ${visual.maxBlackSec.toFixed(2)}s detected.`;
    if(visual.maxBlackSec>=materialThreshold)issues.push(`${detail} This is a material blackout for a generated source take; rerender or trim it before canonical use.`);
    else warnings.push(`${detail} Verify that the blackout/fade is intentional.`);
  }
  if(visual.freezeDetected){
    const materialThreshold=durationSec!=null?Math.max(2,durationSec*.4):3;
    const detail=`Frozen segment up to ${visual.maxFreezeSec.toFixed(2)}s detected.`;
    if(visual.maxFreezeSec>=materialThreshold)issues.push(`${detail} This is a material freeze for a generated source take; rerender or trim it before canonical use.`);
    else warnings.push(`${detail} Verify that the held frame is intentional.`);
  }
  return{issues,warnings};
}

async function detectVisualProblems(ffmpeg:string,path:string):Promise<VisualProblemDurations>{
  const result=await execFileAsync(ffmpeg,['-hide_banner','-nostats','-i',path,'-vf','blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2','-an','-f','null','-'],{timeout:180_000,maxBuffer:16*1024*1024});
  return parseVisualProblemDurations(String(result.stderr||''));
}

async function detectPeak(ffmpeg:string,path:string):Promise<{peakDb?:number;silent:boolean}>{
  const result=await execFileAsync(ffmpeg,['-hide_banner','-nostats','-i',path,'-vn','-af','volumedetect','-f','null','-'],{timeout:120_000,maxBuffer:8*1024*1024});
  return parseVolumeDetectPeak(String(result.stderr||''));
}

async function detectAudioProblems(ffmpeg:string,path:string):Promise<AudioProblemMetrics>{
  const result=await execFileAsync(
    ffmpeg,
    ['-hide_banner','-nostats','-i',path,'-vn','-af','silencedetect=noise=-50dB:d=0.4,ebur128=framelog=verbose:peak=true','-f','null','-'],
    {timeout:180_000,maxBuffer:24*1024*1024}
  );
  return parseAudioProblemMetrics(String(result.stderr||''));
}
