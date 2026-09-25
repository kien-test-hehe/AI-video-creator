import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { MODEL_DEFAULTS } from '../../../shared/defaults';
import { chooseModelForShot } from '../../../shared/routing';
import type { Asset, AssetKind, ContinuityReview, FilmProject, GenerationMode, ModelFamily, PreflightReport, QualityIntent, Shot, WorkflowProfile } from '../../../shared/types';
import { projectMediaUrl } from '../media';
import { autoAssignAssetToShot } from '../asset-assignment';
import { useAppStore, type ViewId } from '../store';
import { Empty, Pill } from '../components/Ui';

type Point={x:number;y:number};
type StudioNodeKind='story'|'assets'|'scene'|'shot'|'workflow'|'queue'|'timeline'|'capcut';
interface StudioNode{id:string;kind:StudioNodeKind;x:number;y:number;width:number;height:number;title:string;subtitle:string;shotId?:string;sceneId?:string;profileId?:string;}
interface StudioEdge{id:string;source:string;target:string;kind?:'primary'|'asset'|'warning';}
interface ViewRect{left:number;top:number;width:number;height:number;}

const MODELS:ModelFamily[]=['ltx-2.5-fast','ltx-2.3','hunyuan-video-1.5','wan-2.2-5b','framepack','custom'];
const MODES:GenerationMode[]=['t2v','i2v','flf2v','ia2v','v2v'];
const QUALITIES:QualityIntent[]=['preview','balanced','hero'];
const ASSET_KINDS:AssetKind[]=['character','location','prop','wardrobe','reference','keyframe','image','video','audio'];
const ACTIVE_JOB_STATUSES=new Set(['queued','preparing','uploading','submitted','running','recovering','stalled','downloading']);

