import { useEffect } from 'react';
import { Shell } from './components/Shell';
import { useAppStore } from './store';
import { Studio } from './views/Studio';
import { Dashboard } from './views/Dashboard';
import { Story } from './views/Story';
import { Assets } from './views/Assets';
import { Storyboard } from './views/Storyboard';
import { Shots } from './views/Shots';
import { Queue } from './views/Queue';
import { Timeline } from './views/Timeline';
import { Settings } from './views/Settings';
import { Finishing } from './views/Finishing';

export default function App(){
  const{activeView,project,setProject,setMachine,syncRuntime,setQueue,setError}=useAppStore();
  useEffect(()=>{
    void Promise.all([window.cineforge.project.get(),window.cineforge.render.snapshot(),window.cineforge.settings.get()])
      .then(([project,queue,machine])=>{if(project)setProject(project);setQueue(queue);setMachine(machine);})
      .catch(e=>setError(e instanceof Error?e.message:String(e)));
    return window.cineforge.render.onQueueEvent(snapshot=>{setQueue(snapshot);void window.cineforge.project.get().then(project=>project&&syncRuntime(project));});
  },[setError,setMachine,setProject,setQueue,syncRuntime]);
  useEffect(()=>{
    let allowClose=false,flushing=false;
    const beforeUnload=(event:BeforeUnloadEvent)=>{
      const state=useAppStore.getState();
      if(allowClose||(!state.projectDirty&&!state.machineDirty))return;
      event.preventDefault();event.returnValue='';
      if(flushing)return;
      flushing=true;
      void Promise.all([state.persist(),state.persistMachine()]).then(()=>{
        const latest=useAppStore.getState();
        if(!latest.projectDirty&&!latest.machineDirty){allowClose=true;window.close();}
        else{flushing=false;latest.setError('CineForge could not save all pending edits, so closing was cancelled. Resolve the save error and try again.');}
      }).catch(error=>{
        flushing=false;
        useAppStore.getState().setError(`CineForge could not save pending edits, so closing was cancelled: ${error instanceof Error?error.message:String(error)}`);
      });
    };
    window.addEventListener('beforeunload',beforeUnload);
    return()=>window.removeEventListener('beforeunload',beforeUnload);
  },[]);
  const views={studio:<Studio key={project?.id||'no-project'}/>,dashboard:<Dashboard/>,story:<Story/>,assets:<Assets/>,storyboard:<Storyboard/>,shots:<Shots/>,queue:<Queue/>,timeline:<Timeline/>,finishing:<Finishing/>,settings:<Settings/>};
  return <Shell>{views[activeView]}</Shell>;
}
