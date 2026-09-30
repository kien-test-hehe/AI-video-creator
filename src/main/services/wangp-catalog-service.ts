import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { app } from 'electron';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppMachineSettings, FilmProject, ModelFamily, WanGpCatalogEntry, WorkflowProfile } from '../../shared/types';
import { AppSettingsService } from './app-settings-service';
import { assertSafeWritePath, ensureSafeDirectory } from './path-safety';
import { ProjectService } from './project-service';
import { validateAndRecordProfile } from './profile-validation';
import { analyzeWanGpBindings } from './wangp-engine';
import { shotProjectRenderInputKey } from '../../shared/shot-signature';
import { invalidateObservedFinalState } from '../../shared/production-state';

const execFileAsync=promisify(execFile);
const BRIDGE_MARKER='CINEFORGE_JSON:';

export async function listWanGpCatalog(machine:AppMachineSettings):Promise<WanGpCatalogEntry[]>{
  const value=await runBridge(machine,['catalog']);
  if(!Array.isArray(value))throw new Error('WanGP catalog bridge returned an invalid payload.');
  return value.filter(item=>item&&typeof item.modelType==='string'&&item.modelType).map(item=>({
    modelType:String(item.modelType),name:String(item.name||item.modelType),family:item.family?String(item.family):undefined,familyLabel:item.familyLabel?String(item.familyLabel):undefined,
    mainOutput:Array.isArray(item.mainOutput)?item.mainOutput.map(String):[],outputs:Array.isArray(item.outputs)?item.outputs.map(String):[],inputs:Array.isArray(item.inputs)?item.inputs.map(String):[],capabilities:item.capabilities&&typeof item.capabilities==='object'?Object.fromEntries(Object.entries(item.capabilities).map(([key,value])=>[key,value===true])):undefined,description:item.description?String(item.description):undefined
  }));
}

export async function provisionRecommendedWanGpProfiles(projects:ProjectService,settings:AppSettingsService):Promise<FilmProject>{
  const machine=settings.get();
  if(machine.wangp.executionMode!=='native')throw new Error('Managed WanGP profile provisioning currently requires native mode. Docker runtimes should import settings generated inside the pinned image.');
  const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');
  const catalog=await listWanGpCatalog(machine);
  const picks=pickRecommended(catalog);
  if(!picks.length)throw new Error('WanGP catalog did not expose a suitable video or image model.');

  const created:string[]=[];
  for(const pick of picks){
    const template=await runBridge(machine,['template','--model-type',pick.entry.modelType]);
    if(!template||typeof template!=='object'||Array.isArray(template))throw new Error(`WanGP returned invalid defaults for ${pick.entry.modelType}.`);
    const settingsJson:Record<string,unknown>={...(template as Record<string,unknown>),model_type:pick.entry.modelType};
    if(settingsJson.prompt==null)settingsJson.prompt='';
    if(settingsJson.seed==null)settingsJson.seed=1;
    if(pick.purpose==='video'){
      if(settingsJson.video_length==null&&settingsJson.frames==null)settingsJson.video_length=121;
      if(settingsJson.force_fps==null&&settingsJson.fps==null)settingsJson.force_fps=24;
      if(settingsJson.resolution==null)settingsJson.resolution=pick.role==='hero'?'832x480':'1280x704';
    }else if(settingsJson.resolution==null){settingsJson.resolution='1280x720';}

    const safeModel=pick.entry.modelType.replace(/[^a-zA-Z0-9._-]+/g,'_');
    if(!safeModel||safeModel.length>200)throw new Error(`WanGP model type is too long or unsafe for a managed profile identifier: ${pick.entry.modelType.slice(0,240)}`);
    const profileName=`Managed · ${pick.entry.name}`;
    if(profileName.length>240)throw new Error(`WanGP catalog name exceeds the 240-character managed profile safety limit: ${pick.entry.name.slice(0,240)}`);
    const analyzed=analyzeWanGpBindings(settingsJson);
    const id=`managed-wangp-${safeModel}`;
    const profileNotes=[`Auto-provisioned from WanGP model catalog for role: ${pick.role}.`,pick.entry.description||'',...analyzed.warnings].filter(Boolean).join('\n');
    if(profileNotes.length>20_000)throw new Error(`WanGP catalog metadata exceeds the 20000-character managed profile notes safety limit for ${pick.entry.modelType}.`);
    const workflowsRoot=await ensureSafeDirectory(project.rootPath,join(project.rootPath,'workflows'),'managed WanGP workflows directory');
    const workflowPath=await assertSafeWritePath(workflowsRoot,join(workflowsRoot,`managed-${safeModel}.json`),'managed WanGP settings');
    await writeFile(workflowPath,JSON.stringify(settingsJson,null,2),'utf8');
    const profile:WorkflowProfile={
      id,runtime:'wangp',purpose:pick.purpose,name:profileName,modelFamily:mapModelFamily(pick.entry),mode:pick.mode,
      workflowPath,workflowFormat:'wangp-settings',bindings:analyzed.bindings,enabled:false,
      notes:profileNotes,
      validation:{structuralStatus:'unvalidated'}
    };
    await projects.mutate(p=>{
      const before=new Map(p.shots.map(shot=>[shot.id,shotProjectRenderInputKey(p,shot)]));
      upsertManagedProfile(p,profile);
      invalidateChangedRoutes(p,before);
    });
    await validateAndRecordProfile(projects,machine,id);
    const validated=projects.getCurrent()?.settings.workflowProfiles.find(x=>x.id===id);
    if(validated?.validation?.structuralStatus==='valid'){
      await projects.mutate(p=>{const before=new Map(p.shots.map(shot=>[shot.id,shotProjectRenderInputKey(p,shot)]));const target=p.settings.workflowProfiles.find(x=>x.id===id);if(target)target.enabled=true;invalidateChangedRoutes(p,before);});
      created.push(id);
    }
  }
  if(!created.length)throw new Error('Managed profiles were generated but none passed structural validation.');
  return projects.getCurrent()!;
}

