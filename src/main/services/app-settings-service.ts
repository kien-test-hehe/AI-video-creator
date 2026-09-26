import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMachineSettings } from '../../shared/types';
import { DEFAULT_APP_MACHINE_SETTINGS } from './machine-defaults';
import { assertLocalUrl } from './local-url';

const SETTINGS_FILE='machine-settings.v1.json',SETTINGS_BACKUP_FILE='machine-settings.v1.backup.json',JOURNAL_KEY_FILE='journal-hmac.key',BOOTSTRAP_SETTINGS_FILE='bootstrap-machine-settings.v1.json';

export class AppSettingsService {
  private current:AppMachineSettings=structuredClone(DEFAULT_APP_MACHINE_SETTINGS);
  private gate:Promise<void>=Promise.resolve();
  private journalKey!:Buffer;

  constructor(private readonly userDataDir:string){}

  async load():Promise<AppMachineSettings>{
    await mkdir(this.userDataDir,{recursive:true});
    this.journalKey=await this.loadOrCreateJournalKey();
    const file=join(this.userDataDir,SETTINGS_FILE),backup=join(this.userDataDir,SETTINGS_BACKUP_FILE);
    try{const raw=JSON.parse(await readFile(file,'utf8'));this.current=sanitizeMachineSettings(raw);}
    catch(primaryError:any){
      try{
        const raw=JSON.parse(await readFile(backup,'utf8'));this.current=sanitizeMachineSettings(raw);await copyFile(backup,file);
      }catch{
        const bootstrapped=await this.loadBootstrapSettings();
        this.current=bootstrapped??structuredClone(DEFAULT_APP_MACHINE_SETTINGS);
        if(primaryError?.code!=='ENOENT')console.warn('Machine settings could not be loaded; recovered bootstrap/default settings because no valid backup was available.',primaryError);
        await this.persistUnlocked(this.current);
      }
    }
    return this.get();
  }

  get():AppMachineSettings{return structuredClone(this.current);}
  getJournalKey():Buffer{return Buffer.from(this.journalKey);}

  private async loadBootstrapSettings():Promise<AppMachineSettings|undefined>{
    const candidates=[
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS,
      process.platform==='win32'&&process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'CineForge',BOOTSTRAP_SETTINGS_FILE):undefined
    ].filter((value):value is string=>Boolean(value));
    for(const path of candidates){
      try{return sanitizeMachineSettings(JSON.parse(await readFile(path,'utf8')));}
      catch(error:any){if(error?.code!=='ENOENT')console.warn(`Ignoring invalid CineForge bootstrap settings: ${path}`,error);}
    }
    return undefined;
  }

  async save(next:AppMachineSettings):Promise<AppMachineSettings>{return this.runExclusive(async()=>{const sanitized=sanitizeMachineSettings(next);await this.persistUnlocked(sanitized);return this.get();});}

  private async loadOrCreateJournalKey():Promise<Buffer>{
    const path=join(this.userDataDir,JOURNAL_KEY_FILE);
    try{
      const raw=(await readFile(path,'utf8')).trim();
      if(!/^[0-9a-fA-F]{64}$/.test(raw))throw new Error('Journal signing key is malformed.');
      return Buffer.from(raw,'hex');
    }catch(error:any){
      if(error?.code!=='ENOENT')throw new Error(`CineForge cannot safely recover render journals because the installation signing key is unreadable or invalid: ${error instanceof Error?error.message:String(error)}`);
    }
    const existingInstall=await Promise.all([SETTINGS_FILE,SETTINGS_BACKUP_FILE].map(async name=>{try{await readFile(join(this.userDataDir,name),'utf8');return true;}catch{return false;}})).then(values=>values.some(Boolean));
    if(existingInstall)throw new Error('CineForge render-journal signing key is missing on an existing installation. Restore journal-hmac.key or move aside the existing machine settings after confirming no local AI backend job is still running.');
    const key=randomBytes(32);await writeFile(path,key.toString('hex'),{encoding:'utf8',mode:0o600,flag:'wx'});return key;
  }

  private async persistUnlocked(value:AppMachineSettings):Promise<void>{
    const file=join(this.userDataDir,SETTINGS_FILE),backup=join(this.userDataDir,SETTINGS_BACKUP_FILE),temp=join(this.userDataDir,`.${SETTINGS_FILE}.${process.pid}.tmp`);
    const payload=JSON.stringify(value,null,2);
    try{await copyFile(file,backup);}catch(error:any){if(error?.code!=='ENOENT')throw new Error(`Could not create machine-settings backup before saving: ${error instanceof Error?error.message:String(error)}`);}
    await writeFile(temp,payload,'utf8');
    try{await rename(temp,file);}
    catch(error:any){
      if(!['EEXIST','EPERM','EACCES'].includes(error?.code)){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
      try{await writeFile(file,payload,'utf8');}finally{await rm(temp,{force:true}).catch(()=>undefined);}
    }
    this.current=structuredClone(value);
  }

  private async runExclusive<T>(operation:()=>Promise<T>):Promise<T>{const prior=this.gate;let release!:()=>void;this.gate=new Promise<void>(resolve=>{release=resolve;});await prior;try{return await operation();}finally{release();}}
}

