import { useEffect, useState } from 'react';
import type { FilmProject, PreflightReport, SystemProbe, WorkstationReadiness } from '../../../shared/types';
import { useAppStore } from '../store';
import { Card, Empty, Page, Pill } from '../components/Ui';

export function Dashboard(){
  const {project,probe,setProbe,setError,setNotice,setQueue,setView}=useAppStore();
  const [report,setReport]=useState<PreflightReport>();
  const [readiness,setReadiness]=useState<WorkstationReadiness>();
  const [checking,setChecking]=useState(false);

  const runProbe=async()=>{
    const requestedProjectId=useAppStore.getState().project?.id;
    try{
      const next=await window.cineforge.system.readiness();
      if(useAppStore.getState().project?.id===requestedProjectId){setReadiness(next);setProbe(next.probe);}
    }catch(e){if(useAppStore.getState().project?.id===requestedProjectId)setError(e instanceof Error?e.message:String(e));}
  };
  const preflight=async()=>{
    if(!project)return;
    try{
      setChecking(true);await useAppStore.getState().persist();
      const baseline=useAppStore.getState(),baselineProject=baseline.project;
      if(!baselineProject||baseline.projectDirty)throw new Error('Project changed while saving. Run preflight again after the current edit/save cycle finishes.');
      const revision=baselineProject.updatedAt,r=await window.cineforge.project.preflight(),current=useAppStore.getState();
      if(!current.project||current.project.id!==baselineProject.id||current.project.updatedAt!==revision||current.projectDirty){
        setReport(undefined);setNotice('Preflight result was discarded because the project changed while checks were running.');return;
      }
      setReport(r);setProbe(r.probe);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setChecking(false);}
  };
  const queueUnrendered=async()=>{
    if(!project)return;
    try{
      await useAppStore.getState().persist();
      const baseline=useAppStore.getState(),baselineProject=baseline.project;
      if(!baselineProject||baseline.projectDirty)throw new Error('Project changed while saving. Finish the current edit/save cycle before batch rendering.');
      const revision=baselineProject.updatedAt,checked=await window.cineforge.project.preflight(),current=useAppStore.getState();
      if(!current.project||current.project.id!==baselineProject.id||current.project.updatedAt!==revision||current.projectDirty){
        setReport(undefined);throw new Error('Project changed while preflight was running. Run the checks again before batch rendering.');
      }
      setReport(checked);setProbe(checked.probe);
      if(!checked.ready){setError('Preflight has blocking errors. Fix them before batch rendering.');return;}
      const ordered=[...current.project.shots].sort((a,b)=>{
        const sa=current.project!.scenes.find(s=>s.id===a.sceneId)?.index??0;
        const sb=current.project!.scenes.find(s=>s.id===b.sceneId)?.index??0;
        return sa-sb||a.index-b.index;
      });
      const snapshot=await window.cineforge.render.enqueueBatch({projectRoot:current.project.rootPath,shotIds:ordered.map(s=>s.id),skipIfRendered:true});
      setQueue(snapshot);setNotice('Queued all unrendered shots with immutable render snapshots.');setView('queue');
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  const projectId=project?.id;
  useEffect(()=>{let disposed=false;const requestedProjectId=projectId;void window.cineforge.system.readiness().then(next=>{if(!disposed&&useAppStore.getState().project?.id===requestedProjectId){setReadiness(next);setProbe(next.probe);}}).catch(e=>{if(!disposed&&useAppStore.getState().project?.id===requestedProjectId)setError(e instanceof Error?e.message:String(e));});return()=>{disposed=true;};},[projectId,setError,setProbe]);

  return <Page title="System & production overview" subtitle="Inspect this workstation before opening a project; project-specific render checks appear once a film is open." actions={<div className="row"><button className="ghost" onClick={runProbe}>Probe system</button><button className="ghost" disabled={!project||checking||project.shots.length===0} onClick={preflight}>{checking?'Checking…':'Run preflight'}</button><button className="primary" disabled={!project||checking||project.shots.length===0} onClick={queueUnrendered}>Render unrendered</button></div>}>
    <div className="grid two">
      <WorkstationCard probe={probe} project={project}/>
      <Card title="Workstation readiness" kicker={readiness?.readyForProduction?'READY':'CHECK BEFORE AUTO RUN'} actions={<button className="ghost" onClick={runProbe}>Refresh</button>}>
        {!readiness?<p className="muted">Run the workstation check to verify GPU, runtime, FFmpeg, workflow qualification, local visual QC, Blender and finishing tools.</p>:<div className="readiness-list">{readiness.items.map(item=><div className={`readiness-item ${item.level}`} key={item.id}><Pill>{item.level}</Pill><div><strong>{item.label}</strong><span>{item.detail}</span>{item.action&&<small>{item.action}</small>}</div></div>)}</div>}
      </Card>
      <Card title="Production rules" kicker="PIPELINE">
        <div className="rules">
          <p><b>Codex = producer/orchestrator.</b> With a project open, hardware context is written under <code>.cineforge/CODEX_MACHINE_CONTEXT.md</code>.</p>
          <p><b>WanGP = production local runtime.</b> Managed profiles can be created directly from its installed model catalog.</p>
          <p><b>Reference first.</b> Character/location/reference/keyframe assets are reusable continuity entities and can be dragged onto shots.</p>
          <p><b>CapCut = finishing NLE.</b> Free / No Pro is the project default; Pro is explicit opt-in and AI credits are a separate opt-in.</p>
          <p><b>Paid wall.</b> Cloud generation endpoints remain blocked; local generation has no per-call API bill.</p>
        </div>
      </Card>
    </div>
    {!project?<Card title="No project open" kicker="READY WHEN YOU ARE"><Empty>Hardware can be inspected now. Create or open a project to run project preflight, plan shots and render.</Empty></Card>:<>
      <div className="metric-grid">
        <Card kicker="STORY" title={String(project.scenes.length)+' scenes'}><strong className="metric">{project.shots.length}</strong><span>shots planned</span></Card>
        <Card kicker="ASSETS" title={String(project.assets.length)+' references'}><strong className="metric">{project.assets.filter(a=>a.kind==='character').length}</strong><span>characters</span></Card>
        <Card kicker="RENDERS" title={String(project.renderOutputs.length)+' outputs'}><strong className="metric">{project.renderJobs.filter(j=>j.status==='done').length}</strong><span>completed jobs</span></Card>
        <Card kicker="PREFLIGHT" title={report?(report.ready?'Ready to render':'Needs attention'):'Not checked'}><strong className="metric">{report?.issues.filter(i=>i.level==='error').length??'—'}</strong><span>blocking issues</span></Card>
      </div>
      {report&&<Card title="Preflight report" kicker={report.ready?'READY':'CHECKS'}>{report.issues.length===0?<div className="preflight-ok">No issues found.</div>:<div className="issue-list">{report.issues.map((issue,i)=><div key={issue.code+'-'+i} className={'issue '+issue.level}><Pill>{issue.level}</Pill><code>{issue.code}</code><span>{issue.message}</span></div>)}</div>}</Card>}
    </>}
  </Page>;
}

function WorkstationCard({probe,project}:{probe?:SystemProbe;project:FilmProject|null}){
  return <Card title="Local workstation" kicker="SYSTEM" actions={probe?.codexContextPath?<button className="ghost" onClick={()=>window.cineforge.system.reveal(probe.codexContextPath!)}>Codex context ↗</button>:undefined}>
    <div className="status-list">
      <div><span>CPU</span><strong>{probe?.cpu?(probe.cpu.model+' · '+String(probe.cpu.physicalCores??'?')+'C/'+probe.cpu.logicalCores+'T'):'—'}</strong></div>
      <div><span>RAM</span><strong>{probe?.memory?((probe.memory.totalMb/1024).toFixed(1)+' GB · '+(probe.memory.freeMb/1024).toFixed(1)+' GB free'):'—'}</strong></div>
      <div><span>GPU</span><strong>{probe?.gpu?.name||'Not detected'}</strong></div>
      <div><span>VRAM</span><strong>{probe?.gpu?.totalVramMb?((probe.gpu.totalVramMb/1024).toFixed(1)+' GB · '+((probe.gpu.freeVramMb||0)/1024).toFixed(1)+' GB free'):'—'}</strong></div>
      <div><span>NVIDIA driver / CUDA</span><strong>{probe?.gpu?.driver||'—'} / {probe?.gpu?.cudaVersion||'—'}</strong></div>
      <div><span>Hardware tier</span><Pill>{probe?.hardwarePlan.tier||'unknown'}</Pill></div>
      <div><span>WanGP production</span><Pill>{probe?.wangp.available?'Ready':probe?.wangp.configured?'Error':'Not configured'}</Pill></div>
      <div><span>WanGP Python / Torch</span><strong>{probe?.wangp.pythonVersion||'—'} / {probe?.wangp.torchVersion||'—'}</strong></div>
      <div><span>FFmpeg / encoder</span><Pill>{probe?.ffmpeg.available&&probe.ffmpeg.encoderAvailable?'Ready':'Check'}</Pill></div>
      <div><span>CapCut</span><Pill>{probe?.capcut.installed?'Installed':'Not installed/detected'}</Pill></div>
      <div><span>CapCut policy</span><Pill>{project?(project.settings.capcut.pro?'Pro':'Free / No Pro'):'No project'}</Pill></div>
      <div><span>CapCut AI credits</span><Pill>{project?.settings.costPolicy.allowCapcutAiCredits?'Allowed':'Disabled'}</Pill></div>
    </div>
    {probe?.hardwarePlan.notes.length?<div className="rules">{probe.hardwarePlan.notes.map((note,i)=><p key={i}>{note}</p>)}</div>:null}
  </Card>;
}
