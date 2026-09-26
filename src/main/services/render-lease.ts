import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LEASE_FILE='active-render.v1.json';

export interface RenderLease{
  version:1;
  projectId:string;
  projectRoot:string;
  jobId:string;
  createdAt:string;
}

interface LeaseEnvelope{version:1;lease:RenderLease;mac:string}

export class RenderLeaseStore{
  constructor(private readonly userDataDir:string,private readonly key:Buffer){}

  async write(lease:RenderLease):Promise<void>{
    await mkdir(this.userDataDir,{recursive:true});
    const file=join(this.userDataDir,LEASE_FILE),temp=`${file}.${process.pid}.${Date.now()}.tmp`;
    const envelope:LeaseEnvelope={version:1,lease:structuredClone(lease),mac:sign(this.key,lease)};
    await writeFile(temp,JSON.stringify(envelope,null,2),'utf8');
    try{await rename(temp,file);}
    catch(error:any){
      if(!['EEXIST','EPERM','EACCES'].includes(error?.code)){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
      try{await writeFile(file,JSON.stringify(envelope,null,2),'utf8');}
      finally{await rm(temp,{force:true}).catch(()=>undefined);}
    }
  }

  async read():Promise<RenderLease|undefined>{
    const file=join(this.userDataDir,LEASE_FILE);let info;
    try{info=await stat(file);}catch(error:any){if(error?.code==='ENOENT')return undefined;throw error;}
    if(info.size>64*1024)throw new Error('Active render recovery lease exceeds the safety limit.');
    const envelope=JSON.parse(await readFile(file,'utf8')) as LeaseEnvelope;
    if(envelope?.version!==1||envelope.lease?.version!==1||typeof envelope.mac!=='string')throw new Error('Active render recovery lease is malformed.');
    const expected=Buffer.from(sign(this.key,envelope.lease),'hex'),actual=Buffer.from(envelope.mac,'hex');
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Active render recovery lease failed its installation signature check.');
    if(!envelope.lease.projectId||!envelope.lease.projectRoot||!envelope.lease.jobId)throw new Error('Active render recovery lease is incomplete.');
    return structuredClone(envelope.lease);
  }

  async clearIfJob(jobId:string):Promise<void>{
    const lease=await this.read();if(!lease||lease.jobId!==jobId)return;
    await rm(join(this.userDataDir,LEASE_FILE),{force:true});
  }

  async clear():Promise<void>{await rm(join(this.userDataDir,LEASE_FILE),{force:true});}
}

function sign(key:Buffer,lease:RenderLease):string{return createHmac('sha256',key).update(JSON.stringify(lease)).digest('hex');}
