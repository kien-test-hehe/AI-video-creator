import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppMachineSettings } from '../../shared/types';
import { DEFAULT_APP_MACHINE_SETTINGS } from './machine-defaults';
import { assertLocalUrl } from './local-url';
import { readJsonFileLimited } from './json-file';

const SETTINGS_FILE='machine-settings.v1.json',SETTINGS_BACKUP_FILE='machine-settings.v1.backup.json',JOURNAL_KEY_FILE='journal-hmac.key',BOOTSTRAP_SETTINGS_FILE='bootstrap-machine-settings.v1.json';

class UnsupportedMachineSettingsSchemaError extends Error {}

export class AppSettingsService {
  private current:AppMachineSettings=structuredClone(DEFAULT_APP_MACHINE_SETTINGS);
  private gate:Promise<void>=Promise.resolve();
  private journalKey!:Buffer;

  constructor(private readonly userDataDir:string){}

  async load():Promise<AppMachineSettings>{
    await mkdir(this.userDataDir,{recursive:true});
    this.journalKey=await this.loadOrCreateJournalKey();
    const file=join(this.userDataDir,SETTINGS_FILE),backup=join(this.userDataDir,SETTINGS_BACKUP_FILE);
    await this.assertStateFileNotSymlink(file,'CineForge machine settings');
    await this.assertStateFileNotSymlink(backup,'CineForge machine-settings backup');
    try{const raw=await readJsonFileLimited(file,'CineForge machine settings',4*1024*1024);this.current=sanitizeMachineSettings(raw);}
    catch(primaryError:any){
      if(primaryError instanceof UnsupportedMachineSettingsSchemaError)throw primaryError;
      try{
        const raw=await readJsonFileLimited(backup,'CineForge machine-settings backup',4*1024*1024);this.current=sanitizeMachineSettings(raw);
        await this.preserveRejectedSettings(file);
        await copyFile(backup,file);
      }catch(backupError:any){
        if(primaryError?.code!=='ENOENT'||backupError?.code!=='ENOENT'){
          throw new Error(`CineForge machine settings could not be recovered without risking data loss. Primary: ${primaryError instanceof Error?primaryError.message:String(primaryError)}. Backup: ${backupError instanceof Error?backupError.message:String(backupError)}`);
        }
        const bootstrapped=await this.loadBootstrapSettings();
        this.current=bootstrapped??structuredClone(DEFAULT_APP_MACHINE_SETTINGS);
        await this.persistUnlocked(this.current);
      }
    }
    return this.get();
  }

  get():AppMachineSettings{return structuredClone(this.current);}
  getJournalKey():Buffer{return Buffer.from(this.journalKey);}

  private async assertStateFileNotSymlink(path:string,label:string):Promise<void>{
    try{
      const info=await lstat(path);
      if(info.isSymbolicLink())throw new Error(`${label} must not be a symbolic link.`);
      if(!info.isFile())throw new Error(`${label} is not a regular file.`);
    }catch(error:any){if(error?.code!=='ENOENT')throw error;}
  }

