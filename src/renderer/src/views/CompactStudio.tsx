import { useState, type DragEvent } from 'react';
import { MODEL_DEFAULTS } from '../../../shared/defaults';
import type { Asset, GenerationMode, ModelFamily, Shot } from '../../../shared/types';
import { projectMediaUrl } from '../media';
import { autoAssignAssetToShot } from '../asset-assignment';
import { isStudioWorkflowReady, resolveStudioWorkflow, studioWorkflowIssue } from '../studio-logic';
import { useAppStore } from '../store';
import { Empty } from '../components/Ui';

type CompactTool='media'|'cast'|'places'|'shots'|'ai'|'review'|'audio';
type InspectorTab='edit'|'ai'|'review'|'info';
const ACTIVE_JOB_STATUSES=new Set(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);
const MODELS:ModelFamily[]=['ltx-2.5-fast','ltx-2.3','hunyuan-video-1.5','wan-2.2-5b','framepack','custom'];
const MODES:GenerationMode[]=['t2v','i2v','flf2v','ia2v','v2v'];

export function CompactStudio({onOpenAdvanced}:{onOpenAdvanced:()=>void}){
  const{project,queue,automation,selectedShotId,selectShot,updateProject,setQueue,setAutomation,setView,setError,setNotice,setProbe}=useAppStore();
  const[tool,setTool]=useState<CompactTool>('media');
  const[tab,setTab]=useState<InspectorTab>('edit');
  const[search,setSearch]=useState('');
  const[reviewTaskId,setReviewTaskId]=useState<string>();
  const[autoBusy,setAutoBusy]=useState(false);
  if(!project)return <section className="studio-empty"><Empty>Create or open a project to enter Studio.</Empty></section>;

  const sceneIndex=new Map(project.scenes.map(scene=>[scene.id,scene.index] as const));
  const shots=[...project.shots].sort((a,b)=>(sceneIndex.get(a.sceneId)??0)-(sceneIndex.get(b.sceneId)??0)||a.index-b.index||a.id.localeCompare(b.id));
  const selectedShot=project.shots.find(shot=>shot.id===selectedShotId)||shots[0];
  const activeJobs=queue.jobs.filter(job=>ACTIVE_JOB_STATUSES.has(job.status));
  const openTasks=[...project.humanTasks].filter(task=>task.status==='open').sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const selectedTask=openTasks.find(task=>task.id===reviewTaskId)||openTasks.find(task=>task.shotId===selectedShot?.id);
  const latest=selectedShot?.latestRenderId?project.renderOutputs.find(output=>output.id===selectedShot.latestRenderId):undefined;
  const previewAsset=selectedShot?shotPreviewAsset(project.assets,selectedShot):undefined;
  const route=selectedShot?resolveStudioWorkflow(project.settings.workflowProfiles,selectedShot):undefined;
  const routeReady=Boolean(selectedShot&&isStudioWorkflowReady(route,selectedShot));
  const shotQc=selectedShot?project.qcResults.filter(result=>result.shotId===selectedShot.id):[];
  const latestQc=(layer:'technical'|'visual'|'semantic'|'continuity')=>[...shotQc].filter(result=>result.layer===layer).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const canonicalCount=project.shots.filter(shot=>Boolean(shot.canonicalRenderId)).length;

  const chooseShot=(shot:Shot)=>{selectShot(shot.id);setReviewTaskId(undefined);setTool('shots');};
  const mutateShot=(fn:(shot:Shot)=>void)=>{if(!selectedShot)return;updateProject(next=>{const target=next.shots.find(item=>item.id===selectedShot.id);if(target)fn(target);});};
  const dropAssetOnSelected=(event:DragEvent<HTMLElement>)=>{
    event.preventDefault();if(!selectedShot)return;
    const assetId=event.dataTransfer.getData('application/x-cineforge-asset');if(!assetId)return;
    const asset=project.assets.find(item=>item.id===assetId);if(!asset)return;
    let result:{ok:boolean;role:string;message:string}|undefined;
    updateProject(next=>{const shot=next.shots.find(item=>item.id===selectedShot.id),candidate=next.assets.find(item=>item.id===assetId);if(shot&&candidate)result=autoAssignAssetToShot(shot,candidate);});
    if(result?.ok)setNotice(asset.name+' → '+selectedShot.title+': '+result.message);else if(result)setError(result.message);
  };

  const queueSelected=async()=>{
    if(!selectedShot||!routeReady){setError('Select a shot with a validated local video route before generating.');return;}
    try{
      const shotId=selectedShot.id;await useAppStore.getState().persist();const current=useAppStore.getState();
      const shot=current.project?.shots.find(item=>item.id===shotId);
      if(!current.project||current.projectDirty||!shot)throw new Error('Shot changed while saving. Finish the edit/save cycle before queueing.');
      setQueue(await window.cineforge.render.enqueue({projectRoot:current.project.rootPath,shotId}));setNotice(shot.title+' added to the local render queue.');
    }catch(error){setError(error instanceof Error?error.message:String(error));}
  };

  const toggleAutomation=async()=>{
    try{setAutoBusy(true);
      if(!automation?.running){
        await useAppStore.getState().persist();const current=useAppStore.getState().project;if(!current)throw new Error('Project closed before AUTO RUN could start.');
        const ready=await window.cineforge.system.readiness();setProbe(ready.probe);
        if(!ready.readyForProduction){setError('Local workstation readiness has blockers. Open System before AUTO RUN.');return;}
        setAutomation(await window.cineforge.automation.start({projectRoot:current.rootPath,maxAutoRetries:2,buildTimeline:true}));setNotice('AUTO RUN started on the local workstation.');
      }else if(automation.paused){setAutomation(await window.cineforge.automation.resume());setNotice('AUTO RUN resumed.');}
      else{setAutomation(await window.cineforge.automation.pause());setNotice('AUTO RUN paused after the current atomic operation.');}
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setAutoBusy(false);}
  };

  const decideHumanQc=async(taskId:string,status:'pass'|'fail')=>{
    try{await useAppStore.getState().runProjectMutation(async()=>{
      await useAppStore.getState().persist();const current=useAppStore.getState().project;if(!current)throw new Error('Project closed while deciding Human Review.');
      const task=current.humanTasks.find(item=>item.id===taskId&&item.status==='open');if(!task)throw new Error('Human task no longer exists or is already closed.');
      const qc=current.qcResults.find(result=>result.humanOverrideTaskId===taskId);
      if(!qc||!qc.renderOutputId||qc.layer==='technical'||!qc.inputKey)throw new Error('This task is not linked to a provenance-complete human-reviewable QC result.');
      const note=window.prompt(qc.layer.toUpperCase()+' QC '+status.toUpperCase()+' note:','Reviewed in Compact Studio.')?.trim();if(note==null)return;if(!note)throw new Error('Human QC verdict requires a review note.');
      const qcProject=await window.cineforge.production.recordQc({projectRoot:current.rootPath,shotId:qc.shotId,renderOutputId:qc.renderOutputId,layer:qc.layer,status,inputKey:qc.inputKey,issues:status==='pass'?[]:[{code:'HUMAN_REJECTED',severity:'major',message:note}]});
      useAppStore.getState().syncRuntime(qcProject);
      const resolved=await window.cineforge.production.resolveHumanTask({projectRoot:qcProject.rootPath,taskId,status:'resolved',resolution:'Human review marked '+qc.layer+' QC '+status.toUpperCase()+': '+note});
      useAppStore.getState().syncRuntime(resolved);setNotice(qc.layer+' QC marked '+status.toUpperCase()+'.');
    });}catch(error){setError(error instanceof Error?error.message:String(error));}
  };

  const q=search.trim().toLowerCase();
  const assets=project.assets.filter(asset=>{
    const allowed=tool==='media'||(tool==='cast'&&asset.kind==='character')||(tool==='places'&&asset.kind==='location')||(tool==='audio'&&asset.kind==='audio');
    return allowed&&(!q||asset.name.toLowerCase().includes(q)||asset.tags.some(tag=>tag.toLowerCase().includes(q)));
  });
  const title:Record<CompactTool,string>={media:'Media',cast:'Cast',places:'Places',shots:'Shots',ai:'AI Director',review:'Human Review',audio:'Audio'};

  return <section className="compact-studio">
    <header className="compact-studio-bar"><div className="compact-title"><strong>{project.story.title||project.name}</strong><span>{selectedShot?.title||'No shot selected'}</span></div><div className="compact-bar-actions">
      <button className="compact-status" onClick={()=>setView('dashboard')}>● Local</button><button className="compact-quiet" onClick={()=>setView('queue')}>Queue {activeJobs.length}</button>
      <button className={automation?.running&&!automation.paused?'compact-quiet active':'compact-primary'} disabled={autoBusy||shots.length===0} onClick={toggleAutomation}>{autoBusy?'…':automation?.running?(automation.paused?'Resume':'Pause'):'AUTO'}</button>
      <button className="compact-quiet" onClick={()=>setView('finishing')}>Export</button></div></header>

    <aside className="compact-toolrail">
      <Tool icon="◇" label="Media" active={tool==='media'} onClick={()=>setTool('media')}/><Tool icon="♙" label="Cast" active={tool==='cast'} onClick={()=>setTool('cast')}/><Tool icon="⌂" label="Places" active={tool==='places'} onClick={()=>setTool('places')}/>
      <Tool icon="▦" label="Shots" active={tool==='shots'} onClick={()=>setTool('shots')}/><Tool icon="✦" label="AI" active={tool==='ai'} onClick={()=>setTool('ai')}/><Tool icon="✓" label="Review" active={tool==='review'} badge={openTasks.length} onClick={()=>setTool('review')}/><Tool icon="♪" label="Audio" active={tool==='audio'} onClick={()=>setTool('audio')}/>
      <span className="compact-tool-spacer"/><Tool icon="⌘" label="Flow" onClick={onOpenAdvanced}/><Tool icon="◫" label="System" onClick={()=>setView('dashboard')}/>
    </aside>

    <aside className="compact-library"><div className="compact-panel-head"><strong>{title[tool]}</strong><div><button className="compact-icon" onClick={()=>tool==='shots'||tool==='ai'?setView('storyboard'):setView('assets')}>＋</button><button className="compact-icon" onClick={onOpenAdvanced}>•••</button></div></div><div className="compact-search"><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search"/></div><div className="compact-library-body">
      {(tool==='media'||tool==='cast'||tool==='places'||tool==='audio')&&<div className="compact-asset-grid">{assets.slice(0,80).map(asset=><button className="compact-asset" key={asset.id} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-cineforge-asset',asset.id);}} onDoubleClick={()=>setView('assets')}><span className="compact-thumb">{isVisual(asset)?<img src={projectMediaUrl(asset.projectPath)} alt=""/>:asset.kind==='audio'?'♪':'▶'}</span><strong>{asset.name}</strong><small>{asset.kind}</small></button>)}{assets.length===0&&<span className="muted">No matching items.</span>}</div>}
      {tool==='shots'&&<div className="compact-list">{shots.map((shot,index)=><button key={shot.id} className={'compact-list-item '+(shot.id===selectedShot?.id?'selected':'')} onClick={()=>chooseShot(shot)} onDoubleClick={()=>setView('shots')}><span className="compact-mini">{String(index+1).padStart(2,'0')}</span><span><strong>{shot.title}</strong><small>{shot.canonicalRenderId?'canonical':shot.status}</small></span><i className={'compact-dot '+(shot.canonicalRenderId?'good':openTasks.some(task=>task.shotId===shot.id)?'warn':'')}/></button>)}</div>}
      {tool==='review'&&<div className="compact-list">{openTasks.length===0?<span className="muted">No intervention required.</span>:openTasks.map(task=><button key={task.id} className={'compact-list-item '+(task.id===selectedTask?.id?'selected':'')} onClick={()=>{setReviewTaskId(task.id);if(task.shotId)selectShot(task.shotId);setTab('review');}}><span className="compact-mini">!</span><span><strong>{task.title}</strong><small>{task.reason}</small></span><i className="compact-dot warn"/></button>)}</div>}
      {tool==='ai'&&<div className="compact-list"><button className="compact-list-item selected" onClick={()=>setView('storyboard')}><span className="compact-mini">✦</span><span><strong>Proposal</strong><small>story / shots</small></span><i className="compact-dot good"/></button><button className="compact-list-item" onClick={()=>setView('settings')}><span className="compact-mini">↺</span><span><strong>Routing</strong><small>models / local profiles</small></span></button><button className="compact-list-item" onClick={onOpenAdvanced}><span className="compact-mini">⌘</span><span><strong>Pipeline</strong><small>advanced graph</small></span></button></div>}
    </div></aside>

    <main className="compact-viewer"><div className="compact-viewer-head"><span>{selectedShot?'Shot':'Project'} · {selectedShot?.title||project.name}</span><div><button onClick={()=>setView('shots')}>Edit</button><button onClick={onOpenAdvanced}>Flow</button></div></div><div className="compact-stage"><div className="compact-canvas"><span className="compact-preview-badge">{selectedShot?.canonicalRenderId?'CANONICAL':latest?'CANDIDATE':'LOCAL PREVIEW'}</span>
      {latest?.path?<video src={projectMediaUrl(relativeOutput(project.rootPath,latest.path))} controls preload="metadata"/>:previewAsset?<img src={projectMediaUrl(previewAsset.projectPath)} alt=""/>:<div className="compact-placeholder"><b>▱</b><strong>{selectedShot?.title||'No preview yet'}</strong><small>Generate locally when ready</small></div>}
    </div></div><div className="compact-viewer-foot"><button>|◀</button><button>◀</button><button className="compact-play">▶</button><button>▶</button><span>{selectedShot?(selectedShot.generation.frames/Math.max(1,selectedShot.generation.fps)).toFixed(1)+'s':'—'}</span></div></main>

    <aside className="compact-inspector"><div className="compact-ins-tabs"><button className={tab==='edit'?'active':''} onClick={()=>setTab('edit')}>Edit</button><button className={tab==='ai'?'active':''} onClick={()=>setTab('ai')}>AI</button><button className={(tab==='review'?'active ':'')+(selectedTask?'attention':'')} onClick={()=>setTab('review')}>Review</button><button className={tab==='info'?'active':''} onClick={()=>setTab('info')}>Info</button></div><div className="compact-inspector-head"><strong>{selectedShot?.title||project.name}</strong><button onClick={()=>setView('shots')}>•••</button></div><div className="compact-inspector-body">
      {!selectedShot?<span className="muted">Select a shot.</span>:tab==='edit'?<><div className="compact-group"><span className="compact-group-title">SHOT</span><label>Prompt<textarea value={selectedShot.prompt} onChange={event=>mutateShot(shot=>shot.prompt=event.target.value)}/></label><div className="compact-two"><label>Model<select value={selectedShot.generation.modelFamily} onChange={event=>mutateShot(shot=>{const model=event.target.value as ModelFamily;shot.generation={...shot.generation,...MODEL_DEFAULTS[model],modelFamily:model,seed:shot.generation.seed,negativePrompt:shot.generation.negativePrompt,quality:shot.generation.quality,workflowProfileId:undefined};})}>{MODELS.map(model=><option key={model}>{model}</option>)}</select></label><label>Mode<select value={selectedShot.generation.mode} onChange={event=>mutateShot(shot=>{shot.generation.mode=event.target.value as GenerationMode;shot.generation.workflowProfileId=undefined;})}>{MODES.map(mode=><option key={mode}>{mode}</option>)}</select></label></div></div>
        <div className="compact-group compact-drop-target" onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';}} onDrop={dropAssetOnSelected}><span className="compact-group-title">REFERENCES · DROP ASSET</span><div className="compact-tokens">{selectedShot.characterAssetIds.slice(0,2).map(id=><AssetToken key={id} id={id} assets={project.assets}/>)}{selectedShot.locationAssetId&&<AssetToken id={selectedShot.locationAssetId} assets={project.assets}/>} {(selectedShot.referenceAssetIds??[]).slice(0,2).map(id=><AssetToken key={id} id={id} assets={project.assets}/>)}<button className="compact-token add" onClick={()=>setTool('media')}>＋</button></div></div>
        <div className="compact-group"><span className="compact-group-title">ROUTE</span><div className={'compact-route '+(routeReady?'ready':'warn')}><strong>{route?.name||'No route'}</strong><small>{routeReady?'validated · local · ready':studioWorkflowIssue(route,selectedShot)||'check route'}</small></div></div><div className="compact-group"><button className="compact-generate" disabled={!routeReady||Boolean(automation?.running)} onClick={queueSelected}>Generate shot</button></div></>:tab==='ai'?<>
        <div className="compact-group"><span className="compact-group-title">AI DIRECTOR</span><div className="compact-route ready"><strong>Human edits stay authoritative</strong><small>AI planning lives in Storyboard; production routing stays local.</small></div></div><div className="compact-stack"><button className="compact-secondary" onClick={()=>setView('storyboard')}>Open proposal</button><button className="compact-secondary" onClick={()=>setView('story')}>Story context</button><button className="compact-secondary" onClick={onOpenAdvanced}>Flow</button></div></>:tab==='review'?<>
        {selectedTask?(()=>{const linkedQc=project.qcResults.find(result=>result.humanOverrideTaskId===selectedTask.id);return <div className="compact-review-card"><strong>{selectedTask.title}</strong><small>{selectedTask.reason}</small>{linkedQc&&linkedQc.layer!=='technical'?<div className="compact-review-actions"><button className="fail" onClick={()=>void decideHumanQc(selectedTask.id,'fail')}>Fail</button><button className="pass" onClick={()=>void decideHumanQc(selectedTask.id,'pass')}>Pass</button></div>:<button className="compact-secondary" onClick={onOpenAdvanced}>Open in Flow</button>}</div>;})():<div className="compact-route ready"><strong>{openTasks.length?openTasks.length+' review task(s) waiting':'No Human Review'}</strong><small>{openTasks.length?'Open Review on the left and choose the task you want to decide.':'Automation can continue until a later QC gate needs you.'}</small></div>{openTasks.length>0&&<button className="compact-secondary" onClick={()=>setTool('review')}>Open Review</button>}}
        <div className="compact-group"><span className="compact-group-title">QC</span><div className="compact-tokens"><span className={'compact-token '+(latestQc('technical')?.status==='pass'?'good':'')}>tech {latestQc('technical')?.status||'—'}</span><span className={'compact-token '+(latestQc('visual')?.status==='pass'?'good':'')}>visual {latestQc('visual')?.status||'—'}</span><span className={'compact-token '+(latestQc('semantic')?.status==='pass'?'good':'')}>semantic {latestQc('semantic')?.status||'—'}</span><span className={'compact-token '+(latestQc('continuity')?.status==='pass'?'good':'')}>continuity {latestQc('continuity')?.status||'—'}</span></div></div></>:<>
        <div className="compact-group"><span className="compact-group-title">STATE</span><div className="compact-tokens"><span className="compact-token">{selectedShot.status}</span><span className={'compact-token '+(selectedShot.canonicalRenderId?'good':'')}>{selectedShot.canonicalRenderId?'canonical':'not canonical'}</span><span className="compact-token">{selectedShot.generation.quality}</span></div></div><div className="compact-group"><span className="compact-group-title">PROVENANCE</span><div className="compact-route"><strong>{selectedShot.observedFinalStateId?'Observed final recorded':'Observed final pending'}</strong><small>{selectedShot.actualStartStateId?'actual start linked':'actual start pending'} · {selectedShot.latestAttemptRenderId?'attempt tracked':'no render attempt'}</small></div></div><div className="compact-group"><span className="compact-group-title">PROJECT</span><div className="compact-route"><strong>{canonicalCount}/{shots.length} canonical</strong><small>{openTasks.length} human · {activeJobs.length} active</small></div></div></>}
    </div></aside>

    <footer className="compact-timeline"><div className="compact-timeline-bar"><span>Production timeline</span><div><button onClick={()=>setView('timeline')}>≋ Edit</button><button onClick={onOpenAdvanced}>⌘ Flow</button></div></div><div className="compact-tracks"><div className="compact-track-labels"><span></span><span>SHOTS</span><span>TAKES</span><span>AUDIO</span></div><div className="compact-track-area"><div className="compact-ruler">{Array.from({length:12},(_,i)=><span key={i}>{String(i*5).padStart(2,'0')}</span>)}</div>
      <div className="compact-track">{shots.map((shot,index)=><button key={shot.id} className={'compact-clip '+(shot.id===selectedShot?.id?'selected ':'')+(shot.canonicalRenderId?'canonical':openTasks.some(task=>task.shotId===shot.id)?'review':'')} onClick={()=>chooseShot(shot)} onDoubleClick={()=>setView('shots')}><strong>{String(index+1).padStart(2,'0')} · {shot.title}</strong><small>{(shot.generation.frames/Math.max(1,shot.generation.fps)).toFixed(1)}s</small><em>{shot.canonicalRenderId?'CANON':openTasks.some(task=>task.shotId===shot.id)?'REVIEW':shot.status.toUpperCase()}</em></button>)}</div>
      <div className="compact-track">{selectedShot&&project.renderOutputs.filter(output=>output.shotId===selectedShot.id&&output.mediaType==='video').slice(-8).map(output=><button key={output.id} className={'compact-clip take '+(selectedShot.canonicalRenderId===output.id?'canonical':'')} onClick={onOpenAdvanced}><strong>{output.filename}</strong><small>{selectedShot.canonicalRenderId===output.id?'approved':'candidate'}</small></button>)}</div>
      <div className="compact-track">{project.assets.filter(asset=>asset.kind==='audio').slice(0,5).map(asset=><button key={asset.id} className="compact-clip audio" onClick={()=>setTool('audio')}><strong>{asset.name}</strong><small>local audio</small></button>)}</div>
    </div></div></footer>
  </section>;
}

function Tool({icon,label,active=false,badge,onClick}:{icon:string;label:string;active?:boolean;badge?:number;onClick:()=>void}){return <button className={'compact-tool '+(active?'active':'')} title={label} onClick={onClick}><span>{icon}</span>{badge!=null&&badge>0&&<b>{badge}</b>}<small>{label}</small></button>;}
function AssetToken({id,assets}:{id:string;assets:Asset[]}){const asset=assets.find(item=>item.id===id);return asset?<span className="compact-token good">{asset.name}</span>:null;}
function isVisual(asset:Asset):boolean{return['image','reference','keyframe','character','location','prop','wardrobe'].includes(asset.kind);}
function shotPreviewAsset(assets:Asset[],shot:Shot):Asset|undefined{const ids=[shot.startFrameAssetId,shot.endFrameAssetId,shot.characterAssetIds[0],shot.locationAssetId,shot.referenceAssetIds?.[0],shot.propAssetIds[0]].filter((id):id is string=>Boolean(id));return ids.map(id=>assets.find(asset=>asset.id===id)).find((asset):asset is Asset=>Boolean(asset&&isVisual(asset)));}
function relativeOutput(root:string,path:string):string{const base=root.replace(/\\/g,'/').replace(/\/$/,'');const value=path.replace(/\\/g,'/');return value.startsWith(base+'/')?value.slice(base.length+1):value;}