function sanitizeMachineSettings(raw:any):AppMachineSettings{
  const defaults=structuredClone(DEFAULT_APP_MACHINE_SETTINGS),source=raw&&typeof raw==='object'?raw:{};
  const out:AppMachineSettings={
    schemaVersion:1,endpointPolicy:'loopback-only',
    ffmpeg:{path:preferBootstrapPath(source.ffmpeg?.path,defaults.ffmpeg.path,'ffmpeg'),ffprobePath:preferBootstrapPath(source.ffmpeg?.ffprobePath,defaults.ffmpeg.ffprobePath,'ffprobe'),preferredH264Encoder:source.ffmpeg?.preferredH264Encoder==='libx264'?'libx264':'h264_nvenc'},
    wangp:{executionMode:source.wangp?.executionMode==='docker'?'docker':'native',rootPath:asNonEmptyString(source.wangp?.rootPath,defaults.wangp.rootPath),pythonPath:preferBootstrapPath(source.wangp?.pythonPath,defaults.wangp.pythonPath,'python'),entrypoint:sanitizeLeaf(source.wangp?.entrypoint,defaults.wangp.entrypoint),profile:[1,2,3,4,5].includes(Number(source.wangp?.profile))?Number(source.wangp.profile) as 1|2|3|4|5:defaults.wangp.profile,attention:['auto','sdpa','flash','sage','sage2'].includes(source.wangp?.attention)?source.wangp.attention:defaults.wangp.attention,dryRunBeforeRender:source.wangp?.dryRunBeforeRender!==false,docker:{command:asNonEmptyString(source.wangp?.docker?.command,defaults.wangp.docker.command),image:asString(source.wangp?.docker?.image,''),projectMount:sanitizeContainerPath(source.wangp?.docker?.projectMount,defaults.wangp.docker.projectMount),wangpMount:sanitizeContainerPath(source.wangp?.docker?.wangpMount,defaults.wangp.docker.wangpMount)}},
    comfy:{url:asNonEmptyString(source.comfy?.url,defaults.comfy.url),inputDir:asString(source.comfy?.inputDir,defaults.comfy.inputDir),dedicatedInstance:source.comfy?.dedicatedInstance!==false},
    director:{baseUrl:asNonEmptyString(source.director?.baseUrl,defaults.director.baseUrl),model:asString(source.director?.model,defaults.director.model),temperature:clampNumber(source.director?.temperature,0,2,defaults.director.temperature)},
    diagnostics:{persistVerboseLogs:Boolean(source.diagnostics?.persistVerboseLogs)}
  };
  assertLocalUrl(out.comfy.url,true);assertLocalUrl(out.director.baseUrl,true);return out;
}
function preferBootstrapPath(value:unknown,bootstrap:string,generic:string):string{
  const current=typeof value==='string'?value.trim():'';
  const concreteBootstrap=bootstrap.trim()&&bootstrap.trim().toLowerCase()!==generic.toLowerCase();
  if(concreteBootstrap&&(!current||current.toLowerCase()===generic.toLowerCase()))return bootstrap.trim();
  return current||bootstrap;
}
function asString(value:unknown,fallback:string):string{return typeof value==='string'?value:fallback;}
function asNonEmptyString(value:unknown,fallback:string):string{return typeof value==='string'&&value.trim()?value.trim():fallback;}
function clampNumber(value:unknown,min:number,max:number,fallback:number):number{const num=Number(value);return Number.isFinite(num)?Math.min(max,Math.max(min,num)):fallback;}
function sanitizeLeaf(value:unknown,fallback:string):string{const text=asNonEmptyString(value,fallback);if(text.includes('/')||text.includes('\\')||text==='.'||text==='..')throw new Error('WanGP entrypoint must be a filename, not a path.');return text;}
function sanitizeContainerPath(value:unknown,fallback:string):string{const text=asNonEmptyString(value,fallback).replace(/\\/g,'/');if(!text.startsWith('/')||text.includes('/../')||text.endsWith('/..'))throw new Error('Container mount path must be an absolute normalized Unix path.');return text.replace(/\/+$/,'')||'/';}
