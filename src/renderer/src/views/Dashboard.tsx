import { useEffect, useState } from 'react';
import type { PreflightReport } from '../../../shared/types';
import { useAppStore } from '../store';
import { Card, Empty, Page, Pill } from '../components/Ui';

export function Dashboard(){
  const {project,probe,setProbe,setError,setNotice,setQueue,setView}=useAppStore();
  const [report,setReport]=useState<PreflightReport>();
  const [checking,setChecking]=useState(false);

  const runProbe=async()=>{
    try{setProbe(await window.cineforge.system.probe());}
    catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  const preflight=async()=>{
    try{setChecking(true);const r=await window.cineforge.project.preflight();setReport(r);setProbe(r.probe);}
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setChecking(false);}
  };
  const queueUnrendered=async()=>{
    if(!project)return;
    try{
      await useAppStore.getState().persist();
      const checked=await window.cineforge.project.preflight();setReport(checked);setProbe(checked.probe);
      if(!checked.ready){setError('Preflight has blocking errors. Fix them before batch rendering.');return;}
      const ordered=[...project.shots].sort((a,b)=>{
        const sa=project.scenes.find(s=>s.id===a.sceneId)?.index??0;
        const sb=project.scenes.find(s=>s.id===b.sceneId)?.index??0;
        return sa-sb||a.index-b.index;
      });
      const snapshot=await window.cineforge.render.enqueueBatch({projectRoot:project.rootPath,shotIds:ordered.map(s=>s.id),skipIfRendered:true});
      setQueue(snapshot);setNotice('Queued all unrendered shots with immutable render snapshots.');setView('queue');
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  useEffect(()=>{if(project)void runProbe();},[project?.id]);

  return <Page title="Production overview" subtitle="Codex reads the machine profile, local AI renders within the detected hardware budget, and CapCut finishes." actions={<div className="row"><button className="ghost" onClick={runProbe}>Probe system</button><button className="ghost" disabled={!project||checking||project.shots.length===0} onClick={preflight}>{checking?'Checking…':'Run preflight'}</button><button className="primary" disabled={!project||checking||project.shots.length===0} onClick={queueUnrendered}>Render unrendered</button></div>}>
    {!project?<Empty>Create or open a project to start.</Empty>:<>
      <div className="metric-grid">
        <Card kicker="STORY" title={${project.scenes.length} scenes}><strong className="metric">{project.shots.length}</strong><span>shots planned</span></Card>
        <Card kicker="ASSETS" title={${project.assets.length} references}><strong className="metric">{project.assets.filter(a=>a.kind==='character').length}</strong><span>characters</span></Card>
        <Card kicker="RENDERS" title={${project.renderOutputs.length} outputs}><strong className="metric">{project.renderJobs.filter(j=>j.status==='done').length}</strong><span>completed jobs</span></Card>
        <Card kicker="PREFLIGHT" title={report?(report.ready?'Ready to render':'Needs attention'):'Not checked'}><strong className="metric">{report?.issues.filter(i=>i.level==='error').length??'—'}</strong><span>blocking issues</span></Card>
      </div>
      <div className="grid two">
        <Card title="Local workstation" kicker="SYSTEM" actions={probe?.codexContextPath?<button className="ghost" onClick={()=>window.cineforge.system.reveal(probe.codexContextPath!)}>Codex context ↗</button>:undefined}>
          <div className="status-list">
            <div><span>CPU</span><strong>{probe?.cpu?${probe.cpu.model} · ${probe.cpu.physicalCores??'?'}C/${probe.cpu.logicalCores}T:'—'}</strong></div>
            <div><span>RAM</span><strong>{probe?.memory?${(probe.memory.totalMb/1024).toFixed(1)} GB · ${(probe.memory.freeMb/1024).toFixed(1)} GB free:'—'}</strong></div>
            <div><span>GPU</span><strong>{probe?.gpu?.name||'Not detected'}</strong></div>
            <div><span>VRAM</span><strong>{probe?.gpu?.totalVramMb?${(probe.gpu.totalVramMb/1024).toFixed(1)} GB · ${((probe.gpu.freeVramMb||0)/1024).toFixed(1)} GB free:'—'}</strong></div>
            <div><span>NVIDIA driver / CUDA</span><strong>{probe?.gpu?.driver||'—'} / {probe?.gpu?.cudaVersion||'—'}</strong></div>
            <div><span>Hardware tier</span><Pill>{probe?.hardwarePlan.tier||'unknown'}</Pill></div>
            <div><span>WanGP production</span><Pill>{probe?.wangp.available?'Ready':probe?.wangp.configured?'Error':'Not configured'}</Pill></div>
            <div><span>WanGP Python / Torch</span><strong>{probe?.wangp.pythonVersion||'—'} / {probe?.wangp.torchVersion||'—'}</strong></div>
            <div><span>FFmpeg / encoder</span><Pill>{probe?.ffmpeg.available&&probe.ffmpeg.encoderAvailable?'Ready':'Check'}</Pill></div>
            <div><span>CapCut</span><Pill>{probe?.capcut.installed?(probe.capcut.configuredTier==='pro'?'Pro detected':'Free detected'):'Not detected'}</Pill></div>
            <div><span>CapCut AI credits</span><Pill>{project.settings.costPolicy.allowCapcutAiCredits?'Allowed':'Disabled'}</Pill></div>
          </div>
          {probe?.hardwarePlan.notes.length?<div className="rules">{probe.hardwarePlan.notes.map((note,i)=><p key={i}>{note}</p>)}</div>:null}
        </Card>
        <Card title="Production rules" kicker="PIPELINE">
          <div className="rules">
            <p><b>Codex = producer/orchestrator.</b> Read <code>.cineforge/CODEX_MACHINE_CONTEXT.md</code> before choosing models, resolution, duration or GPU-heavy tools.</p>
            <p><b>WanGP = production local runtime.</b> Managed profiles can be created directly from its installed model catalog.</p>
            <p><b>Reference first.</b> Character/location/keyframe assets are reusable continuity entities and can be dragged onto shots.</p>
            <p><b>CapCut = finishing NLE.</b> Free / No Pro is the project default; Pro is explicit opt-in and AI credits are a separate opt-in.</p>
            <p><b>Paid wall.</b> Cloud generation endpoints remain blocked; local generation has no per-call API bill.</p>
          </div>
        </Card>
      </div>
      {report&&<Card title="Preflight report" kicker={report.ready?'READY':'CHECKS'}>{report.issues.length===0?<div className="preflight-ok">No issues found.</div>:<div className="issue-list">{report.issues.map((issue,i)=><div key={${issue.code}-${i}} className={`issue ${${issue.level}}><Pill>{issue.level}</Pill><code>{issue.code}</code><span>{issue.message}</span></div>)}</div>}</Card>}
    </>}
  </Page>;
}