export function upsertManagedProfile(project:FilmProject,profile:WorkflowProfile):void{
  const index=project.settings.workflowProfiles.findIndex(existing=>existing.id===profile.id);
  if(index<0&&project.settings.workflowProfiles.length>=512)throw new Error('Managed profile provisioning would exceed the 512-profile project safety limit.');
  if(index>=0)project.settings.workflowProfiles[index]=profile;else project.settings.workflowProfiles.push(profile);
}

export function invalidateChangedRoutes(project:FilmProject,before:Map<string,string>):void{
  for(const shot of project.shots){
    if(before.get(shot.id)===shotProjectRenderInputKey(project,shot))continue;
    shot.latestRenderId=undefined;
    shot.canonicalRenderId=undefined;
    invalidateObservedFinalState(project,shot.id,'Workflow/profile routing changed; prior rendered and observed continuity truth is stale.');
    if(['rendered','failed'].includes(shot.status))shot.status='ready';
  }
}

function pickRecommended(catalog:WanGpCatalogEntry[]):Array<{entry:WanGpCatalogEntry;role:'general'|'hero'|'motion'|'keyframe';purpose:'video'|'image';mode:'t2v'|'i2v'|'t2i'|'i2i'}>{
  const video=catalog.filter(e=>e.mainOutput.includes('video')||e.outputs.includes('video'));
  const image=catalog.filter(e=>e.mainOutput.includes('image')||e.outputs.includes('image'));
  const general=maxBy(video,e=>score(e,[['ltx2_25_22B_distilled_nvfp4',100],['ltx2_25',70],['LTX-2.5',60],['LTX 2.5',60]]));
  const hero=maxBy(video,e=>score(e,[['hunyuan_1_5',90],['Hunyuan Video 1.5',80],['HunyuanVideo-1.5',80]]));
  const motion=maxBy(video,e=>score(e,[['Wan2.2 TextImage2video 5B',100],['ti2v_2_2',95],['Wan2.2',50],['5B',20]]));
  const keyframe=maxBy(image,e=>score(e,[['Qwen Image 2.1',100],['qwen_image_2',95],['Qwen Image Edit Plus',90],['Krea 2 Identity',85],['Krea 2',70],['Z-Image',60]]));
  const out:Array<{entry:WanGpCatalogEntry;role:'general'|'hero'|'motion'|'keyframe';purpose:'video'|'image';mode:'t2v'|'i2v'|'t2i'|'i2i'}>=[];
  if(general)out.push({entry:general,role:'general',purpose:'video',mode:preferredVideoMode(general)});
  if(hero&&hero.modelType!==general?.modelType)out.push({entry:hero,role:'hero',purpose:'video',mode:preferredVideoMode(hero)});
  if(motion&&motion.modelType!==general?.modelType&&motion.modelType!==hero?.modelType)out.push({entry:motion,role:'motion',purpose:'video',mode:preferredVideoMode(motion)});
  if(keyframe)out.push({entry:keyframe,role:'keyframe',purpose:'image',mode:preferredImageMode(keyframe)});
  return out;
}

