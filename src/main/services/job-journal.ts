import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RenderJob } from '../../shared/types';
import { assertSafeWritePath } from './path-safety';

interface JournalEnvelope{version:1;job:RenderJob;mac:string}

export class JobJournal {
  private gates=new Map<string,Promise<void>>();
  constructor(private readonly key:Buffer){}

  async write(projectRoot:string,job:RenderJob):Promise<void>{
    const previous=this.gates.get(job.id)??Promise.resolve();let release!:()=>void;const latch=new Promise<void>(resolve=>{release=resolve;});const chained=previous.then(()=>latch);this.gates.set(job.id,chained);await previous;
    try{
      const dir=join(projectRoot,'.cineforge','jobs');await mkdir(dir,{recursive:true});
      const file=await assertSafeWritePath(dir,join(dir,`${job.id}.json`),'job journal'),temp=`${file}.${process.pid}.${Date.now()}.tmp`;
      const envelope:JournalEnvelope={version:1,job:structuredClone(job),mac:sign(this.key,job)};
      await writeFile(temp,JSON.stringify(envelope,null,2),'utf8');
      try{await rename(temp,file);}catch(error:any){if(!['EEXIST','EPERM','EACCES'].includes(error?.code))throw error;await writeFile(file,JSON.stringify(envelope,null,2),'utf8');await rm(temp,{force:true}).catch(()=>undefined);}
    }finally{release();if(this.gates.get(job.id)===chained)this.gates.delete(job.id);}
  }

  async readAll(projectRoot:string):Promise<RenderJob[]>{
    const dir=join(projectRoot,'.cineforge','jobs');let files:string[];
    try{files=(await readdir(dir)).filter(name=>name.endsWith('.json'));}catch{return[];}
    const jobs:RenderJob[]=[];
    for(const name of files){
      try{
        const envelope=JSON.parse(await readFile(join(dir,name),'utf8')) as JournalEnvelope;
        if(envelope?.version!==1||!envelope.job||typeof envelope.mac!=='string')continue;
        const expected=Buffer.from(sign(this.key,envelope.job),'hex'),actual=Buffer.from(envelope.mac,'hex');
        if(expected.length!==actual.length||!timingSafeEqual(expected,actual))continue;
        jobs.push(envelope.job);
      }catch{}
    }
    return jobs;
  }
}

function sign(key:Buffer,job:RenderJob):string{return createHmac('sha256',key).update(JSON.stringify(job)).digest('hex');}
