import { create } from 'zustand';
import type { AppMachineSettings, FilmProject, QueueSnapshot, SystemProbe } from '../../shared/types';
import { shotProjectRenderInputKey } from '../../shared/shot-signature';

export type ViewId='studio'|'dashboard'|'story'|'assets'|'storyboard'|'shots'|'queue'|'timeline'|'finishing'|'settings';
interface AppState{
  project:FilmProject|null;machine:AppMachineSettings|null;activeView:ViewId;selectedShotId?:string;queue:QueueSnapshot;probe?:SystemProbe;busy:boolean;projectWriteLocked:boolean;projectDirty:boolean;machineDirty:boolean;error?:string;notice?:string;
  setProject(project:FilmProject|null):void;syncRuntime(project:FilmProject):void;updateProject(mutator:(project:FilmProject)=>void):void;persist():Promise<void>;runProjectMutation<T>(operation:()=>Promise<T>):Promise<T>;
  setMachine(machine:AppMachineSettings):void;updateMachine(mutator:(machine:AppMachineSettings)=>void):void;persistMachine():Promise<void>;
  setView(view:ViewId):void;selectShot(id?:string):void;setQueue(queue:QueueSnapshot):void;setProbe(probe?:SystemProbe):void;setBusy(busy:boolean):void;setError(error?:string):void;setNotice(notice?:string):void;
}
let projectTimer:ReturnType<typeof setTimeout>|undefined,machineTimer:ReturnType<typeof setTimeout>|undefined;
let projectEditRevision=0,machineEditRevision=0,busyCount=0,projectWriteLockCount=0;

