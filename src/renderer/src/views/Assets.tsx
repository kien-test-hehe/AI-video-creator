import { useMemo, useState, type DragEvent } from 'react';
import type { AssetKind } from '../../../shared/types';
import { useAppStore } from '../store';
import { Card, Empty, Page, Pill } from '../components/Ui';
import { projectMediaUrl } from '../media';

const KINDS:AssetKind[]=['character','location','prop','wardrobe','reference','keyframe','image','video','audio'];
const PAGE_SIZE=60;

export function Assets(){
  const{project,setProject,updateProject,setError,setNotice}=useAppStore();
  const[kind,setKind]=useState<AssetKind>('reference'),[filter,setFilter]=useState<AssetKind|'all'>('all'),[query,setQuery]=useState(''),[page,setPage]=useState(0);
  const assets=project?.assets??[];
  const matching=useMemo(()=>assets.filter(asset=>{
    if(filter!=='all'&&asset.kind!==filter)return false;
    const q=query.trim().toLowerCase();return!q||asset.name.toLowerCase().includes(q)||asset.tags.some(tag=>tag.toLowerCase().includes(q))||asset.notes.toLowerCase().includes(q);
  }),[assets,filter,query]);
  if(!project)return <Page title="Assets"><Empty>Open a project first.</Empty></Page>;
  const pages=Math.max(1,Math.ceil(matching.length/PAGE_SIZE)),safePage=Math.min(page,pages-1),visible=matching.slice(safePage*PAGE_SIZE,(safePage+1)*PAGE_SIZE);
  const add=async()=>{try{await useAppStore.getState().persist();const next=await window.cineforge.asset.import(kind);if(next)setProject(next);}catch(e){setError(e instanceof Error?e.message:String(e));}};
  const drag=(event:DragEvent,assetId:string)=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-cineforge-asset',assetId);};
  const removeAsset=async(assetId:string,name:string)=>{if(!window.confirm(`Delete “${name}” from this project and remove its local project copy? Shot references to it will be cleared.`))return;try{await useAppStore.getState().persist();setProject(await window.cineforge.asset.delete(assetId));setNotice(`Deleted asset: ${name}`);}catch(e){setError(e instanceof Error?e.message:String(e));}};
  return <Page title="Asset library" subtitle="Searchable continuity/media library. Drag assets onto shots; large libraries are paged to keep the editor responsive." actions={<div className="row"><select value={kind} onChange={e=>setKind(e.target.value as AssetKind)}>{KINDS.map(k=><option key={k}>{k}</option>)}</select><button className="primary" onClick={add}>Import</button></div>}>
    <Card title="Find assets" kicker={`${matching.length} MATCHING / ${project.assets.length} TOTAL`}><div className="form-grid two-col"><label>Search<input value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}} placeholder="name, tag, continuity notes…"/></label><label>Kind<select value={filter} onChange={e=>{setFilter(e.target.value as AssetKind|'all');setPage(0);}}><option value="all">all kinds</option>{KINDS.map(value=><option key={value}>{value}</option>)}</select></label></div></Card>
    {visible.length===0?<Empty>No matching assets. Import character sheets, locations, props, wardrobe or hero frames.</Empty>:<div className="asset-grid">{visible.map(asset=><div key={asset.id} className="asset-drag-wrap" draggable onDragStart={e=>drag(e,asset.id)}><Card className="asset-card">{['image','reference','keyframe','character','location','prop','wardrobe'].includes(asset.kind)?<img className="asset-preview" loading="lazy" src={projectMediaUrl(asset.projectPath)} alt={asset.name}/>:asset.kind==='video'?<video className="asset-preview" src={projectMediaUrl(asset.projectPath)} muted controls preload="none"/>:<div className="asset-icon">♪</div>}<div className="asset-title-row"><Pill>{asset.kind}</Pill><small title={asset.projectPath}>{asset.projectPath}</small></div><label>Name<input value={asset.name} onChange={e=>updateProject(p=>{const a=p.assets.find(x=>x.id===asset.id);if(a)a.name=e.target.value;})}/></label><label>Continuity description<textarea className="asset-notes" value={asset.notes} onChange={e=>updateProject(p=>{const a=p.assets.find(x=>x.id===asset.id);if(a)a.notes=e.target.value;})} placeholder="Face, hair, clothing, material, colors, distinguishing marks, spatial rules…"/></label><label>Tags<input value={asset.tags.join(', ')} onChange={e=>updateProject(p=>{const a=p.assets.find(x=>x.id===asset.id);if(a)a.tags=e.target.value.split(',').map(x=>x.trim()).filter(Boolean);})} placeholder="hero, wet, night"/></label><button className="ghost danger" onClick={()=>void removeAsset(asset.id,asset.name)}>Delete asset</button></Card></div>)}</div>}
    {pages>1&&<div className="row pagination"><button className="ghost" disabled={safePage===0} onClick={()=>setPage(value=>Math.max(0,value-1))}>← Previous</button><span className="muted">Page {safePage+1} / {pages}</span><button className="ghost" disabled={safePage>=pages-1} onClick={()=>setPage(value=>Math.min(pages-1,value+1))}>Next →</button></div>}
  </Page>;
}
