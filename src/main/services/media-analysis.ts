import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings } from '../../shared/types';

const execFileAsync=promisify(execFile);

export interface SampledVideoFrames { durationSec:number; firstFrame:string; finalFrame:string; contactFrames:string[]; }

export async function probeVideoDuration(machine:AppMachineSettings,input:string):Promise<number>{
  const{stdout}=await execFileAsync(machine.ffmpeg.ffprobePath,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',input],{timeout:30_000,maxBuffer:1024*1024});
  const duration=Number(stdout.trim());
  if(!Number.isFinite(duration)||duration<=0)throw new Error('Could not determine rendered video duration for frame analysis.');
  return duration;
}

export async function extractVideoFrame(machine:AppMachineSettings,input:string,output:string,timeSec:number):Promise<string>{
  await mkdir(dirname(output),{recursive:true});
  await rm(output,{force:true}).catch(()=>undefined);
  const args=['-hide_banner','-loglevel','error','-y','-ss',Math.max(0,timeSec).toFixed(3),'-i',input,'-frames:v','1','-q:v','2',output];
  await execFileAsync(machine.ffmpeg.path,args,{timeout:60_000,maxBuffer:4*1024*1024});
  return output;
}

export async function sampleVideoFrames(machine:AppMachineSettings,input:string,outputDir:string):Promise<SampledVideoFrames>{
  const durationSec=await probeVideoDuration(machine,input);
  await mkdir(outputDir,{recursive:true});
  const safeEnd=Math.max(0.01,durationSec-Math.min(0.28,Math.max(0.08,durationSec*0.04)));
  const firstFrame=join(outputDir,'first.jpg'),finalFrame=join(outputDir,'final-stable.jpg');
  await extractVideoFrame(machine,input,firstFrame,Math.min(0.06,Math.max(0,durationSec*0.01)));
  await extractVideoFrame(machine,input,finalFrame,safeEnd);
  const fractions=durationSec<1?[0.2,0.55,0.85]:[0.08,0.35,0.65,0.9];
  const contactFrames:string[]=[];
  for(let index=0;index<fractions.length;index++){
    const path=join(outputDir,`sample-${index+1}.jpg`);
    await extractVideoFrame(machine,input,path,Math.min(safeEnd,Math.max(0.01,durationSec*fractions[index])));
    contactFrames.push(path);
  }
  return{durationSec,firstFrame,finalFrame,contactFrames};
}