export const useAppStore=create<AppState>((set,get)=>({
  project:null,machine:null,activeView:'studio',queue:{jobs:[]},busy:false,projectWriteLocked:false,projectDirty:false,machineDirty:false,
  setProject:project=>{clearTimeout(projectTimer);projectTimer=undefined;projectEditRevision+=1;set({project,projectDirty:false,selectedShotId:undefined,probe:undefined});},
  syncRuntime:mainProject=>set(state=>{
    const current=state.project;if(!current||current.id!==mainProject.id)return{project:mainProject,projectDirty:false,selectedShotId:undefined,probe:undefined};
    const next=structuredClone(current);
    next.renderJobs=structuredClone(mainProject.renderJobs);
    next.renderOutputs=structuredClone(mainProject.renderOutputs);
    next.shotStates=structuredClone(mainProject.shotStates);
    next.shotDependencies=structuredClone(mainProject.shotDependencies);
    next.qcResults=structuredClone(mainProject.qcResults);
    next.humanTasks=structuredClone(mainProject.humanTasks);
    next.cutRevisions=structuredClone(mainProject.cutRevisions);
    const runtime=new Map(mainProject.shots.map(shot=>[shot.id,shot]));
    for(const shot of next.shots){
      const server=runtime.get(shot.id);if(!server)continue;
      shot.latestAttemptRenderId=server.latestAttemptRenderId;
      shot.canonicalRenderId=server.canonicalRenderId;
      shot.plannedStartStateId=server.plannedStartStateId;
      shot.plannedEndStateId=server.plannedEndStateId;
      shot.actualStartStateId=server.actualStartStateId;
      shot.observedFinalStateId=server.observedFinalStateId;
      if(!state.projectDirty&&server.actualStartStateId)shot.startFrameAssetId=server.startFrameAssetId;
      if(shotProjectRenderInputKey(next,shot)!==shotProjectRenderInputKey(mainProject,server))continue;
      shot.status=server.status;
      shot.latestRenderId=server.latestRenderId;
    }
    const serverProfiles=new Map(mainProject.settings.workflowProfiles.map(profile=>[profile.id,profile]));
    next.settings.workflowProfiles=next.settings.workflowProfiles.map(local=>{
      const server=serverProfiles.get(local.id);if(!server)return local;
      if(profileConfigKey(local)!==profileConfigKey(server))return local;
      return{...local,validation:structuredClone(server.validation)};
    });
    if(!state.projectDirty)for(const server of mainProject.settings.workflowProfiles)if(!next.settings.workflowProfiles.some(local=>local.id===server.id))next.settings.workflowProfiles.push(structuredClone(server));
    return{project:next};
  }),
  updateProject:mutator=>{if(get().projectWriteLocked){set({error:'A project-changing operation is still applying. Wait for it to finish or cancel it before editing the project.'});return;}const current=get().project;if(!current)return;const before=new Map(current.shots.map(shot=>[shot.id,shotProjectRenderInputKey(current,shot)]));const next=structuredClone(current);mutator(next);for(const shot of next.shots){const prior=before.get(shot.id);if(prior&&prior!==shotProjectRenderInputKey(next,shot)){shot.latestRenderId=undefined;if(['rendered','failed'].includes(shot.status))shot.status='ready';}}projectEditRevision+=1;next.updatedAt=new Date().toISOString();set({project:next,projectDirty:true});clearTimeout(projectTimer);projectTimer=setTimeout(()=>void get().persist().catch(()=>undefined),450);},
  runProjectMutation:async operation=>{projectWriteLockCount+=1;set({projectWriteLocked:true});try{return await operation();}finally{projectWriteLockCount=Math.max(0,projectWriteLockCount-1);set({projectWriteLocked:projectWriteLockCount>0});}},
  persist:async()=>{
    clearTimeout(projectTimer);projectTimer=undefined;
    try{
      for(let attempt=0;attempt<5;attempt++){
        const project=get().project;if(!project)return;
        const revision=projectEditRevision,saved=await window.cineforge.project.save(project);
        const current=get().project;
        if(!current||current.id!==project.id)return;
        if(projectEditRevision!==revision)continue;
        set({project:saved,projectDirty:false,error:undefined});return;
      }
      throw new Error('Project kept changing while CineForge was saving it. Finish the current edits and try the action again.');
    }catch(error){set({error:error instanceof Error?error.message:String(error)});throw error;}
  },
  setMachine:machine=>{clearTimeout(machineTimer);machineTimer=undefined;machineEditRevision+=1;set({machine,machineDirty:false});},
  updateMachine:mutator=>{const current=get().machine;if(!current)return;const next=structuredClone(current);mutator(next);machineEditRevision+=1;set({machine:next,machineDirty:true});clearTimeout(machineTimer);machineTimer=setTimeout(()=>void get().persistMachine().catch(()=>undefined),450);},
  persistMachine:async()=>{
    clearTimeout(machineTimer);machineTimer=undefined;
    try{
      for(let attempt=0;attempt<5;attempt++){
        const machine=get().machine;if(!machine)return;
        const revision=machineEditRevision,saved=await window.cineforge.settings.save(machine);
        if(machineEditRevision!==revision)continue;
        set({machine:saved,machineDirty:false,error:undefined});return;
      }
      throw new Error('Machine settings kept changing while CineForge was saving them. Finish the current edits and try the action again.');
    }catch(error){set({error:error instanceof Error?error.message:String(error)});throw error;}
  },
  setView:activeView=>set({activeView}),selectShot:selectedShotId=>set({selectedShotId}),setQueue:queue=>set({queue}),setProbe:probe=>set({probe}),setBusy:busy=>{busyCount=Math.max(0,busyCount+(busy?1:-1));set({busy:busyCount>0});},setError:error=>set({error}),setNotice:notice=>set({notice})
}));

function profileConfigKey(profile:FilmProject['settings']['workflowProfiles'][number]):string{
  return JSON.stringify({
    runtime:profile.runtime,purpose:profile.purpose,name:profile.name,modelFamily:profile.modelFamily,mode:profile.mode,
    workflowPath:profile.workflowPath,workflowFormat:profile.workflowFormat,bindings:profile.bindings,enabled:profile.enabled,
    notes:profile.notes,modelFingerprint:profile.modelFingerprint
  });
}
