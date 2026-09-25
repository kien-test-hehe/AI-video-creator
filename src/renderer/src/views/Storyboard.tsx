import { useState, type DragEvent } from 'react';
import { MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../../shared/defaults';
import type { ModelFamily, Shot } from '../../../shared/types';
import { filterDirectorAssetIds, sceneDirectorInputKey, validatedVideoRouteForModel } from '../../../shared/director-signature';
import { useAppStore } from '../store';
import { autoAssignAssetToShot } from '../asset-assignment';
import { Card, Empty, Page, Pill } from '../components/Ui';

export function Storyboard(){
  const{project,updateProject,selectShot,setView,setNotice,setError,setBusy}=useAppStore();
  const[planningSceneId,setPlanningSceneId]=useState<string>();
  if(!project)return <Page title="Storyboard"><Empty>Open a project first.</Empty></Page>;

  const addShot=(sceneId:string)=>updateProject(p=>{
    const scene=p.scenes.find(s=>s.id===sceneId);if(!scene)return;
    const index=p.shots.filter(s=>s.sceneId===sceneId).length+1,id=crypto.randomUUID(),d=MODEL_DEFAULTS[PRIMARY_VIDEO_MODEL];
    const shot:Shot={id,sceneId,index,title:'Shot '+scene.index+'.'+index,prompt:scene.body,camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'draft',generation:{modelFamily:PRIMARY_VIDEO_MODEL,mode:d.mode||'i2v',quality:'balanced',width:d.width!,height:d.height!,frames:d.frames!,fps:d.fps!,steps:d.steps,cfg:d.cfg,seed:Math.floor(Math.random()*2147483647),negativePrompt:'',includeAudio:d.includeAudio??true}};
    p.shots.push(shot);scene.shotIds.push(id);
  });

  const aiPlan=async(sceneId:string)=>{
    if(planningSceneId)return;
    try{
      setPlanningSceneId(sceneId);setBusy(true);await useAppStore.getState().persist();
      const initial=useAppStore.getState().project,initialScene=initial?.scenes.find(scene=>scene.id===sceneId);
      if(!initial||!initialScene)throw new Error('Scene not found.');
      const signature=sceneDirectorInputKey(initial,initialScene);
      const drafts=await window.cineforge.director.planScene(sceneId);
      const current=useAppStore.getState().project,currentScene=current?.scenes.find(scene=>scene.id===sceneId);
      if(!current||!currentScene||sceneDirectorInputKey(current,currentScene)!==signature){setNotice('Director result was discarded because the story, scene, assets, or validated model routes changed while planning.');return;}
      updateProject(p=>{
        const scene=p.scenes.find(s=>s.id===sceneId);if(!scene||sceneDirectorInputKey(p,scene)!==signature)return;
        let index=p.shots.filter(s=>s.sceneId===sceneId).length,added=0;
        for(const draft of drafts){
          const requested=draft.preferredModel as ModelFamily|undefined;
          const route=validatedVideoRouteForModel(p,requested)??validatedVideoRouteForModel(p,PRIMARY_VIDEO_MODEL)??p.settings.workflowProfiles.find(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid');
          const validatedModel=route?.modelFamily;
          if(!validatedModel||!route)continue;
          index+=1;added+=1;const d=MODEL_DEFAULTS[validatedModel],id=crypto.randomUUID();
          const characterAssetIds=filterDirectorAssetIds(p,'character',draft.characterAssetIds||[]).slice(0,4);
          const referenceAssetIds=filterDirectorAssetIds(p,'reference',draft.referenceAssetIds||[]).slice(0,4);
          const propAssetIds=filterDirectorAssetIds(p,'prop',draft.propAssetIds||[]).slice(0,2);
          const locationAssetId=filterDirectorAssetIds(p,'location',draft.locationAssetId?[draft.locationAssetId]:[])[0];
          const shot:Shot={id,sceneId,index,title:draft.title||('Shot '+scene.index+'.'+index),prompt:draft.prompt,camera:draft.camera,action:draft.action,dialogue:draft.dialogue,continuityNotes:draft.continuityNotes,characterAssetIds,locationAssetId,propAssetIds,referenceAssetIds,status:'draft',generation:{modelFamily:validatedModel,mode:route.mode,quality:draft.quality,width:d.width||768,height:d.height||432,frames:d.frames||97,fps:d.fps||24,steps:d.steps,cfg:d.cfg,seed:Math.floor(Math.random()*2147483647),negativePrompt:'',includeAudio:d.includeAudio??false,workflowProfileId:route.id}};
          p.shots.push(shot);scene.shotIds.push(id);
        }
        if(!added)throw new Error('Director returned no shot compatible with the currently validated local video routes.');
      });
      setNotice('Local Director shot drafts were applied to the unchanged scene.');
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPlanningSceneId(undefined);setBusy(false);}
  };

  const startShotDrag=(event:DragEvent,shotId:string)=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-cineforge-shot',shotId);};
  const dropOnShot=(event:DragEvent,targetShotId:string)=>{
    event.preventDefault();
    const draggedShotId=event.dataTransfer.getData('application/x-cineforge-shot');
    if(draggedShotId){
      updateProject(p=>{
        const source=p.shots.find(s=>s.id===draggedShotId),target=p.shots.find(s=>s.id===targetShotId);
        if(!source||!target||source.sceneId!==target.sceneId||source.id===target.id)return;
        const siblings=p.shots.filter(s=>s.sceneId===source.sceneId).sort((a,b)=>a.index-b.index);
        const from=siblings.findIndex(s=>s.id===source.id),to=siblings.findIndex(s=>s.id===target.id);
        const [moved]=siblings.splice(from,1);siblings.splice(to,0,moved);siblings.forEach((s,i)=>s.index=i+1);
        const scene=p.scenes.find(s=>s.id===source.sceneId);if(scene)scene.shotIds=siblings.map(s=>s.id);
      });
      return;
    }
    const assetId=event.dataTransfer.getData('application/x-cineforge-asset');
    if(!assetId)return;
    let result:{ok:boolean;role:string;message:string}|undefined;
    updateProject(p=>{
      const shot=p.shots.find(s=>s.id===targetShotId),asset=p.assets.find(a=>a.id===assetId);if(!shot||!asset)return;
      result=autoAssignAssetToShot(shot,asset);
    });
    const asset=project.assets.find(a=>a.id===assetId);const shot=project.shots.find(s=>s.id===targetShotId);
    if(result?.ok)setNotice(asset&&shot?asset.name+' → '+shot.title+': '+result.message:result.message);
    else if(result)setError(result.message);
  };

  return <Page title="Storyboard" subtitle="Drag shots to reorder them. Drag characters, locations, visual references, props, keyframes, audio or video from Assets directly onto a shot.">
    {project.scenes.length===0?<Empty>Parse your screenplay first.</Empty>:<div className="scene-stack">{project.scenes.map(scene=>{
      const shots=project.shots.filter(s=>s.sceneId===scene.id).sort((a,b)=>a.index-b.index);
      return <Card key={scene.id} kicker={'SCENE '+scene.index} title={scene.heading} actions={<div className="row"><button className="ghost" disabled={Boolean(planningSceneId)} onClick={()=>aiPlan(scene.id)}>{planningSceneId===scene.id?'Planning…':'AI Director'}</button><button className="ghost" onClick={()=>addShot(scene.id)}>+ Shot</button></div>}>
        <p className="scene-body">{scene.body}</p>
        <div className="shot-strip">{shots.map(shot=><button className="shot-tile shot-drop-target" key={shot.id} draggable onDragStart={e=>startShotDrag(e,shot.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>dropOnShot(e,shot.id)} onClick={()=>{selectShot(shot.id);setView('shots');}}>
          <span>{shot.title}</span><small>{shot.generation.modelFamily}</small>
          <div className="shot-ref-pills"><Pill>C{shot.characterAssetIds.length}</Pill><Pill>{shot.locationAssetId?'LOC':'NO LOC'}</Pill><Pill>REF{shot.referenceAssetIds?.length??0}</Pill><Pill>P{shot.propAssetIds.length}</Pill></div>
          <b>{shot.status}</b>
        </button>)}</div>
      </Card>;
    })}</div>}
  </Page>;
}