function preferredVideoMode(entry:WanGpCatalogEntry):'t2v'|'i2v'{if(entry.capabilities?.image_to_video)return'i2v';return't2v';}
function preferredImageMode(entry:WanGpCatalogEntry):'t2i'|'i2i'{if(entry.capabilities?.text_to_image)return't2i';if(entry.capabilities?.image_to_image)return'i2i';return entry.inputs.includes('image')?'i2i':'t2i';}

function score(entry:WanGpCatalogEntry,rules:Array<[string,number]>):number{
  const hay=`${entry.modelType} ${entry.name} ${entry.familyLabel||''}`.toLowerCase();
  let best=-1;for(const[token,value]of rules)if(hay.includes(token.toLowerCase()))best=Math.max(best,value);return best;
}
function maxBy(entries:WanGpCatalogEntry[],fn:(entry:WanGpCatalogEntry)=>number):WanGpCatalogEntry|undefined{
  let best:WanGpCatalogEntry|undefined,bestScore=-1;for(const entry of entries){const s=fn(entry);if(s>bestScore){best=entry;bestScore=s;}}return bestScore>=0?best:undefined;
}
function mapModelFamily(entry:WanGpCatalogEntry):ModelFamily{
  const hay=`${entry.modelType} ${entry.name}`.toLowerCase();
  if(/ltx.*2[._ -]?5/.test(hay))return'ltx-2.5-fast';
  if(/hunyuan.*1[._ -]?5/.test(hay))return'hunyuan-video-1.5';
  if(/wan.*2[._ -]?2/.test(hay)&&/5b/.test(hay))return'wan-2.2-5b';
  if(/ltx.*2[._ -]?3/.test(hay))return'ltx-2.3';
  return'custom';
}

async function runBridge(machine:AppMachineSettings,args:string[]):Promise<any>{
  if(!machine.wangp.rootPath.trim())throw new Error('WanGP root is not configured.');
  const bridge=app.isPackaged?join(process.resourcesPath,'scripts','wangp_bridge.py'):join(app.getAppPath(),'scripts','wangp_bridge.py');
  const fullArgs=[bridge,...args,'--root',machine.wangp.rootPath,'--profile',String(machine.wangp.profile),'--attention',machine.wangp.attention];
  const{stdout,stderr}=await execFileAsync(machine.wangp.pythonPath,fullArgs,{cwd:machine.wangp.rootPath,timeout:120_000,maxBuffer:32*1024*1024,env:{...process.env,PYTHONUTF8:'1'}});
  const lines=`${stdout}\n${stderr}`.split(/\r?\n/).reverse();
  const marked=lines.find(line=>line.startsWith(BRIDGE_MARKER));
  if(!marked)throw new Error(`WanGP bridge returned no machine-readable payload. Tail: ${lines.slice(0,10).reverse().join(' | ').slice(0,2000)}`);
  return JSON.parse(marked.slice(BRIDGE_MARKER.length));
}