export function Studio(){
  const{project,probe,queue,selectedShotId,selectShot,updateProject,setProject,setQueue,setView,setError,setNotice,setProbe}=useAppStore();
  const projectId=project?.id;
  const[zoom,setZoom]=useState(.78);
  const[locked,setLocked]=useState(false);
  const[assetKind,setAssetKind]=useState<AssetKind|'all'>('all');
  const[importKind,setImportKind]=useState<AssetKind>('reference');
  const[assetSearch,setAssetSearch]=useState('');
  const[preflightBusy,setPreflightBusy]=useState(false);
  const[preflightSummary,setPreflightSummary]=useState('unchecked');
  const[positions,setPositions]=useState<Record<string,Point>>(()=>loadStudioLayout(projectId));
  const[viewRect,setViewRect]=useState<ViewRect>({left:0,top:0,width:1000,height:700});
  const viewportRef=useRef<HTMLDivElement>(null);
  const dragState=useRef<{id:string;pointerId:number;startClient:Point;startNode:Point}|null>(null);
  const panState=useRef<{pointerId:number;startClient:Point;scrollLeft:number;scrollTop:number}|null>(null);

  useEffect(()=>{
    if(!projectId)return;
    const timer=setTimeout(()=>{try{localStorage.setItem(`cineforge:studio-layout:${projectId}`,JSON.stringify(positions));}catch{}},250);
    return()=>clearTimeout(timer);
  },[positions,projectId]);
  useEffect(()=>{
    if(!projectId||probe)return;
    void window.cineforge.system.probe().then(setProbe).catch(error=>setError(error instanceof Error?error.message:String(error)));
  },[probe,projectId,setError,setProbe]);

  const sortedShots=useMemo(()=>{
    if(!project)return[];
    return[...project.shots].sort((a,b)=>{
      const sa=project.scenes.find(s=>s.id===a.sceneId)?.index??0;
      const sb=project.scenes.find(s=>s.id===b.sceneId)?.index??0;
      return sa-sb||a.index-b.index;
    });
  },[project]);

  const selectedShot=project?(project.shots.find(shot=>shot.id===selectedShotId)||sortedShots[0]):undefined;
  const selectedShotIsValid=Boolean(selectedShotId&&sortedShots.some(shot=>shot.id===selectedShotId));
  useEffect(()=>{if((!selectedShotId||!selectedShotIsValid)&&sortedShots[0])selectShot(sortedShots[0].id);},[selectShot,selectedShotId,selectedShotIsValid,sortedShots]);

  const graph=useMemo(()=>{
    if(!project)return{nodes:[] as StudioNode[],edges:[] as StudioEdge[],width:2050,height:900};
    const nodes:StudioNode[]=[];
    const edges:StudioEdge[]=[];
    nodes.push({id:'story',kind:'story',x:40,y:70,width:230,height:132,title:project.story.title||project.name,subtitle:project.story.logline||'Script / story bible'});
    nodes.push({id:'assets',kind:'assets',x:40,y:280,width:230,height:132,title:'Asset Library',subtitle:`${project.assets.length} continuity / media assets`});

    project.scenes.forEach((scene,index)=>{
      const id=`scene:${scene.id}`,y=60+index*155;
      nodes.push({id,kind:'scene',x:330,y,width:245,height:122,title:`Scene ${scene.index} · ${scene.heading}`,subtitle:compact(scene.body,92),sceneId:scene.id});
      edges.push({id:`story-${id}`,source:'story',target:id,kind:'primary'});
    });

    sortedShots.forEach((shot,index)=>{
      const id=`shot:${shot.id}`,y=42+index*158;
      nodes.push({id,kind:'shot',x:670,y,width:280,height:142,title:shot.title,subtitle:compact(shot.prompt||shot.action||'No visual prompt yet.',88),shotId:shot.id});
      edges.push({id:`scene-${shot.id}`,source:`scene:${shot.sceneId}`,target:id,kind:'primary'});
      const route=resolveWorkflow(project.settings.workflowProfiles,shot);
      if(route)edges.push({id:`route-${shot.id}`,source:id,target:`workflow:${route.id}`,kind:'primary'});
    });

    const profiles=project.settings.workflowProfiles;
    profiles.forEach((profile,index)=>{
      const id=`workflow:${profile.id}`,y=42+index*142;
      nodes.push({id,kind:'workflow',x:1080,y,width:285,height:124,title:profile.name,subtitle:`${profile.runtime||'comfyui'} · ${profile.modelFamily} · ${profile.mode}`,profileId:profile.id});
    });
    const unbound=sortedShots.filter(shot=>!resolveWorkflow(profiles,shot));
    if(unbound.length){
      const id='workflow:missing',y=42+profiles.length*142;
      nodes.push({id,kind:'workflow',x:1080,y,width:285,height:124,title:'Unbound shots',subtitle:`${unbound.length} shot(s) have no enabled matching workflow profile`});
      unbound.forEach(shot=>edges.push({id:`missing-${shot.id}`,source:`shot:${shot.id}`,target:id,kind:'warning'}));
    }
    const queueY=Math.max(100,Math.min(520,120+profiles.length*50));
    nodes.push({id:'queue',kind:'queue',x:1490,y:queueY,width:250,height:132,title:'Render Queue',subtitle:`${queue.jobs.filter(job=>ACTIVE_JOB_STATUSES.has(job.status)).length} active · ${queue.jobs.length} total jobs`});
    nodes.push({id:'timeline',kind:'timeline',x:1490,y:queueY+230,width:250,height:132,title:'Timeline',subtitle:`${project.timeline.length} clips in canonical cut`});
    nodes.push({id:'capcut',kind:'capcut',x:1810,y:queueY+230,width:220,height:132,title:'CapCut Finish',subtitle:project.settings.capcut.pro?'Project policy: Pro':'Project policy: Free / No Pro'});

    profiles.filter(profile=>profile.enabled).forEach(profile=>edges.push({id:`profile-queue-${profile.id}`,source:`workflow:${profile.id}`,target:'queue',kind:'primary'}));
    edges.push({id:'queue-timeline',source:'queue',target:'timeline',kind:'primary'});
    edges.push({id:'timeline-capcut',source:'timeline',target:'capcut',kind:'primary'});
    if(selectedShot)edges.push({id:'assets-selected',source:'assets',target:`shot:${selectedShot.id}`,kind:'asset'});

    const workflowRows=profiles.length+(unbound.length?1:0);
    const height=Math.max(900,180+Math.max(project.scenes.length*155,sortedShots.length*158,workflowRows*142));
    return{nodes,edges,width:2070,height};
  },[project,queue.jobs,selectedShot,sortedShots]);

  const nodes=useMemo(()=>graph.nodes.map(node=>({...node,...(positions[node.id]||{})})),[graph.nodes,positions]);
  const nodeMap=useMemo(()=>new Map(nodes.map(node=>[node.id,node])),[nodes]);
  const activeNodeIds=useMemo(()=>{
    const ids=new Set<string>();if(selectedShot){ids.add(`shot:${selectedShot.id}`);ids.add(`scene:${selectedShot.sceneId}`);const route=project?resolveWorkflow(project.settings.workflowProfiles,selectedShot):undefined;if(route)ids.add(`workflow:${route.id}`);}return ids;
  },[project,selectedShot]);

  const updateViewRect=useCallback(()=>{
    const el=viewportRef.current;if(!el)return;
    setViewRect({left:el.scrollLeft/zoom,top:el.scrollTop/zoom,width:el.clientWidth/zoom,height:el.clientHeight/zoom});
  },[zoom]);
  useEffect(()=>{updateViewRect();},[graph.height,graph.width,updateViewRect]);

  const resetLayout=()=>setPositions({});
  const fitAll=()=>{
    const el=viewportRef.current;if(!el)return;
    const next=Math.max(.48,Math.min(1,Math.min((el.clientWidth-30)/graph.width,(el.clientHeight-30)/graph.height)));
    setZoom(next);requestAnimationFrame(()=>{el.scrollTo({left:0,top:0,behavior:'smooth'});});
  };
  const changeZoom=(delta:number)=>setZoom(value=>Math.max(.48,Math.min(1.25,Math.round((value+delta)*100)/100)));

  const beginNodeDrag=(event:ReactPointerEvent<HTMLElement>,node:StudioNode)=>{
    if(locked||event.button!==0)return;
    event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current={id:node.id,pointerId:event.pointerId,startClient:{x:event.clientX,y:event.clientY},startNode:{x:node.x,y:node.y}};
  };
  const moveNode=(event:ReactPointerEvent<HTMLElement>)=>{
    const drag=dragState.current;if(!drag||drag.pointerId!==event.pointerId)return;
    const dx=(event.clientX-drag.startClient.x)/zoom,dy=(event.clientY-drag.startClient.y)/zoom,node=nodeMap.get(drag.id);
    const maxX=Math.max(0,graph.width-(node?.width||220)),maxY=Math.max(0,graph.height-(node?.height||120));
    setPositions(current=>({...current,[drag.id]:{x:Math.min(maxX,Math.max(0,drag.startNode.x+dx)),y:Math.min(maxY,Math.max(0,drag.startNode.y+dy))}}));
  };
  const endNodeDrag=(event:ReactPointerEvent<HTMLElement>)=>{if(dragState.current?.pointerId===event.pointerId)dragState.current=null;};
  const beginPan=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button!==0)return;
    const target=event.target as Element;if(target.closest('.studio-node')||target.closest('.studio-minimap'))return;
    const viewport=viewportRef.current;if(!viewport)return;
    event.currentTarget.setPointerCapture(event.pointerId);panState.current={pointerId:event.pointerId,startClient:{x:event.clientX,y:event.clientY},scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop};
  };
  const movePan=(event:ReactPointerEvent<HTMLDivElement>)=>{const pan=panState.current,viewport=viewportRef.current;if(!pan||pan.pointerId!==event.pointerId||!viewport)return;viewport.scrollLeft=pan.scrollLeft-(event.clientX-pan.startClient.x);viewport.scrollTop=pan.scrollTop-(event.clientY-pan.startClient.y);};
  const endPan=(event:ReactPointerEvent<HTMLDivElement>)=>{if(panState.current?.pointerId===event.pointerId)panState.current=null;};
  const zoomWheel=(event:ReactWheelEvent<HTMLDivElement>)=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();changeZoom(event.deltaY>0?-.06:.06);};

  const importAsset=async()=>{
    if(!project)return;
    try{await useAppStore.getState().persist();const next=await window.cineforge.asset.import(importKind);if(next)setProject(next);}
    catch(error){setError(error instanceof Error?error.message:String(error));}
  };
  const startAssetDrag=(event:DragEvent<HTMLElement>,assetId:string)=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-cineforge-asset',assetId);};
  const startWorkflowDrag=(event:DragEvent<HTMLElement>,profileId:string)=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-cineforge-workflow',profileId);};
  const dropOnShot=(event:DragEvent<HTMLElement>,shotId:string)=>{
    event.preventDefault();if(!project)return;
    const workflowId=event.dataTransfer.getData('application/x-cineforge-workflow');
    if(workflowId){
      const profile=project.settings.workflowProfiles.find(item=>item.id===workflowId),shot=project.shots.find(item=>item.id===shotId);
      if(!profile||!shot)return;
      if(!profile.enabled||!profile.workflowPath||(profile.purpose??'video')!=='video'){setError(`${profile.name} is not an enabled usable video workflow.`);return;}
      updateProject(next=>{const target=next.shots.find(item=>item.id===shotId);if(!target)return;const defaults=MODEL_DEFAULTS[profile.modelFamily];target.generation={...target.generation,...defaults,modelFamily:profile.modelFamily,mode:profile.mode,workflowProfileId:profile.id,seed:target.generation.seed,negativePrompt:target.generation.negativePrompt,quality:target.generation.quality};if(target.status==='draft')target.status='ready';});
      selectShot(shotId);setNotice(`Routed ${shot.title} → ${profile.name}.`);return;
    }
    const assetId=event.dataTransfer.getData('application/x-cineforge-asset');if(!assetId)return;
    const asset=project.assets.find(item=>item.id===assetId),shot=project.shots.find(item=>item.id===shotId);if(!asset||!shot)return;
    let result:{ok:boolean;role:string;message:string}|undefined;
    updateProject(next=>{const target=next.shots.find(item=>item.id===shotId),candidate=next.assets.find(item=>item.id===assetId);if(target&&candidate)result=autoAssignAssetToShot(target,candidate);});
    selectShot(shotId);if(result?.ok)setNotice(`${asset.name} → ${shot.title}: ${result.message}`);else if(result)setError(result.message);
  };

  const runPreflight=async():Promise<PreflightReport|undefined>=>{
    try{setPreflightBusy(true);await useAppStore.getState().persist();const report=await window.cineforge.project.preflight();setProbe(report.probe);const blockers=report.issues.filter(issue=>issue.level==='error').length;setPreflightSummary(report.ready?'ready':`${blockers} blocker${blockers===1?'':'s'}`);if(report.ready)setNotice('Preflight passed.');else setError(`Preflight found ${blockers} blocking issue${blockers===1?'':'s'}. Open System for the full report.`);return report;}
    catch(error){setError(error instanceof Error?error.message:String(error));return undefined;}finally{setPreflightBusy(false);}
  };
  const renderAll=async()=>{
    if(!project||sortedShots.length===0)return;const report=await runPreflight();if(!report?.ready)return;
    try{setQueue(await window.cineforge.render.enqueueBatch({projectRoot:project.rootPath,shotIds:sortedShots.map(shot=>shot.id),skipIfRendered:true}));setNotice('Queued all unrendered shots.');}
    catch(error){setError(error instanceof Error?error.message:String(error));}
  };
  const cancelJob=async(id:string)=>{try{setQueue(await window.cineforge.render.cancel(id));}catch(error){setError(error instanceof Error?error.message:String(error));}};
  const retryJob=async(id:string)=>{try{setQueue(await window.cineforge.render.retry(id));}catch(error){setError(error instanceof Error?error.message:String(error));}};

  const queueSelected=async()=>{
    if(!project||!selectedShot)return;
    try{await useAppStore.getState().persist();setQueue(await window.cineforge.render.enqueue({projectRoot:project.rootPath,shotId:selectedShot.id}));setNotice(`${selectedShot.title} added to the render queue.`);}
    catch(error){setError(error instanceof Error?error.message:String(error));}
  };

  if(!project)return <section className="studio-empty"><Empty>Create or open a project to enter Studio.</Empty></section>;

  const filteredAssets=project.assets.filter(asset=>{
    const kindOk=assetKind==='all'||asset.kind===assetKind;
    const query=assetSearch.trim().toLowerCase();
    return kindOk&&(!query||asset.name.toLowerCase().includes(query)||asset.tags.some(tag=>tag.toLowerCase().includes(query)));
  });
  const latest=selectedShot?.latestRenderId?project.renderOutputs.find(output=>output.id===selectedShot.latestRenderId):undefined;

  return <section className="studio-page">
    <header className="studio-commandbar">
      <div className="studio-command-title"><span className="eyebrow">UNIFIED PRODUCTION WORKSPACE</span><strong>{project.story.title||project.name}</strong></div>
      <div className="studio-hud">
        <Hud label="GPU" value={probe?.gpu?.name?.replace(/^NVIDIA GeForce /,'')||'probe…'} tone={probe?.gpu?'good':'muted'}/>
        <Hud label="VRAM" value={probe?.gpu?.totalVramMb?`${((probe.gpu.freeVramMb??0)/1024).toFixed(1)}/${(probe.gpu.totalVramMb/1024).toFixed(0)} GB`:'—'} tone={probe?.gpu?'good':'muted'}/>
        <Hud label="WanGP" value={probe?.wangp.available?'ready':'check'} tone={probe?.wangp.available?'good':'warn'}/>
        <Hud label="Comfy" value={probe?.comfy.reachable?'online':'optional'} tone={probe?.comfy.reachable?'good':'muted'}/>
        <Hud label="CapCut" value={project.settings.capcut.pro?'Pro':'Free'} tone="muted"/>
        <Hud label="Queue" value={String(queue.jobs.filter(job=>ACTIVE_JOB_STATUSES.has(job.status)).length)} tone={queue.runningJobId?'warn':'muted'}/>
      </div>
      <div className="studio-command-actions">
        <button className="ghost" onClick={()=>changeZoom(-.1)}>−</button><span className="studio-zoom">{Math.round(zoom*100)}%</span><button className="ghost" onClick={()=>changeZoom(.1)}>+</button>
        <button className="ghost" onClick={fitAll}>Fit all</button>
        <button className={locked?'ghost active-toggle':'ghost'} onClick={()=>setLocked(value=>!value)}>{locked?'Unlock nodes':'Lock nodes'}</button>
        <button className="ghost" onClick={resetLayout}>Auto layout</button>
        <button className="ghost" disabled={preflightBusy||sortedShots.length===0} onClick={runPreflight}>{preflightBusy?'Checking…':`Preflight · ${preflightSummary}`}</button>
        <button className="ghost" disabled={sortedShots.length===0||preflightBusy} onClick={renderAll}>Render all</button>
        <button className="primary" disabled={!selectedShot} onClick={queueSelected}>Render selected</button>
      </div>
    </header>

    <div className="studio-layout">
      <aside className="studio-library">
        <div className="studio-panel-head"><div><span className="eyebrow">LIBRARY</span><strong>Assets</strong></div><span>{project.assets.length}</span></div>
        <div className="studio-import-row"><select value={importKind} onChange={event=>setImportKind(event.target.value as AssetKind)}>{ASSET_KINDS.map(kind=><option key={kind}>{kind}</option>)}</select><button className="primary" onClick={importAsset}>Import</button></div>
        <input className="studio-search" value={assetSearch} onChange={event=>setAssetSearch(event.target.value)} placeholder="Search assets / tags…"/>
        <div className="studio-filter-row"><button className={assetKind==='all'?'selected':''} onClick={()=>setAssetKind('all')}>All</button>{(['character','location','prop','keyframe','video','audio'] as const).map(kind=><button className={assetKind===kind?'selected':''} key={kind} onClick={()=>setAssetKind(kind)}>{kind}</button>)}</div>
        <div className="studio-asset-list">{filteredAssets.length===0?<div className="studio-mini-empty">No matching assets.</div>:filteredAssets.map(asset=><article key={asset.id} className="studio-asset" draggable onDragStart={event=>startAssetDrag(event,asset.id)} title="Drag onto a shot node or inspector slot">
          {isVisual(asset)?<img src={projectMediaUrl(asset.projectPath)} alt=""/>:<div className="studio-asset-glyph">{asset.kind==='audio'?'♪':'▶'}</div>}
          <div><strong>{asset.name}</strong><span>{asset.kind}</span><small>{asset.tags.slice(0,2).join(' · ')||'drag to assign'}</small></div><b>⋮⋮</b>
        </article>)}</div>
        <div className="studio-panel-section"><div className="studio-panel-head compact"><div><span className="eyebrow">STRUCTURE</span><strong>Scenes</strong></div><span>{project.scenes.length}</span></div>
          <div className="studio-scene-list">{project.scenes.map(scene=>{const shots=sortedShots.filter(shot=>shot.sceneId===scene.id);return <button key={scene.id} onClick={()=>{const first=shots[0];if(first)selectShot(first.id);scrollToNode(`scene:${scene.id}`,nodeMap,viewportRef.current,zoom);}}><span>{scene.index}</span><div><strong>{scene.heading}</strong><small>{shots.length} shots</small></div></button>;})}</div>
        </div>
        <div className="studio-section-links"><QuickLink label="Story" view="story" setView={setView}/><QuickLink label="Assets" view="assets" setView={setView}/><QuickLink label="Storyboard" view="storyboard" setView={setView}/><QuickLink label="Settings" view="settings" setView={setView}/></div>
      </aside>

      <main className="studio-canvas-panel">
        <div className="studio-canvas-title"><div><span className="eyebrow">PIPELINE GRAPH</span><strong>Story → scenes → shots → workflows → render → edit</strong></div><span>Drag blank canvas to pan · Ctrl/⌘ + wheel zoom · node position is visual only</span></div>
        <div className="studio-viewport" ref={viewportRef} onScroll={updateViewRect} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onWheel={zoomWheel}>
          <div className="studio-world-shell" style={{width:graph.width*zoom,height:graph.height*zoom}}>
            <div className="studio-world" style={{width:graph.width,height:graph.height,transform:`scale(${zoom})`}}>
              <svg className="studio-edges" width={graph.width} height={graph.height} aria-hidden="true">
                {graph.edges.map(edge=><GraphEdge key={edge.id} edge={edge} nodes={nodeMap} active={activeNodeIds.has(edge.source)||activeNodeIds.has(edge.target)}/>)}
              </svg>
              {nodes.map(node=><GraphNode key={node.id} node={node} project={project} selected={node.shotId===selectedShot?.id} active={activeNodeIds.has(node.id)} locked={locked} onPointerDown={beginNodeDrag} onPointerMove={moveNode} onPointerUp={endNodeDrag} onSelectShot={selectShot} onOpen={setView} onDropToShot={dropOnShot} onStartWorkflowDrag={startWorkflowDrag}/>)}
            </div>
          </div>
          <MiniMap nodes={nodes} width={graph.width} height={graph.height} view={viewRect} onNavigate={(x,y)=>{const el=viewportRef.current;if(el)el.scrollTo({left:Math.max(0,(x-viewRect.width/2)*zoom),top:Math.max(0,(y-viewRect.height/2)*zoom),behavior:'smooth'});}}/>
        </div>
      </main>

      <aside className="studio-inspector">
        {!selectedShot?<div className="studio-mini-empty">Select a shot node to inspect it.</div>:<ShotInspector project={project} shot={selectedShot} latestPath={latest?.path} updateProject={updateProject} setView={setView} queueSelected={queueSelected} setError={setError}/>}
      </aside>
    </div>

    <footer className="studio-bottom-dock">
      <section className="studio-dock-block queue-dock"><div className="studio-dock-head"><div><span className="eyebrow">QUEUE</span><strong>{queue.jobs.filter(job=>ACTIVE_JOB_STATUSES.has(job.status)).length} active / {queue.jobs.length} total</strong></div><button className="ghost" onClick={()=>setView('queue')}>Open queue ↗</button></div>
        <div className="studio-job-strip">{queue.jobs.length===0?<span className="muted">Nothing queued.</span>:queue.jobs.map(job=>{const shot=project.shots.find(item=>item.id===job.shotId),active=ACTIVE_JOB_STATUSES.has(job.status),retryable=['failed','cancelled','orphaned'].includes(job.status);return <div className="studio-job" key={job.id}><span className={`job-dot ${job.status}`}/><div><strong>{shot?.title||job.shotId}</strong><small>{job.status} · {Math.round(job.progress*100)}%</small></div><div className="studio-job-progress"><i style={{width:`${Math.round(job.progress*100)}%`}}/></div>{active?<button className="studio-job-action" title="Cancel job" onClick={()=>cancelJob(job.id)}>×</button>:retryable?<button className="studio-job-action" title="Retry exact job" onClick={()=>retryJob(job.id)}>↻</button>:null}</div>;})}</div>
      </section>
      <section className="studio-dock-block timeline-dock"><div className="studio-dock-head"><div><span className="eyebrow">TIMELINE</span><strong>{project.timeline.length} clips</strong></div><button className="ghost" onClick={()=>setView('timeline')}>Open timeline ↗</button></div>
        <div className="studio-timeline-strip">{project.timeline.length===0?<span className="muted">Build a cut from rendered takes.</span>:[...project.timeline].sort((a,b)=>a.order-b.order).map((clip,index)=>{const shot=project.shots.find(item=>item.id===clip.shotId);return <button key={clip.id} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-cineforge-timeline-clip',clip.id);}} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='move';}} onDrop={event=>{event.preventDefault();const sourceId=event.dataTransfer.getData('application/x-cineforge-timeline-clip');if(sourceId)reorderTimeline(project,sourceId,clip.id,updateProject);}} onClick={()=>{if(shot){selectShot(shot.id);scrollToNode(`shot:${shot.id}`,nodeMap,viewportRef.current,zoom);}}}><span>{index+1}</span><strong>{shot?.title||'Shot'}</strong><small>{shot?`${(shot.generation.frames/shot.generation.fps).toFixed(1)}s`:'—'}</small></button>;})}</div>
      </section>
    </footer>
  </section>;
}

function GraphNode({node,project,selected,active,locked,onPointerDown,onPointerMove,onPointerUp,onSelectShot,onOpen,onDropToShot,onStartWorkflowDrag}:{node:StudioNode;project:FilmProject;selected:boolean;active:boolean;locked:boolean;onPointerDown:(event:ReactPointerEvent<HTMLElement>,node:StudioNode)=>void;onPointerMove:(event:ReactPointerEvent<HTMLElement>)=>void;onPointerUp:(event:ReactPointerEvent<HTMLElement>)=>void;onSelectShot:(id?:string)=>void;onOpen:(view:ViewId)=>void;onDropToShot:(event:DragEvent<HTMLElement>,shotId:string)=>void;onStartWorkflowDrag:(event:DragEvent<HTMLElement>,profileId:string)=>void}){
  const shot=node.shotId?project.shots.find(item=>item.id===node.shotId):undefined;
  const profile=node.profileId?project.settings.workflowProfiles.find(item=>item.id===node.profileId):undefined;
  const route=shot?resolveWorkflow(project.settings.workflowProfiles,shot):undefined;
  const className=['studio-node',`node-${node.kind}`,selected?'selected':'',active?'on-path':'',locked?'locked':''].filter(Boolean).join(' ');
  const openView:Partial<Record<StudioNodeKind,ViewId>>={story:'story',assets:'assets',scene:'storyboard',shot:'shots',workflow:'settings',queue:'queue',timeline:'timeline',capcut:'finishing'};
  return <article className={className} style={{left:node.x,top:node.y,width:node.width,minHeight:node.height}} onDragOver={shot?event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';}:undefined} onDrop={shot?event=>onDropToShot(event,shot.id):undefined}>
    <header className="studio-node-drag" onPointerDown={event=>onPointerDown(event,node)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <span className="studio-node-kind">{node.kind}</span><span>{locked?'●':'⠿'}</span>
    </header>
    <button className="studio-node-body" draggable={Boolean(profile)} title={profile?'Drag this workflow onto a shot to route it.':shot?'Drop assets or workflows here.':undefined} onDragStart={profile?event=>{event.stopPropagation();onStartWorkflowDrag(event,profile.id);}:undefined} onClick={()=>{if(shot)onSelectShot(shot.id);else if(openView[node.kind])onOpen(openView[node.kind]!);}}>
      <strong>{node.title}</strong><small>{node.subtitle}</small>
      {shot&&<div className="studio-node-meta"><Pill>{shot.status}</Pill>{!route?<Pill>no route</Pill>:route.validation?.structuralStatus!=='valid'?<Pill>route {route.validation?.structuralStatus||'unvalidated'}</Pill>:null}<span>{shot.generation.modelFamily}</span><span>{shot.generation.mode}</span></div>}
      {shot&&<div className="studio-ref-meter"><span>C{shot.characterAssetIds.length}</span><span>{shot.locationAssetId?'LOC':'NO LOC'}</span><span>R{shot.propAssetIds.length}</span><span>{shot.startFrameAssetId?'START':'—'}</span><span>{shot.endFrameAssetId?'END':'—'}</span></div>}
      {profile&&<div className="studio-node-meta"><Pill>{profile.enabled?'enabled':'off'}</Pill><span>{profile.validation?.structuralStatus||'unvalidated'}</span></div>}
      {node.kind==='queue'&&<div className="studio-node-meta"><span>{project.renderJobs.filter(job=>job.status==='done').length} completed</span><span>{project.renderOutputs.length} outputs</span></div>}
      {node.kind==='timeline'&&<div className="studio-node-meta"><span>{project.timeline.length} clips</span><span>{project.renderOutputs.filter(output=>output.mediaType==='video').length} takes</span></div>}
    </button>
  </article>;
}

function GraphEdge({edge,nodes,active}:{edge:StudioEdge;nodes:Map<string,StudioNode>;active:boolean}){
  const source=nodes.get(edge.source),target=nodes.get(edge.target);if(!source||!target)return null;
  const sx=source.x+source.width,sy=source.y+source.height/2,tx=target.x,ty=target.y+target.height/2;
  const bend=Math.max(54,(tx-sx)*.45);
  return <path className={['studio-edge',edge.kind||'primary',active?'active':''].join(' ')} d={`M ${sx} ${sy} C ${sx+bend} ${sy}, ${tx-bend} ${ty}, ${tx} ${ty}`}/>;
}

function ShotInspector({project,shot,latestPath,updateProject,setView,queueSelected,setError}:{project:FilmProject;shot:Shot;latestPath?:string;updateProject:(mutator:(project:FilmProject)=>void)=>void;setView:(view:ViewId)=>void;queueSelected:()=>Promise<void>;setError:(error?:string)=>void}){
  const{setProject,setNotice}=useAppStore();
  const[continuityBusy,setContinuityBusy]=useState(false);
  const[continuityReview,setContinuityReview]=useState<ContinuityReview>();
  const[keyframeBusy,setKeyframeBusy]=useState<'start'|'end'|null>(null);
  const[keyframeProfileId,setKeyframeProfileId]=useState('');
  const mutate=(fn:(shot:Shot)=>void)=>updateProject(next=>{const target=next.shots.find(item=>item.id===shot.id);if(target)fn(target);});
  const matching=project.settings.workflowProfiles.filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.modelFamily===shot.generation.modelFamily&&profile.mode===shot.generation.mode&&profile.workflowPath);
  const route=resolveWorkflow(project.settings.workflowProfiles,shot);
  const imageProfiles=project.settings.workflowProfiles.filter(profile=>profile.enabled&&(profile.purpose??'video')==='image'&&profile.workflowPath);
  const activeKeyframeProfileId=imageProfiles.some(profile=>profile.id===keyframeProfileId)?keyframeProfileId:(imageProfiles[0]?.id||'');
  const changeModel=(model:ModelFamily)=>mutate(target=>{const defaults=MODEL_DEFAULTS[model];target.generation={...target.generation,...defaults,modelFamily:model,seed:target.generation.seed,negativePrompt:target.generation.negativePrompt,quality:target.generation.quality,workflowProfileId:undefined};});
  const reviewContinuity=async()=>{try{setContinuityBusy(true);await useAppStore.getState().persist();setContinuityReview(await window.cineforge.director.reviewShot(shot.id));}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setContinuityBusy(false);}};
  const generateKeyframe=async(role:'start'|'end')=>{if(!activeKeyframeProfileId){setError('No enabled image workflow is available for keyframe generation.');return;}try{setKeyframeBusy(role);await useAppStore.getState().persist();const next=await window.cineforge.keyframe.generate({projectRoot:project.rootPath,shotId:shot.id,role,workflowProfileId:activeKeyframeProfileId});setProject(next);setNotice(`${role==='start'?'Start':'End'} keyframe generated for ${shot.title}.`);}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setKeyframeBusy(null);}};
  const dropRole=(event:DragEvent<HTMLElement>,role:'character'|'location'|'prop'|'start'|'end'|'video'|'audio')=>{
    event.preventDefault();const assetId=event.dataTransfer.getData('application/x-cineforge-asset'),asset=project.assets.find(item=>item.id===assetId);if(!asset)return;
    const allowed=role==='character'?asset.kind==='character':role==='location'?asset.kind==='location':role==='prop'?['prop','wardrobe','reference'].includes(asset.kind):role==='start'?['image','reference','keyframe','character','location'].includes(asset.kind):role==='end'?['image','reference','keyframe'].includes(asset.kind):role==='video'?asset.kind==='video':asset.kind==='audio';
    if(!allowed){setError(`${asset.name} (${asset.kind}) cannot be assigned to ${role}.`);return;}
    if(role==='character'&&!shot.characterAssetIds.includes(asset.id)&&shot.characterAssetIds.length>=4){setError('This shot already has the maximum of 4 character references.');return;}
    if(role==='prop'&&!shot.propAssetIds.includes(asset.id)&&shot.propAssetIds.length>=2){setError('This shot already has the maximum of 2 prop / wardrobe references.');return;}
    mutate(target=>{
      if(role==='character'&&!target.characterAssetIds.includes(asset.id))target.characterAssetIds.push(asset.id);
      else if(role==='location')target.locationAssetId=asset.id;
      else if(role==='prop'&&!target.propAssetIds.includes(asset.id))target.propAssetIds.push(asset.id);
      else if(role==='start')target.startFrameAssetId=asset.id;
      else if(role==='end')target.endFrameAssetId=asset.id;
      else if(role==='video')target.referenceVideoAssetId=asset.id;
      else if(role==='audio')target.audioAssetId=asset.id;
      if(target.status==='draft')target.status='ready';
    });
  };
  return <div className="studio-inspector-scroll">
    <div className="studio-inspector-head"><div><span className="eyebrow">SHOT INSPECTOR</span><strong>{shot.title}</strong></div><button className="ghost" onClick={()=>setView('shots')}>Full workshop ↗</button></div>
    {latestPath&&<video className="studio-latest-video" src={projectMediaUrl(relativeOutput(project.rootPath,latestPath))} controls preload="metadata"/>}
    <div className="studio-inspector-actions"><button className="ghost" onClick={()=>changeModel(chooseModelForShot(shot))}>Auto route</button><button className="ghost" disabled={continuityBusy} onClick={reviewContinuity}>{continuityBusy?'Reviewing…':'Continuity review'}</button></div>
    <div className={`studio-route-status ${route?.validation?.structuralStatus==='valid'?'ready':route?'warn':'bad'}`}><span>VIDEO ROUTE</span><strong>{route?.name||'No enabled matching workflow'}</strong><small>{route?route.validation?.structuralStatus||'unvalidated':'Open Settings or use Auto-setup WanGP profiles'}</small></div>
    {continuityReview&&<div className="studio-continuity-result"><div className="studio-panel-head compact"><strong>Continuity review</strong><button className="mini" onClick={()=>setContinuityReview(undefined)}>×</button></div>{continuityReview.issues.length?<ul>{continuityReview.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>:<p>No concrete continuity issue found.</p>}{continuityReview.promptAddendum&&<button className="ghost" onClick={()=>mutate(target=>target.prompt=[target.prompt,continuityReview.promptAddendum].filter(Boolean).join('\n'))}>Append prompt suggestion</button>}{continuityReview.suggestedContinuityNotes&&<button className="ghost" onClick={()=>mutate(target=>target.continuityNotes=[target.continuityNotes,continuityReview.suggestedContinuityNotes].filter(Boolean).join('\n'))}>Append continuity notes</button>}</div>}
    <label>Title<input value={shot.title} onChange={event=>mutate(target=>target.title=event.target.value)}/></label>
    <label>Visual prompt<textarea className="studio-prompt" value={shot.prompt} onChange={event=>mutate(target=>target.prompt=event.target.value)}/></label>
    <div className="form-grid two-col"><label>Camera<input value={shot.camera} onChange={event=>mutate(target=>target.camera=event.target.value)}/></label><label>Quality<select value={shot.generation.quality} onChange={event=>mutate(target=>target.generation.quality=event.target.value as QualityIntent)}>{QUALITIES.map(item=><option key={item}>{item}</option>)}</select></label></div>
    <div className="form-grid two-col"><label>Model<select value={shot.generation.modelFamily} onChange={event=>changeModel(event.target.value as ModelFamily)}>{MODELS.map(item=><option key={item}>{item}</option>)}</select></label><label>Mode<select value={shot.generation.mode} onChange={event=>mutate(target=>{target.generation.mode=event.target.value as GenerationMode;target.generation.workflowProfileId=undefined;})}>{MODES.map(item=><option key={item}>{item}</option>)}</select></label></div>
    <label>Workflow<select value={shot.generation.workflowProfileId||''} onChange={event=>mutate(target=>target.generation.workflowProfileId=event.target.value||undefined)}><option value="">Auto matching route</option>{matching.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.validation?.structuralStatus||'unvalidated'}</option>)}</select></label>
    <div className="studio-inline-numbers"><NumberField label="W" value={shot.generation.width} set={value=>mutate(target=>target.generation.width=value)}/><NumberField label="H" value={shot.generation.height} set={value=>mutate(target=>target.generation.height=value)}/><NumberField label="Frames" value={shot.generation.frames} set={value=>mutate(target=>target.generation.frames=value)}/><NumberField label="FPS" value={shot.generation.fps} set={value=>mutate(target=>target.generation.fps=value)}/></div>
    <div className="studio-inline-numbers three"><NumberField label="Steps" value={shot.generation.steps||0} set={value=>mutate(target=>target.generation.steps=value)}/><NumberField label="CFG" value={shot.generation.cfg||0} step={.1} set={value=>mutate(target=>target.generation.cfg=value)}/><NumberField label="Seed" value={shot.generation.seed} set={value=>mutate(target=>target.generation.seed=Math.max(0,Math.floor(value)))}/></div>
    <label>Negative prompt<textarea className="short" value={shot.generation.negativePrompt} onChange={event=>mutate(target=>target.generation.negativePrompt=event.target.value)}/></label>
    <label className="check studio-audio-check"><input type="checkbox" checked={shot.generation.includeAudio} onChange={event=>mutate(target=>target.generation.includeAudio=event.target.checked)}/>Audio when supported · nominal {(shot.generation.frames/Math.max(1,shot.generation.fps)).toFixed(1)}s</label>

    <div className="studio-keyframe-tools"><span className="eyebrow">KEYFRAMES</span><select value={activeKeyframeProfileId} onChange={event=>setKeyframeProfileId(event.target.value)}><option value="">Image workflow…</option>{imageProfiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.validation?.structuralStatus||'unvalidated'}</option>)}</select><div className="row"><button className="ghost" disabled={!activeKeyframeProfileId||Boolean(keyframeBusy)} onClick={()=>generateKeyframe('start')}>{keyframeBusy==='start'?'Generating…':'Generate start'}</button><button className="ghost" disabled={!activeKeyframeProfileId||Boolean(keyframeBusy)} onClick={()=>generateKeyframe('end')}>{keyframeBusy==='end'?'Generating…':'Generate end'}</button></div></div>
    <div className="studio-inspector-section"><span className="eyebrow">CONTINUITY · DROP ASSETS</span>
      <DropSlot label="Characters" ids={shot.characterAssetIds} project={project} onDrop={event=>dropRole(event,'character')} clear={id=>mutate(target=>target.characterAssetIds=target.characterAssetIds.filter(item=>item!==id))}/>
      <DropSlot label="Location" ids={shot.locationAssetId?[shot.locationAssetId]:[]} project={project} onDrop={event=>dropRole(event,'location')} clear={()=>mutate(target=>target.locationAssetId=undefined)}/>
      <DropSlot label="Props / wardrobe" ids={shot.propAssetIds} project={project} onDrop={event=>dropRole(event,'prop')} clear={id=>mutate(target=>target.propAssetIds=target.propAssetIds.filter(item=>item!==id))}/>
      <div className="studio-slot-grid"><DropSlot label="Start frame" ids={shot.startFrameAssetId?[shot.startFrameAssetId]:[]} project={project} onDrop={event=>dropRole(event,'start')} clear={()=>mutate(target=>target.startFrameAssetId=undefined)}/><DropSlot label="End frame" ids={shot.endFrameAssetId?[shot.endFrameAssetId]:[]} project={project} onDrop={event=>dropRole(event,'end')} clear={()=>mutate(target=>target.endFrameAssetId=undefined)}/></div>
      <div className="studio-slot-grid"><DropSlot label="Motion video" ids={shot.referenceVideoAssetId?[shot.referenceVideoAssetId]:[]} project={project} onDrop={event=>dropRole(event,'video')} clear={()=>mutate(target=>target.referenceVideoAssetId=undefined)}/><DropSlot label="Input audio" ids={shot.audioAssetId?[shot.audioAssetId]:[]} project={project} onDrop={event=>dropRole(event,'audio')} clear={()=>mutate(target=>target.audioAssetId=undefined)}/></div>
    </div>
    <label>Action<textarea className="short" value={shot.action} onChange={event=>mutate(target=>target.action=event.target.value)}/></label>
    <label>Dialogue / sound<textarea className="short" value={shot.dialogue} onChange={event=>mutate(target=>target.dialogue=event.target.value)}/></label>
    <label>Continuity notes<textarea className="short" value={shot.continuityNotes} onChange={event=>mutate(target=>target.continuityNotes=event.target.value)}/></label>
    <button className="primary studio-render-button" onClick={queueSelected}>Queue render</button>
  </div>;
}

