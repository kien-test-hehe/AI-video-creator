import type { DragEvent } from 'react';
import { MODEL_DEFAULTS, PRIMARY_VIDEO_MODEL } from '../../../shared/defaults';
import type { Shot } from '../../../shared/types';
import { useAppStore } from '../store';
import { autoAssignAssetToShot } from '../asset-assignment';
import { Card, Empty, Page, Pill } from '../components/Ui';

export function Storyboard(){
  const{project,updateProject,selectShot,setView,setNotice,setError}=useAppStore();
  if(!project)return <Page title="Storyboard"><Empty>Open a project first.</Empty></Page>;

  const addShot=(sceneId:string)=>updateProject(p=>{
    const scene=p.scenes.find(s=>s.id===sceneId);if(!scene)return;
    const index=p.shots.filter(s=>s.sceneId===sceneId).length+1,id=crypto.randomUUID(),d=MODEL_DEFAULTS[PRIMARY_VIDEO_MODEL];
    const shot:Shot={id,sceneId,index,title:'Shot '+scene.index+'.'+index,prompt:scene.body,camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],status:'draft',generation:{modelFamily:PRIMARY_VIDEO_MODEL,mode:d.mode||'i2v',quality:'balanced',width:d.width!,height:d.height!,frames:d.frames!,fps:d.fps!,steps:d.steps,cfg:d.cfg,seed:Math.floor(Math.random()*2147483647),negativePrompt:'',includeAudio:d.includeAudio??true}};
    p.shots.push(shot);scene.shotIds.push(id);
  });

  const aiPlan=async(sceneId:string)=>{
    try{
      await useAppStore.getState().persist();
      const drafts=await window.cineforge.director.planScene(sceneId);
      updateProject(p=>{
        const scene=p.scenes.find(s=>s.id===sceneId);if(!scene)return;
        let index=p.shots.filter(s=>s.sceneId===sceneId).length;
        for(const draft of drafts){
          index+=1;const model=draft.preferredModel||PRIMARY_VIDEO_MODEL,d=MODEL_DEFAULTS[model],id=crypto.randomUUID();
          const shot:Shot={id,sceneId,index,title:draft.title||('Shot '+scene.index+'.'+index),prompt:draft.prompt,camera:draft.camera,action:draft.action,dialogue:draft.dialogue,continuityNotes:draft.continuityNotes,characterAssetIds:draft.characterAssetIds||[],locationAssetId:draft.locationAssetId,propAssetIds:draft.propAssetIds||[],status:'draft',generation:{modelFamily:model,mode:d.mode||'i2v',quality:draft.quality,width:d.width||768,height:d.height||432,frames:d.frames||97,fps:d.fps||24,steps:d.steps,cfg:d.cfg,seed:Math.floor(Math.random()*2147483647),negativePrompt:'',includeAudio:d.includeAudio??false}};
          p.shots.push(shot);scene.shotIds.push(id);
        }
      });
      setNotice('Local Director added '+drafts.length+' shot draft'+(drafts.length===1?'':'s')+'.');
    }catch(e){setError(e instanceof Error?e.message:String(e));}
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

  return <Page title="Storyboard" subtitle="Drag shots to reorder them. Drag characters, locations, props, keyframes, audio or video from Assets directly onto a shot.">
    {project.scenes.length===0?<Empty>Parse your screenplay first.</Empty>:<div className="scene-stack">{project.scenes.map(scene=>{
      const shots=project.shots.filter(s=>s.sceneId===scene.id).sort((a,b)=>a.index-b.index);
      return <Card key={scene.id} kicker={'SCENE '+scene.index} title={scene.heading} actions={<div className="row"><button className="ghost" onClick={()=>aiPlan(scene.id)}>AI Director</button><button className="ghost" onClick={()=>addShot(scene.id)}>+ Shot</button></div>}>
        <p className="scene-body">{scene.body}</p>
        <div className="shot-strip">{shots.map(shot=><button className="shot-tile shot-drop-target" key={shot.id} draggable onDragStart={e=>startShotDrag(e,shot.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>dropOnShot(e,shot.id)} onClick={()=>{selectShot(shot.id);setView('shots');}}>
          <span>{shot.title}</span><small>{shot.generation.modelFamily}</small>
          <div className="shot-ref-pills"><Pill>C{shot.characterAssetIds.length}</Pill><Pill>{shot.locationAssetId?'LOC':'NO LOC'}</Pill><Pill>R{shot.propAssetIds.length}</Pill></div>
          <b>{shot.status}</b>
        </button>)}</div>
      </Card>;
    })}</div>}
  </Page>;
}
