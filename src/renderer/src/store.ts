import { create } from 'zustand';
import type { AppMachineSettings, FilmProject, QueueSnapshot, SystemProbe } from '../../shared/types';

export type ViewId='dashboard'|'story'|'assets'|'storyboard'|'shots'|'queue'|'timeline'|'finishing'|'settings';
interface AppState{
  project:FilmProject|null;machine:AppMachineSettings|null;activeView:ViewId;selectedShotId?:string;queue:QueueSnapshot;probe?:SystemProbe;busy:boolean;error?:string;notice?:string;
  setProject(project:FilmProject|null):void;syncRuntime(project:FilmProject):void;updateProject(mutator:(project:FilmProject)=>void):void;persist():Promise<void>;
  setMachine(machine:AppMachineSettings):void;updateMachine(mutator:(machine:AppMachineSettings)=>void):void;persistMachine():Promise<void>;
  setView(view:ViewId):void;selectShot(id?:string):void;setQueue(queue:QueueSnapshot):void;setProbe(probe?:SystemProbe):void;setBusy(busy:boolean):void;setError(error?:string):void;setNotice(notice?:string):void;
}
let projectTimer:ReturnType<typeof setTimeout>|undefined,machineTimer:ReturnType<typeof setTimeout>|undefined;

export const useAppStore=create<AppState>((set,get)=>({
  project:null,machine:null,activeView:'dashboard',queue:{jobs:[]},busy:false,
  setProject:project=>{clearTimeout(projectTimer);projectTimer=undefined;set({project});},
  syncRuntime:mainProject=>set(state=>{const current=state.project;if(!current||current.id!==mainProject.id)return{project:mainProject};const next=structuredClone(current);next.renderJobs=structuredClone(mainProject.renderJobs);next.renderOutputs=structuredClone(mainProject.renderOutputs);next.settings.workflowProfiles=structuredClone(mainProject.settings.workflowProfiles);const runtime=new Map(mainProject.shots.map(shot=>[shot.id,{status:shot.status,latestRenderId:shot.latestRenderId}]));for(const shot of next.shots){const value=runtime.get(shot.id);if(value){shot.status=value.status;shot.latestRenderId=value.latestRenderId;}}return{project:next};}),
  updateProject:mutator=>{const current=get().project;if(!current)return;const next=structuredClone(current);mutator(next);next.updatedAt=new Date().toISOString();set({project:next});clearTimeout(projectTimer);projectTimer=setTimeout(()=>void get().persist(),450);},
  persist:async()=>{clearTimeout(projectTimer);projectTimer=undefined;const project=get().project;if(!project)return;try{const saved=await window.cineforge.project.save(project);set({project:saved,error:undefined});}catch(error){set({error:error instanceof Error?error.message:String(error)});}},
  setMachine:machine=>{clearTimeout(machineTimer);machineTimer=undefined;set({machine});},
  updateMachine:mutator=>{const current=get().machine;if(!current)return;const next=structuredClone(current);mutator(next);set({machine:next});clearTimeout(machineTimer);machineTimer=setTimeout(()=>void get().persistMachine(),450);},
  persistMachine:async()=>{clearTimeout(machineTimer);machineTimer=undefined;const machine=get().machine;if(!machine)return;try{const saved=await window.cineforge.settings.save(machine);set({machine:saved,error:undefined});}catch(error){set({error:error instanceof Error?error.message:String(error)});}},
  setView:activeView=>set({activeView}),selectShot:selectedShotId=>set({selectedShotId}),setQueue:queue=>set({queue}),setProbe:probe=>set({probe}),setBusy:busy=>set({busy}),setError:error=>set({error}),setNotice:notice=>set({notice})
}));
