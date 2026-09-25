import { create } from 'zustand';
import type { AppMachineSettings, FilmProject, QueueSnapshot, SystemProbe } from '../../shared/types';

export type ViewId='studio'|'dashboard'|'story'|'assets'|'storyboard'|'shots'|'queue'|'timeline'|'finishing'|'settings';
interface AppState{
  project:FilmProject|null;machine:AppMachineSettings|null;activeView:ViewId;selectedShotId?:string;queue:QueueSnapshot;probe?:SystemProbe;busy:boolean;projectDirty:boolean;machineDirty:boolean;error?:string;notice?:string;
  setProject(project:FilmProject|null):void;syncRuntime(project:FilmProject):void;updateProject(mutator:(project:FilmProject)=>void):void;persist():Promise<void>;
  setMachine(machine:AppMachineSettings):void;updateMachine(mutator:(machine:AppMachineSettings)=>void):void;persistMachine():Promise<void>;
  setView(view:ViewId):void;selectShot(id?:string):void;setQueue(queue:QueueSnapshot):void;setProbe(probe?:SystemProbe):void;setBusy(busy:boolean):void;setError(error?:string):void;setNotice(notice?:string):void;
}
let projectTimer:ReturnType<typeof setTimeout>|undefined,machineTimer:ReturnType<typeof setTimeout>|undefined;

export const useAppStore=create<AppState>((set,get)=>({
  project:null,machine:null,activeView:'studio',queue:{jobs:[]},busy:false,projectDirty:false,machineDirty:false,
  setProject:project=>{clearTimeout(projectTimer);projectTimer=undefined;set({project,projectDirty:false});},
  syncRuntime:mainProject=>set(state=>{
    const current=state.project;if(!current||current.id!==mainProject.id)return{project:mainProject,projectDirty:false};
    const next=structuredClone(current);
    next.renderJobs=structuredClone(mainProject.renderJobs);next.renderOutputs=structuredClone(mainProject.renderOutputs);
    const runtime=new Map(mainProject.shots.map(shot=>[shot.id,{status:shot.status,latestRenderId:shot.latestRenderId}]));
    for(const shot of next.shots){const value=runtime.get(shot.id);if(value){shot.status=value.status;shot.latestRenderId=value.latestRenderId;}}
    const serverProfiles=new Map(mainProject.settings.workflowProfiles.map(profile=>[profile.id,profile]));
    next.settings.workflowProfiles=next.settings.workflowProfiles.map(local=>{
      const server=serverProfiles.get(local.id);if(!server)return local;
      if(profileConfigKey(local)!==profileConfigKey(server))return local;
      return{...local,validation:structuredClone(server.validation)};
    });
    if(!state.projectDirty)for(const server of mainProject.settings.workflowProfiles)if(!next.settings.workflowProfiles.some(local=>local.id===server.id))next.settings.workflowProfiles.push(structuredClone(server));
    return{project:next};
  }),
  updateProject:mutator=>{const current=get().project;if(!current)return;const next=structuredClone(current);mutator(next);next.updatedAt=new Date().toISOString();set({project:next,projectDirty:true});clearTimeout(projectTimer);projectTimer=setTimeout(()=>void get().persist(),450);},
  persist:async()=>{
    clearTimeout(projectTimer);projectTimer=undefined;const project=get().project;if(!project)return;
    const revision=project.updatedAt;
    try{
      const saved=await window.cineforge.project.save(project);
      set(state=>{
        if(!state.project||state.project.id!==project.id)return{};
        if(state.project.updatedAt!==revision)return{error:undefined};
        return{project:saved,projectDirty:false,error:undefined};
      });
    }catch(error){set({error:error instanceof Error?error.message:String(error)});}
  },
  setMachine:machine=>{clearTimeout(machineTimer);machineTimer=undefined;set({machine,machineDirty:false});},
  updateMachine:mutator=>{const current=get().machine;if(!current)return;const next=structuredClone(current);mutator(next);set({machine:next,machineDirty:true});clearTimeout(machineTimer);machineTimer=setTimeout(()=>void get().persistMachine(),450);},
  persistMachine:async()=>{
    clearTimeout(machineTimer);machineTimer=undefined;const machine=get().machine;if(!machine)return;
    try{
      const saved=await window.cineforge.settings.save(machine);
      set(state=>state.machine===machine?{machine:saved,machineDirty:false,error:undefined}:{error:undefined});
    }catch(error){set({error:error instanceof Error?error.message:String(error)});}
  },
  setView:activeView=>set({activeView}),selectShot:selectedShotId=>set({selectedShotId}),setQueue:queue=>set({queue}),setProbe:probe=>set({probe}),setBusy:busy=>set({busy}),setError:error=>set({error}),setNotice:notice=>set({notice})
}));

function profileConfigKey(profile:FilmProject['settings']['workflowProfiles'][number]):string{
  return JSON.stringify({
    runtime:profile.runtime,purpose:profile.purpose,name:profile.name,modelFamily:profile.modelFamily,mode:profile.mode,
    workflowPath:profile.workflowPath,workflowFormat:profile.workflowFormat,bindings:profile.bindings,enabled:profile.enabled,
    notes:profile.notes,modelFingerprint:profile.modelFingerprint
  });
}
