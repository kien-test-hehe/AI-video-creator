import { useEffect } from 'react';
import { Shell } from './components/Shell';
import { useAppStore } from './store';
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
  const{activeView,setProject,setMachine,syncRuntime,setQueue,setError}=useAppStore();
  useEffect(()=>{
    void Promise.all([window.cineforge.project.get(),window.cineforge.render.snapshot(),window.cineforge.settings.get()])
      .then(([project,queue,machine])=>{if(project)setProject(project);setQueue(queue);setMachine(machine);})
      .catch(e=>setError(e instanceof Error?e.message:String(e)));
    return window.cineforge.render.onQueueEvent(snapshot=>{setQueue(snapshot);void window.cineforge.project.get().then(project=>project&&syncRuntime(project));});
  },[]);
  const views={dashboard:<Dashboard/>,story:<Story/>,assets:<Assets/>,storyboard:<Storyboard/>,shots:<Shots/>,queue:<Queue/>,timeline:<Timeline/>,finishing:<Finishing/>,settings:<Settings/>};
  return <Shell>{views[activeView]}</Shell>;
}
