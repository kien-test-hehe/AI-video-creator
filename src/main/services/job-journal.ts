import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RenderJob } from '../../shared/types';
import { assertExistingPathInside, assertSafeWritePath } from './path-safety';

interface JournalEnvelope{version:1;job:RenderJob;mac:string}

export class JobJournal {
  private gates=new Map<string,Promise<void>>();
  constructor(private readonly key:Buffer){}

  async write(projectRoot:string,job:RenderJob):Promise<void>{
    const previous=this.gates.get(job.id)??Promise.resolve();let release!:()=>void;const latch=new Promise<void>(resolve=>{release=resolve;});const chained=previous.then(()=>latch);this.gates.set(job.id,chained);await previous;
    try{
      const candidate=join(projectRoot,'.cineforge','jobs'),safeDir=await assertSafeWritePath(projectRoot,candidate,'job journal directory');await mkdir(safeDir,{recursive:true});
      const dir=await assertExistingPathInside(projectRoot,safeDir,'job journal directory');
      const file=await assertSafeWritePath(dir,join(dir,`${job.id}.json`),'job journal'),temp=`${file}.${process.pid}.${Date.now()}.tmp`;
      const envelope:JournalEnvelope={version:1,job:structuredClone(job),mac:sign(this.key,job)};
      await writeFile(temp,JSON.stringify(envelope,null,2),'utf8');
      try{await rename(temp,file);}catch(error:any){if(!['EEXIST','EPERM','EACCES'].includes(error?.code))throw error;await writeFile(file,JSON.stringify(envelope,null,2),'utf8');await rm(temp,{force:true}).catch(()=>undefined);}
    }finally{release();if(this.gates.get(job.id)===chained)this.gates.delete(job.id);}
  }

  async readAll(projectRoot:string,jobIds:Iterable<string>):Promise<RenderJob[]>{
    const candidate=join(projectRoot,'.cineforge','jobs'),jobs:RenderJob[]=[];let dir:string;
    try{dir=await assertExistingPathInside(projectRoot,candidate,'job journal directory');}
    catch(error:any){if(error?.code==='ENOENT')return[];throw error;}
    for(const id of new Set(jobIds)){
      try{
        const file=await assertExistingPathInside(dir,join(dir,`${id}.json`),'job journal');
        const info=await stat(file);if(info.size>5*1024*1024)continue;
        const envelope=JSON.parse(await readFile(file,'utf8')) as JournalEnvelope;
        if(envelope?.version!==1||!envelope.job||envelope.job.id!==id||typeof envelope.mac!=='string')continue;
        const expected=Buffer.from(sign(this.key,envelope.job),'hex'),actual=Buffer.from(envelope.mac,'hex');
        if(expected.length!==actual.length||!timingSafeEqual(expected,actual))continue;
        jobs.push(envelope.job);
      }catch{}
    }
    return jobs;
  }
}

function sign(key:Buffer,job:RenderJob):string{return createHmac('sha256',key).update(JSON.stringify(job)).digest('hex');}
