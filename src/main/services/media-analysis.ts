import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings } from '../../shared/types';

const execFileAsync=promisify(execFile);

export interface SampledVideoFrames { durationSec:number; firstFrame:string; finalFrame:string; finalCandidates:string[]; contactFrames:string[]; }

export async function probeVideoDuration(machine:AppMachineSettings,input:string):Promise<number>{
  const{stdout}=await execFileAsync(machine.ffmpeg.ffprobePath,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',input],{timeout:30_000,maxBuffer:1024*1024});
  const duration=Number(stdout.trim());
  if(!Number.isFinite(duration)||duration<=0)throw new Error('Could not determine rendered video duration for frame analysis.');
  return duration;
}

export function videoFrameExtractionArgs(input:string,output:string,timeSec:number):string[]{
  const time=Math.max(0,timeSec);
  const args=['-hide_banner','-loglevel','error','-y','-i',input];
  if(time>0)args.push('-ss',time.toFixed(3));
  args.push('-frames:v','1','-q:v','2',output);
  return args;
}

export async function extractVideoFrame(machine:AppMachineSettings,input:string,output:string,timeSec:number):Promise<string>{
  await mkdir(dirname(output),{recursive:true});
  await rm(output,{force:true}).catch(()=>undefined);
  await execFileAsync(machine.ffmpeg.path,videoFrameExtractionArgs(input,output,timeSec),{timeout:60_000,maxBuffer:4*1024*1024});
  return output;
}

export async function sampleVideoFrames(machine:AppMachineSettings,input:string,outputDir:string):Promise<SampledVideoFrames>{
  const durationSec=await probeVideoDuration(machine,input);
  await mkdir(outputDir,{recursive:true});
  const safeEnd=Math.max(0.01,durationSec-Math.min(0.08,Math.max(0.03,durationSec*0.01)));
  const firstFrame=join(outputDir,'first.jpg');
  await extractVideoFrame(machine,input,firstFrame,0);
  const offsets=durationSec<1?[0.28,0.16,0.08,0.03]:[0.65,0.4,0.2,0.08];
  const finalCandidates:string[]=[];
  for(let index=0;index<offsets.length;index++){
    const path=join(outputDir,`final-candidate-${index+1}.jpg`);
    await extractVideoFrame(machine,input,path,Math.max(0.01,Math.min(safeEnd,durationSec-offsets[index])));
    finalCandidates.push(path);
  }
  const finalFrame=finalCandidates[Math.max(0,finalCandidates.length-2)]||firstFrame;
  const fractions=durationSec<1?[0.2,0.55,0.85]:[0.08,0.35,0.65,0.9];
  const contactFrames:string[]=[];
  for(let index=0;index<fractions.length;index++){
    const path=join(outputDir,`sample-${index+1}.jpg`);
    await extractVideoFrame(machine,input,path,Math.min(safeEnd,Math.max(0.01,durationSec*fractions[index])));
    contactFrames.push(path);
  }
  return{durationSec,firstFrame,finalFrame,finalCandidates,contactFrames};
}