function DropSlot({label,ids,project,onDrop,clear}:{label:string;ids:string[];project:FilmProject;onDrop:(event:DragEvent<HTMLElement>)=>void;clear:(id:string)=>void}){
  const assets=ids.map(id=>project.assets.find(asset=>asset.id===id)).filter((asset):asset is Asset=>Boolean(asset));
  return <section className="studio-drop-slot" onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';}} onDrop={onDrop}><span>{label}</span>{assets.length===0?<small>Drop here</small>:<div className="studio-slot-assets">{assets.map(asset=><button key={asset.id} title="Remove" onClick={()=>clear(asset.id)}>{isVisual(asset)?<img src={projectMediaUrl(asset.projectPath)} alt=""/>:<b>{asset.kind==='audio'?'♪':'▶'}</b>}<em>{asset.name}</em><i>×</i></button>)}</div>}</section>;
}

function MiniMap({nodes,width,height,view,onNavigate}:{nodes:StudioNode[];width:number;height:number;view:ViewRect;onNavigate:(x:number,y:number)=>void}){
  return <button className="studio-minimap" aria-label="Pipeline minimap" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();onNavigate((event.clientX-rect.left)/rect.width*width,(event.clientY-rect.top)/rect.height*height);}}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">{nodes.map(node=><rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} className={`mini-${node.kind}`}/>)}
      <rect className="mini-viewport" x={view.left} y={view.top} width={view.width} height={view.height}/>
    </svg>
  </button>;
}

