import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AppMachineSettings, FilmProject, TimelineClip } from '../../shared/types';
import { assertExistingPathInside, assertSafeWritePath } from './path-safety';
import { isProcessAlive, killProcessTree } from './process-utils';
import { duplicateTimelineOrderKey, timelineOutputIssue } from '../../shared/timeline-policy';

interface ProbeInfo{width:number;height:number;fps:number;hasAudio:boolean;durationSec?:number}

export async function exportTimeline(project:FilmProject,machine:AppMachineSettings,signal?:AbortSignal):Promise<string>{
  throwIfAborted(signal);
  const clips=[...project.timeline].sort((a,b)=>a.track-b.track||a.order-b.order);
  if(clips.length===0)throw new Error('Timeline is empty. Add rendered shots first.');
  if(new Set(clips.map(c=>c.track)).size>1)throw new Error('Multi-track compositing is not enabled in the local master exporter. Use the CapCut handoff for multi-track finishing.');
  const duplicateOrder=duplicateTimelineOrderKey(clips);if(duplicateOrder)throw new Error(`Duplicate timeline order detected at ${duplicateOrder}.`);

  const sources=[];
  for(const clip of clips){
    const output=project.renderOutputs.find(o=>o.id===clip.renderOutputId);
    const issue=timelineOutputIssue(clip,output);if(issue||!output)throw new Error(issue||`Timeline clip ${clip.id} does not reference a valid video output.`);
    const path=await assertExistingPathInside(join(project.rootPath,'renders'),output.path,`timeline source ${output.filename}`);
    sources.push({clip,path});
  }

  const first=await probeVideo(machine.ffmpeg.ffprobePath,sources[0].path,signal);
  const master={...first,fps:Math.max(1,project.settings.defaultFps||first.fps)};
  const h264Encoder=await chooseH264Encoder(machine,signal);
  const cacheDir=join(project.rootPath,'cache',`export-${randomUUID()}`);
  const exportDir=join(project.rootPath,'exports');
  await Promise.all([mkdir(cacheDir,{recursive:true}),mkdir(exportDir,{recursive:true})]);
  try{
    const normalized:string[]=[];
    for(let i=0;i<sources.length;i++){
      const target=await assertSafeWritePath(cacheDir,join(cacheDir,`${String(i).padStart(4,'0')}.mp4`),'normalized export clip');
      throwIfAborted(signal);
      const info=await probeVideo(machine.ffmpeg.ffprobePath,sources[i].path,signal);
      await normalizeClip(machine,sources[i].path,target,sources[i].clip,info,master,h264Encoder,signal);
      normalized.push(target);
    }
    const listPath=join(cacheDir,'concat.txt');
    await writeFile(listPath,normalized.map(ffmpegConcatFileLine).join('\n'),'utf8');
    const safeName=project.name.replace(/[^a-zA-Z0-9_-]+/g,'_')||'cineforge';
    const outputPath=await assertSafeWritePath(exportDir,join(exportDir,`${safeName}-${Date.now()}.${project.settings.outputContainer}`),'master export');

    if(project.settings.outputContainer==='webm'){
      await run(machine.ffmpeg.path,['-y','-f','concat','-safe','0','-i',listPath,'-c:v','libvpx-vp9','-crf','18','-b:v','0','-c:a','libopus','-b:a','192k',outputPath],60*60_000,signal);
    }else{
      await run(machine.ffmpeg.path,['-y','-f','concat','-safe','0','-i',listPath,'-c','copy','-movflags','+faststart',outputPath],60*60_000,signal);
    }
    return outputPath;
  }finally{
    await rm(cacheDir,{recursive:true,force:true}).catch(()=>undefined);
  }
}

async function normalizeClip(machine:AppMachineSettings,input:string,output:string,clip:TimelineClip,info:ProbeInfo,master:ProbeInfo,h264Encoder:'h264_nvenc'|'libx264',signal?:AbortSignal):Promise<void>{
  throwIfAborted(signal);
  if(clip.trimOutSec!=null&&clip.trimOutSec<=clip.trimInSec)throw new Error(`Invalid timeline trim: out (${clip.trimOutSec}s) must be greater than in (${clip.trimInSec}s).`);
  if(info.durationSec!=null&&clip.trimInSec>=info.durationSec)throw new Error(`Invalid timeline trim: in (${clip.trimInSec}s) is beyond media duration (${info.durationSec.toFixed(3)}s).`);
  if(info.durationSec!=null&&clip.trimOutSec!=null&&clip.trimOutSec>info.durationSec+0.02)throw new Error(`Invalid timeline trim: out (${clip.trimOutSec}s) exceeds media duration (${info.durationSec.toFixed(3)}s).`);
  if(!Number.isFinite(clip.volume)||clip.volume<0)throw new Error(`Invalid timeline volume: ${clip.volume}`);
  const args:string[]=['-y'];
  if(clip.trimInSec>0)args.push('-ss',String(clip.trimInSec));
  args.push('-i',input);
  const duration=clip.trimOutSec!=null?clip.trimOutSec-clip.trimInSec:undefined;
  if(duration!=null&&duration>0)args.push('-t',String(duration));
  if(!info.hasAudio)args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');
  const vf=`scale=${master.width}:${master.height}:force_original_aspect_ratio=decrease,pad=${master.width}:${master.height}:(ow-iw)/2:(oh-ih)/2,fps=${master.fps}`;
  args.push('-vf',vf);
  if(h264Encoder==='h264_nvenc')args.push('-c:v','h264_nvenc','-preset','p6','-cq','16','-b:v','0');
  else args.push('-c:v','libx264','-preset','medium','-crf','16');
  args.push('-pix_fmt','yuv420p');
  if(info.hasAudio)args.push('-af',`volume=${Math.max(0,clip.volume)}`);
  else args.push('-shortest');
  args.push('-c:a','aac','-b:a','256k','-ar','48000','-ac','2',output);
  await run(machine.ffmpeg.path,args,60*60_000,signal);
}

