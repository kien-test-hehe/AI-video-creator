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
  const{activeView,project,setProject,setMachine,syncRuntime,setQueue,setAutomation,setError}=useAppStore();
  useEffect(()=>{
    let disposed=false,runtimeSyncSequence=0;
    const bootstrapSequence=++runtimeSyncSequence;
    void Promise.all([window.cineforge.project.get(),window.cineforge.render.snapshot(),window.cineforge.settings.get(),window.cineforge.automation.status()])
      .then(([project,queue,machine,automation])=>{if(disposed)return;setMachine(machine);setAutomation(automation);if(bootstrapSequence!==runtimeSyncSequence)return;if(project)setProject(project);setQueue(queue);})
      .catch(e=>{if(!disposed&&bootstrapSequence===runtimeSyncSequence)setError(e instanceof Error?e.message:String(e));});
    const refreshRuntimeProject=()=>{
      const sequence=++runtimeSyncSequence;
      void window.cineforge.project.get().then(project=>{if(!disposed&&sequence===runtimeSyncSequence&&project)syncRuntime(project);}).catch(e=>{if(!disposed&&sequence===runtimeSyncSequence)setError(e instanceof Error?e.message:String(e));});
    };
    const unsubscribe=window.cineforge.render.onQueueEvent(snapshot=>{if(disposed)return;setQueue(snapshot);refreshRuntimeProject();});
    const unsubscribeAutomation=window.cineforge.automation.onStatus(status=>{if(disposed)return;setAutomation(status);refreshRuntimeProject();});
    return()=>{disposed=true;runtimeSyncSequence+=1;unsubscribe();unsubscribeAutomation();};
  },[setAutomation,setError,setMachine,setProject,setQueue,syncRuntime]);
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