  private async loadBootstrapSettings():Promise<AppMachineSettings|undefined>{
    const candidates=[
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS,
      process.platform==='win32'&&process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'CineForge',BOOTSTRAP_SETTINGS_FILE):undefined
    ].filter((value):value is string=>Boolean(value));
    for(const path of candidates){
      try{return sanitizeMachineSettings(await readJsonFileLimited(path,'CineForge bootstrap machine settings',4*1024*1024));}
      catch(error:any){
        if(error?.code==='ENOENT')continue;
        throw new Error(`CineForge bootstrap settings are present but invalid or unreadable: ${path}: ${error instanceof Error?error.message:String(error)}`);
      }
    }
    return undefined;
  }

  async save(next:AppMachineSettings):Promise<AppMachineSettings>{return this.runExclusive(async()=>{const sanitized=sanitizeMachineSettings(next);await this.persistUnlocked(sanitized);return this.get();});}

  private async preserveRejectedSettings(file:string):Promise<string|undefined>{
    try{
      const info=await lstat(file);
      if(info.isSymbolicLink())throw new Error('Rejected CineForge machine settings must not be a symbolic link.');
      if(!info.isFile())throw new Error('Rejected CineForge machine settings are not a regular file.');
    }catch(error:any){if(error?.code==='ENOENT')return undefined;throw error;}
    const target=join(this.userDataDir,`machine-settings.v1.rejected-${Date.now()}-${randomUUID()}.json`);
    try{await copyFile(file,target);return target;}
    catch(error){throw new Error(`CineForge found a usable machine-settings backup but refused to overwrite the rejected primary because preserving it failed: ${error instanceof Error?error.message:String(error)}`);}
  }

  private async loadOrCreateJournalKey():Promise<Buffer>{
    const path=join(this.userDataDir,JOURNAL_KEY_FILE);
    try{
      const info=await lstat(path);
      if(info.isSymbolicLink())throw new Error('Journal signing key must not be a symbolic link.');
      if(!info.isFile())throw new Error('Journal signing key is not a regular file.');
      if(info.size>4096)throw new Error('Journal signing key file exceeds the safety limit.');
      const raw=(await readFile(path,'utf8')).trim();
      if(!/^[0-9a-fA-F]{64}$/.test(raw))throw new Error('Journal signing key is malformed.');
      return Buffer.from(raw,'hex');
    }catch(error:any){
      if(error?.code!=='ENOENT')throw new Error(`CineForge cannot safely recover render journals because the installation signing key is unreadable or invalid: ${error instanceof Error?error.message:String(error)}`);
    }
    const existingInstall=await Promise.all([SETTINGS_FILE,SETTINGS_BACKUP_FILE].map(async name=>{
      try{
        const info=await lstat(join(this.userDataDir,name));
        if(info.isSymbolicLink())throw new Error(`${name} must not be a symbolic link.`);
        return true;
      }catch(error:any){if(error?.code==='ENOENT')return false;throw new Error(`Could not verify whether existing CineForge settings are present before creating a new journal signing key: ${error instanceof Error?error.message:String(error)}`);}
    })).then(values=>values.some(Boolean));
    if(existingInstall)throw new Error('CineForge render-journal signing key is missing on an existing installation. Restore journal-hmac.key or move aside the existing machine settings after confirming no local AI backend job is still running.');
    const key=randomBytes(32);await writeFile(path,key.toString('hex'),{encoding:'utf8',mode:0o600,flag:'wx'});return key;
  }

  private async persistUnlocked(value:AppMachineSettings):Promise<void>{
    const file=join(this.userDataDir,SETTINGS_FILE),backup=join(this.userDataDir,SETTINGS_BACKUP_FILE),temp=join(this.userDataDir,`.${SETTINGS_FILE}.${randomUUID()}.tmp`);
    await this.assertStateFileNotSymlink(file,'CineForge machine settings');
    await this.assertStateFileNotSymlink(backup,'CineForge machine-settings backup');
    const payload=JSON.stringify(value,null,2);
    const previousPayload=JSON.stringify(this.current,null,2);
    try{await writeFile(backup,previousPayload,{encoding:'utf8',mode:0o600});}
    catch(error){throw new Error(`Could not create trusted machine-settings backup before saving: ${error instanceof Error?error.message:String(error)}`);}
    await writeFile(temp,payload,{encoding:'utf8',flag:'wx',mode:0o600});
    try{await rename(temp,file);}
    catch(error:any){
      if(!['EEXIST','EPERM','EACCES'].includes(error?.code)){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
      try{await this.assertStateFileNotSymlink(file,'CineForge machine settings');await writeFile(file,payload,'utf8');}finally{await rm(temp,{force:true}).catch(()=>undefined);}
    }
    this.current=structuredClone(value);
  }

  private async runExclusive<T>(operation:()=>Promise<T>):Promise<T>{const prior=this.gate;let release!:()=>void;this.gate=new Promise<void>(resolve=>{release=resolve;});await prior;try{return await operation();}finally{release();}}
}

