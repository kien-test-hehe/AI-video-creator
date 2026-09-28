import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutomationStatus, FilmProject } from '../../shared/types';
import { readJsonFileLimited, stringifyJsonLimited } from './json-file';
import { assertExistingPathInside, assertSafeWritePath, ensureSafeDirectory } from './path-safety';

const FILE='automation-run.v1.json';

export interface AutomationRunJournal{
  schemaVersion:1;
  projectId:string;
  projectRoot:string;
  targetShotIds:string[];
  maxAutoRetries:number;
  buildTimeline:boolean;
  status:AutomationStatus;
}

export class AutomationJournal{
  async read(project:FilmProject):Promise<AutomationRunJournal|undefined>{
    const dir=join(project.rootPath,'.cineforge'),path=join(dir,FILE);
    let safe:string;
    try{safe=await assertExistingPathInside(dir,path,'automation run journal');}
    catch(error:any){if(error?.code==='ENOENT')return undefined;throw error;}
    const raw=await readJsonFileLimited(safe,'automation run journal',2*1024*1024);
    return sanitizeJournal(raw,project);
  }

  async write(project:FilmProject,journal:AutomationRunJournal):Promise<void>{
    const dir=await ensureSafeDirectory(project.rootPath,join(project.rootPath,'.cineforge'),'CineForge metadata directory');
    const path=await assertSafeWritePath(dir,join(dir,FILE),'automation run journal');
    const temp=await assertSafeWritePath(dir,join(dir,`.${FILE}.${randomUUID()}.tmp`),'automation run journal temp');
    await mkdir(dir,{recursive:true});
    const payload=stringifyJsonLimited(journal,'automation run journal',2*1024*1024);
    await writeFile(temp,payload,{encoding:'utf8',flag:'wx',mode:0o600});
    try{await rename(temp,path);}
    catch(error:any){
      if(!['EEXIST','EPERM','EACCES'].includes(error?.code))throw error;
      await writeFile(path,payload,{encoding:'utf8',mode:0o600});
    }finally{await rm(temp,{force:true}).catch(()=>undefined);}
  }
}

function sanitizeJournal(raw:any,project:FilmProject):AutomationRunJournal{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.schemaVersion!==1)throw new Error('Unsupported or malformed automation run journal.');
  if(raw.projectId!==project.id||raw.projectRoot!==project.rootPath)throw new Error('Automation run journal does not belong to the open project.');
  const shotIds=new Set(project.shots.map(shot=>shot.id));
  const rawTargetShotIds:unknown[]=Array.isArray(raw.targetShotIds)?raw.targetShotIds:[];
  const targetShotIds:string[]=[...new Set(rawTargetShotIds.filter((id):id is string=>typeof id==='string'&&shotIds.has(id)))];
  const status=raw.status;
  if(!status||typeof status!=='object'||typeof status.running!=='boolean'||typeof status.paused!=='boolean'||typeof status.phase!=='string'||typeof status.message!=='string')throw new Error('Automation run journal status is malformed.');
  const phases=new Set(['idle','preflight','planning','waiting-render','qc','retrying','waiting-human','building-timeline','paused','complete','error']);
  if(!phases.has(status.phase))throw new Error('Automation run journal contains an unknown phase.');
  const retryCounts:Record<string,number>={};
  if(status.retryCounts&&typeof status.retryCounts==='object'&&!Array.isArray(status.retryCounts)){for(const[id,value]of Object.entries(status.retryCounts)){const n=Number(value);if(shotIds.has(id)&&Number.isFinite(n)&&n>=0)retryCounts[id]=Math.min(5,Math.trunc(n));}}
  const rawCompletedShotIds:unknown[]=Array.isArray(status.completedShotIds)?status.completedShotIds:[];
  const completedShotIds:string[]=rawCompletedShotIds.filter((id):id is string=>typeof id==='string'&&shotIds.has(id));
  const rawBlockedTaskIds:unknown[]=Array.isArray(status.blockedHumanTaskIds)?status.blockedHumanTaskIds:[];
  const blockedHumanTaskIds:string[]=rawBlockedTaskIds.filter((id):id is string=>typeof id==='string'&&project.humanTasks.some(task=>task.id===id));
  return{
    schemaVersion:1,projectId:project.id,projectRoot:project.rootPath,targetShotIds,
    maxAutoRetries:Math.max(0,Math.min(5,Math.trunc(Number(raw.maxAutoRetries)||0))),buildTimeline:raw.buildTimeline!==false,
    status:{...status,projectRoot:project.rootPath,completedShotIds,retryCounts,blockedHumanTaskIds,updatedAt:typeof status.updatedAt==='string'?status.updatedAt:new Date().toISOString()}
  };
}