function Hud({label,value,tone}:{label:string;value:string;tone:'good'|'warn'|'muted'}){return <span className={`studio-hud-item ${tone}`}><small>{label}</small><strong>{value}</strong></span>;}
function QuickLink({label,view,setView}:{label:string;view:ViewId;setView:(view:ViewId)=>void}){return <button onClick={()=>setView(view)}>{label}<span>↗</span></button>;}
function NumberField({label,value,set,step=1}:{label:string;value:number;set:(value:number)=>void;step?:number}){return <label>{label}<input type="number" step={step} value={value} onChange={event=>set(Number(event.target.value)||0)}/></label>;}
function isVisual(asset:Asset):boolean{return['image','reference','keyframe','character','location','prop','wardrobe'].includes(asset.kind);}
function compact(value:string,max:number):string{const clean=value.replace(/\s+/g,' ').trim();return clean.length>max?`${clean.slice(0,max-1)}…`:clean;}
function relativeOutput(root:string,path:string):string{const base=root.replace(/\\/g,'/').replace(/\/$/,'');const value=path.replace(/\\/g,'/');return value.startsWith(`${base}/`)?value.slice(base.length+1):value;}
function resolveWorkflow(profiles:WorkflowProfile[],shot:Shot):WorkflowProfile|undefined{
  const explicit=shot.generation.workflowProfileId?profiles.find(profile=>profile.id===shot.generation.workflowProfileId&&profile.enabled):undefined;
  return explicit||profiles.find(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.modelFamily===shot.generation.modelFamily&&profile.mode===shot.generation.mode&&profile.workflowPath);
}
function scrollToNode(id:string,nodes:Map<string,StudioNode>,viewport:HTMLDivElement|null,zoom:number):void{
  const node=nodes.get(id);if(!node||!viewport)return;
  viewport.scrollTo({left:Math.max(0,(node.x-node.width)*zoom),top:Math.max(0,(node.y-120)*zoom),behavior:'smooth'});
}