function sanitizeMachineSettings(raw:any):AppMachineSettings{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Machine settings must be a JSON object.');
  const defaults=structuredClone(DEFAULT_APP_MACHINE_SETTINGS),source=raw;
  if(source.schemaVersion!=null&&source.schemaVersion!==1)throw new UnsupportedMachineSettingsSchemaError(`Unsupported machine settings schema: ${String(source.schemaVersion)}`);
  const out:AppMachineSettings={
    schemaVersion:1,endpointPolicy:'loopback-only',
    ffmpeg:{path:preferBootstrapPath(source.ffmpeg?.path,defaults.ffmpeg.path,'ffmpeg'),ffprobePath:preferBootstrapPath(source.ffmpeg?.ffprobePath,defaults.ffmpeg.ffprobePath,'ffprobe'),preferredH264Encoder:source.ffmpeg?.preferredH264Encoder==='libx264'?'libx264':'h264_nvenc'},
    wangp:{executionMode:source.wangp?.executionMode==='docker'?'docker':'native',rootPath:asNonEmptyString(source.wangp?.rootPath,defaults.wangp.rootPath),pythonPath:preferBootstrapPath(source.wangp?.pythonPath,defaults.wangp.pythonPath,'python'),entrypoint:sanitizeLeaf(source.wangp?.entrypoint,defaults.wangp.entrypoint),profile:[1,2,3,4,5].includes(Number(source.wangp?.profile))?Number(source.wangp.profile) as 1|2|3|4|5:defaults.wangp.profile,attention:['auto','sdpa','flash','sage','sage2'].includes(source.wangp?.attention)?source.wangp.attention:defaults.wangp.attention,dryRunBeforeRender:typeof source.wangp?.dryRunBeforeRender==='boolean'?source.wangp.dryRunBeforeRender:defaults.wangp.dryRunBeforeRender,docker:{command:asNonEmptyString(source.wangp?.docker?.command,defaults.wangp.docker.command),image:sanitizeDockerImageRef(source.wangp?.docker?.image,''),projectMount:sanitizeContainerPath(source.wangp?.docker?.projectMount,defaults.wangp.docker.projectMount),wangpMount:sanitizeContainerPath(source.wangp?.docker?.wangpMount,defaults.wangp.docker.wangpMount)}},
    comfy:{url:asNonEmptyString(source.comfy?.url,defaults.comfy.url),inputDir:asString(source.comfy?.inputDir,defaults.comfy.inputDir),dedicatedInstance:typeof source.comfy?.dedicatedInstance==='boolean'?source.comfy.dedicatedInstance:defaults.comfy.dedicatedInstance},
    director:{baseUrl:asNonEmptyString(source.director?.baseUrl,defaults.director.baseUrl),model:asString(source.director?.model,defaults.director.model),temperature:clampNumber(source.director?.temperature,0,2,defaults.director.temperature)},
    diagnostics:{persistVerboseLogs:source.diagnostics?.persistVerboseLogs===true}
  };
  assertLocalUrl(out.comfy.url,true);assertLocalUrl(out.director.baseUrl,true);return out;
}
function preferBootstrapPath(value:unknown,bootstrap:string,generic:string):string{
  const current=typeof value==='string'?value.trim():'',bootstrapValue=bootstrap.trim();
  const concreteBootstrap=bootstrapValue&&bootstrapValue.toLowerCase()!==generic.toLowerCase();
  return boundedMachineString(concreteBootstrap&&(!current||current.toLowerCase()===generic.toLowerCase())?bootstrapValue:(current||bootstrap),4096);
}
function boundedMachineString(value:string,max=4096):string{if(value.length>max)throw new Error(`Machine setting string exceeds the ${max}-character safety limit.`);return value;}
function asString(value:unknown,fallback:string):string{return boundedMachineString(typeof value==='string'?value:fallback);}
function asNonEmptyString(value:unknown,fallback:string):string{const text=typeof value==='string'&&value.trim()?value.trim():fallback;return boundedMachineString(text);}
function clampNumber(value:unknown,min:number,max:number,fallback:number):number{const num=Number(value);return Number.isFinite(num)?Math.min(max,Math.max(min,num)):fallback;}
function sanitizeDockerImageRef(value:unknown,fallback:string):string{const text=asString(value,fallback).trim();if(!text)return'';if(text.length>1024)throw new Error('WanGP Docker image reference exceeds the 1024-character machine-settings safety limit.');if(text.startsWith('-')||/\s|[\u0000-\u001f\u007f]/.test(text))throw new Error('WanGP Docker image must be a single image reference, not a Docker CLI option.');return text;}
function sanitizeLeaf(value:unknown,fallback:string):string{const text=asNonEmptyString(value,fallback);if(text.includes('/')||text.includes('\\')||text==='.'||text==='..')throw new Error('WanGP entrypoint must be a filename, not a path.');return text;}
function sanitizeContainerPath(value:unknown,fallback:string):string{const text=asNonEmptyString(value,fallback).replace(/\\/g,'/');if(!text.startsWith('/')||text.includes('/../')||text.endsWith('/..')||text.includes(':')||/[\u0000-\u001f\u007f]/.test(text))throw new Error('Container mount path must be an absolute normalized Unix path without Docker volume-option delimiters.');return text.replace(/\/+$/,'')||'/';}