async function chooseH264Encoder(machine:AppMachineSettings,signal?:AbortSignal):Promise<'h264_nvenc'|'libx264'>{
  const text=await runCapture(machine.ffmpeg.path,['-hide_banner','-encoders'],30_000,signal);
  const hasNvenc=/\bh264_nvenc\b/.test(text),hasX264=/\blibx264\b/.test(text);
  if(machine.ffmpeg.preferredH264Encoder==='h264_nvenc'&&hasNvenc)return'h264_nvenc';
  if(machine.ffmpeg.preferredH264Encoder==='libx264'&&hasX264)return'libx264';
  if(hasX264)return'libx264';
  if(hasNvenc)return'h264_nvenc';
  throw new Error('FFmpeg exposes neither h264_nvenc nor libx264; CineForge cannot normalize timeline clips.');
}

async function probeVideo(ffprobe:string,input:string,signal?:AbortSignal):Promise<ProbeInfo>{
  const stdout=await runCapture(ffprobe,['-v','error','-print_format','json','-show_streams','-show_format',input],60_000,signal);
  const parsed=JSON.parse(stdout) as{streams?:any[];format?:{duration?:string|number}};const video=parsed.streams?.find(s=>s.codec_type==='video');if(!video)throw new Error(`No video stream found: ${input}`);
  const rate=String(video.avg_frame_rate||video.r_frame_rate||'24/1').split('/').map(Number);const fps=rate[1]?rate[0]/rate[1]:rate[0]||24;
  const rawDuration=Number(video.duration??parsed.format?.duration),durationSec=Number.isFinite(rawDuration)&&rawDuration>0?rawDuration:undefined;
  return{width:Number(video.width)||1280,height:Number(video.height)||720,fps:Math.max(1,Math.round(fps*1000)/1000),hasAudio:Boolean(parsed.streams?.some(s=>s.codec_type==='audio')),durationSec};
}

const PROCESS_LOG_TAIL_CHARS=512*1024,PROCESS_CAPTURE_BYTES=16*1024*1024;
function appendTail(current:string,chunk:Buffer|string,maxChars=PROCESS_LOG_TAIL_CHARS):string{
  const next=current+(Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk));
  return next.length>maxChars?next.slice(-maxChars):next;
}
function run(command:string,args:string[],timeoutMs=60*60_000,signal?:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});
    let stderr='',settled=false,stopping=false,stopReason:Error|undefined;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);error?reject(error):resolve();};
    const stop=async(reason:Error)=>{if(stopping||settled)return;stopping=true;stopReason=reason;if(!child.pid)return finish(reason);while(!settled&&isProcessAlive(child.pid)){try{await killProcessTree(child.pid);}catch(error){stderr=appendTail(stderr,`\nProcess stop confirmation failed; retrying: ${error instanceof Error?error.message:String(error)}`);await new Promise(resolve=>setTimeout(resolve,2000));}}if(!settled)finish(reason);};
    const onAbort=()=>{void stop(new Error('Timeline export cancelled.'));};
    const timer=setTimeout(()=>{void stop(new Error('FFmpeg timed out.'));},timeoutMs);timer.unref();
    child.stderr?.on('data',d=>{stderr=appendTail(stderr,d);});
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted){onAbort();return;}
    child.on('error',error=>finish(error));child.on('close',code=>stopping?finish(stopReason??new Error('FFmpeg stopped.')):code===0?finish():finish(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`)));
  });
}
function runCapture(command:string,args:string[],timeoutMs:number,signal?:AbortSignal):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    const stdoutChunks:Buffer[]=[];let stdoutBytes=0,stderr='',settled=false,stopping=false,stopReason:Error|undefined,captureExceeded=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);error?reject(error):resolve(Buffer.concat(stdoutChunks,stdoutBytes).toString('utf8'));};
    const stop=async(reason:Error)=>{if(stopping||settled)return;stopping=true;stopReason=reason;if(!child.pid)return finish(reason);while(!settled&&isProcessAlive(child.pid)){try{await killProcessTree(child.pid);}catch(error){stderr=appendTail(stderr,`\nProcess stop confirmation failed; retrying: ${error instanceof Error?error.message:String(error)}`);await new Promise(resolve=>setTimeout(resolve,2000));}}if(!settled)finish(reason);};
    const onAbort=()=>{void stop(new Error('Timeline export cancelled.'));};
    const timer=setTimeout(()=>{void stop(new Error('FFprobe timed out.'));},timeoutMs);timer.unref();
    child.stdout?.on('data',(data:Buffer)=>{if(captureExceeded)return;stdoutBytes+=data.length;if(stdoutBytes>PROCESS_CAPTURE_BYTES){captureExceeded=true;void stop(new Error(`${command} output exceeded the ${PROCESS_CAPTURE_BYTES}-byte safety limit.`));return;}stdoutChunks.push(Buffer.from(data));});
    child.stderr?.on('data',d=>{stderr=appendTail(stderr,d);});
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted){onAbort();return;}
    child.on('error',error=>finish(error));child.on('close',code=>captureExceeded?finish(stopReason??new Error(`${command} output exceeded the capture safety limit.`)):stopping?finish(stopReason??new Error('FFprobe stopped.')):code===0?finish():finish(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}
export function ffmpegConcatFileLine(path:string):string{
  return `file '${path.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`;
}

function throwIfAborted(signal?:AbortSignal):void{if(signal?.aborted)throw new Error('Timeline export cancelled.');}