function reorderTimeline(project:FilmProject,sourceId:string,targetId:string,updateProject:(mutator:(project:FilmProject)=>void)=>void):void{
  if(sourceId===targetId||!project.timeline.some(clip=>clip.id===sourceId)||!project.timeline.some(clip=>clip.id===targetId))return;
  updateProject(next=>{const ordered=[...next.timeline].sort((a,b)=>a.order-b.order);const from=ordered.findIndex(clip=>clip.id===sourceId),to=ordered.findIndex(clip=>clip.id===targetId);if(from<0||to<0)return;const[moved]=ordered.splice(from,1);ordered.splice(to,0,moved);ordered.forEach((clip,index)=>clip.order=index);next.timeline=ordered;});
}

function loadStudioLayout(projectId?:string):Record<string,Point>{
  if(!projectId)return{};
  try{
    const raw=localStorage.getItem(`cineforge:studio-layout:${projectId}`);if(!raw)return{};
    const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return{};
    const clean:Record<string,Point>={};
    for(const[id,value]of Object.entries(parsed as Record<string,unknown>)){
      if(!value||typeof value!=='object'||Array.isArray(value)||id.length>200)continue;
      const point=value as Record<string,unknown>,x=Number(point.x),y=Number(point.y);
      if(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=20_000&&y<=20_000)clean[id]={x,y};
    }
    return clean;
  }catch{return{};}
}
