import { useState, type DragEvent } from 'react';
import type { TimelineClip } from '../../../shared/types';
import { useAppStore } from '../store';
import { Card, Empty, Page, Pill } from '../components/Ui';
import { projectMediaUrl } from '../media';
import { insertTimelineOutput, reorderTimeline } from '../studio-logic';
import { takeUseConfirmationMessage } from '../../../shared/take-policy';

export function Timeline(){
  const{project,updateProject,setError,setNotice,setBusy}=useAppStore();
  const[exporting,setExporting]=useState(false);
  if(!project)return <Page title="Timeline"><Empty>Open a project first.</Empty></Page>;

  const videoOutputs=project.renderOutputs.filter(output=>output.mediaType==='video');
  const confirmTake=(outputId:string):boolean=>{
    const output=project.renderOutputs.find(item=>item.id===outputId);if(!output)return false;
    const message=takeUseConfirmationMessage(output,'timeline');
    return !message||window.confirm(message);
  };
  const add=(outputId:string)=>{if(!confirmTake(outputId))return;updateProject(next=>{insertTimelineOutput(next,outputId);});};
  const remove=(id:string)=>updateProject(next=>{const removed=next.timeline.find(clip=>clip.id===id);next.timeline=next.timeline.filter(clip=>clip.id!==id);if(removed){next.timeline.filter(clip=>clip.track===removed.track).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).forEach((clip,order)=>clip.order=order);}});
  const move=(id:string,delta:number)=>updateProject(next=>{
    const clip=next.timeline.find(item=>item.id===id);if(!clip)return;
    const ordered=next.timeline.filter(item=>item.track===clip.track).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)),index=ordered.findIndex(item=>item.id===id),target=index+delta;
    if(index<0||target<0||target>=ordered.length)return;
    [ordered[index],ordered[target]]=[ordered[target],ordered[index]];ordered.forEach((item,order)=>item.order=order);
  });
  const patch=(id:string,fn:(clip:TimelineClip)=>void)=>updateProject(next=>{const clip=next.timeline.find(item=>item.id===id);if(clip)fn(clip);});
  const dropClip=(event:DragEvent<HTMLElement>,targetId:string)=>{
    event.preventDefault();event.stopPropagation();
    const outputId=event.dataTransfer.getData('application/x-cineforge-render-output');
    if(outputId){if(!confirmTake(outputId))return;updateProject(next=>{insertTimelineOutput(next,outputId,targetId);});setNotice('Inserted rendered take into the timeline.');return;}
    const sourceId=event.dataTransfer.getData('application/x-cineforge-timeline-clip');
    if(sourceId){
      const source=project.timeline.find(clip=>clip.id===sourceId),target=project.timeline.find(clip=>clip.id===targetId);
      if(!source||!target)return;
      if(source.track!==target.track){setError('Timeline clips can only be reordered within the same track.');return;}
      updateProject(next=>{reorderTimeline(next,sourceId,targetId);});
    }
  };
  const dropTrack=(event:DragEvent<HTMLElement>)=>{
    const outputId=event.dataTransfer.getData('application/x-cineforge-render-output');if(!outputId)return;
    event.preventDefault();if(!confirmTake(outputId))return;updateProject(next=>{insertTimelineOutput(next,outputId);});setNotice('Added rendered take to the end of the timeline.');
  };

  const buildLatestCut=()=>{
    const ordered=[...project.shots].sort((a,b)=>{
      const sa=project.scenes.find(scene=>scene.id===a.sceneId)?.index??0;
      const sb=project.scenes.find(scene=>scene.id===b.sceneId)?.index??0;
      return sa-sb||a.index-b.index;
    });
    const skipped:string[]=[];
    const selected=ordered.map(shot=>{
      const candidates=[...project.renderOutputs].filter(output=>output.shotId===shot.id&&output.mediaType==='video').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      const preferred=shot.latestRenderId?candidates.find(output=>output.id===shot.latestRenderId&&output.technicalQc?.passed===true):undefined;
      const passing=preferred||candidates.find(output=>output.technicalQc?.passed===true);
      if(!passing&&candidates.length)skipped.push(shot.title);
      return{shot,output:passing};
    }).filter((item):item is {shot:(typeof project.shots)[number];output:(typeof project.renderOutputs)[number]}=>Boolean(item.output));
    if(!selected.length){setError('No QC-passing rendered video takes are available yet. Review failed/unknown takes manually if you intend to use them.');return;}
    if(skipped.length&&!window.confirm(`Build the cut without ${skipped.length} shot(s) that have no QC-passing take?\n\n${skipped.slice(0,12).join('\n')}${skipped.length>12?'\n…':''}`))return;
    if(project.timeline.length&&!window.confirm('Replace the current timeline with the preferred/latest take for each rendered shot?'))return;
    updateProject(next=>{next.timeline=selected.map((item,order)=>({id:crypto.randomUUID(),shotId:item.shot.id,renderOutputId:item.output.id,track:0,order,trimInSec:0,volume:1}));});
    setNotice(`Built a ${selected.length}-shot master cut from preferred/latest takes.`);
  };

  const exportFilm=async()=>{
    try{
      setExporting(true);setBusy(true);await useAppStore.getState().persist();
      const result=await window.cineforge.timeline.export();if(result)setNotice(`Exported: ${result.outputPath}`);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(!/cancelled/i.test(message))setError(message);else setNotice('Timeline export cancelled.');
}finally{setExporting(false);setBusy(false);}
  };
  const cancelExport=async()=>{try{await window.cineforge.timeline.cancelExport();}catch(error){setError(error instanceof Error?error.message:String(error));}};

  return <Page title="Timeline" subtitle="Drag rendered takes into the main track, reorder clips, trim against real media duration, balance audio and export a deterministic local master." actions={<div className="row"><button className="ghost" onClick={buildLatestCut} disabled={videoOutputs.length===0||exporting}>Build latest cut</button>{exporting?<button className="ghost danger" onClick={cancelExport}>Cancel export</button>:<button className="primary" onClick={exportFilm} disabled={project.timeline.length===0}>Export master</button>}</div>}>
    <div className="grid timeline-grid">
      <Card title="Available takes" kicker="RENDERS">
        {videoOutputs.length===0?<Empty>Render a shot to create takes.</Empty>:<div className="take-list">{videoOutputs.map(output=>{
          const shot=project.shots.find(item=>item.id===output.shotId),duration=output.technicalQc?.durationSec;
          return <div className="take-card" key={output.id} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-cineforge-render-output',output.id);}}>
            <video src={projectMediaUrl(projectRelativeOutput(project.rootPath,output.path))} muted controls preload="none"/>
            <button onClick={()=>add(output.id)} title={output.technicalQc&&!output.technicalQc.passed?'QC failed: review before using this take.':'Add this take to the end of the timeline'}><span>{shot?.title||'Shot'}</span><small>{output.filename}{duration?` · ${duration.toFixed(2)}s`:''}{output.technicalQc?(output.technicalQc.passed?(output.technicalQc.warnings?.length?` · QC pass/${output.technicalQc.warnings.length} warn`:' · QC pass'):' · QC FAIL'):' · QC unknown'}</small><b>+</b></button>
          </div>;
        })}</div>}
      </Card>
      <Card title="Canonical tracks" kicker="EDIT">
        <div className="timeline-drop-surface" onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-cineforge-render-output')){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDrop={dropTrack}>
          {project.timeline.length===0?<Empty>Drag a rendered take here or add one from the left.</Empty>:<div className="timeline-track">{[...project.timeline].sort((a,b)=>a.track-b.track||a.order-b.order||a.id.localeCompare(b.id)).map((clip,index)=>{
            const shot=project.shots.find(item=>item.id===clip.shotId),output=project.renderOutputs.find(item=>item.id===clip.renderOutputId);
            const duration=output?.technicalQc?.durationSec??Math.max(.01,(shot?.generation.frames||1)/Math.max(1,shot?.generation.fps||24));
            const maxIn=Math.max(0,duration-.01);
            return <div className="timeline-clip timeline-clip-edit" key={clip.id} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-cineforge-timeline-clip',clip.id);}} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect=event.dataTransfer.types.includes('application/x-cineforge-render-output')?'copy':'move';}} onDrop={event=>dropClip(event,clip.id)}>
              <span className="drag-handle" title="Drag to reorder within this track">⋮⋮</span><Pill>T{clip.track} · {clip.order+1}</Pill>
              <div className="clip-main"><strong>{shot?.title||'Shot'}</strong><small>{duration.toFixed(2)}s source{output?.technicalQc?' · measured':' · nominal'}</small>
                <div className="clip-fields">
                  <label>In<input type="number" min="0" max={maxIn} step="0.1" value={clip.trimInSec} onChange={event=>patch(clip.id,target=>{const value=Math.max(0,Math.min(maxIn,Number(event.target.value)||0));target.trimInSec=value;if(target.trimOutSec!=null&&target.trimOutSec<=value)target.trimOutSec=Math.min(duration,value+.1);})}/></label>
                  <label>Out<input type="number" min={Math.min(duration,clip.trimInSec+.01)} max={duration} step="0.1" value={clip.trimOutSec??''} placeholder={duration.toFixed(2)} onChange={event=>patch(clip.id,target=>{if(event.target.value===''){target.trimOutSec=undefined;return;}const value=Number(event.target.value);target.trimOutSec=Math.min(duration,Math.max(target.trimInSec+.01,Number.isFinite(value)?value:duration));})}/></label>
                  <label>Vol<input type="number" min="0" max="8" step="0.05" value={clip.volume} onChange={event=>patch(clip.id,target=>target.volume=Math.max(0,Math.min(8,Number(event.target.value)||0)))}/></label>
                </div>
              </div>
              <div className="clip-actions"><button onClick={()=>move(clip.id,-1)} disabled={!project.timeline.some(other=>other.track===clip.track&&other.order<clip.order)}>←</button><button onClick={()=>move(clip.id,1)} disabled={!project.timeline.some(other=>other.track===clip.track&&other.order>clip.order)}>→</button><button onClick={()=>remove(clip.id)}>×</button></div>
            </div>;
          })}</div>}
        </div>
      </Card>
    </div>
  </Page>;
}
function projectRelativeOutput(root:string,absolute:string):string{const normalizedRoot=root.replace(/\\/g,'/').replace(/\/$/,'');const normalizedAbsolute=absolute.replace(/\\/g,'/');return normalizedAbsolute.startsWith(`${normalizedRoot}/`)?normalizedAbsolute.slice(normalizedRoot.length+1):normalizedAbsolute;}
