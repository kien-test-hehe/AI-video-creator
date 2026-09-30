import type { Asset, DirectorShotDraft, FilmProject, ModelFamily, Scene, Shot } from './types';
import { MODEL_DEFAULTS } from './defaults';
import { workflowCapabilityErrors } from './workflow-capabilities';
import { shotRenderInputKey } from './shot-signature';

export function sceneDirectorInputKey(project:FilmProject,scene:Scene):string{
  const relevant=project.assets
    .filter(asset=>['character','location','prop','wardrobe','reference'].includes(asset.kind))
    .map(asset=>({id:asset.id,kind:asset.kind,name:asset.name,tags:asset.tags,notes:asset.notes}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const availableRoutes=project.settings.workflowProfiles
    .filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid')
    .map(profile=>({
      id:profile.id,modelFamily:profile.modelFamily,mode:profile.mode,workflowPath:profile.workflowPath,
      sourceSha256:profile.validation?.sourceSha256,runtimeFingerprint:profile.validation?.runtimeFingerprint,
      modelFingerprint:profile.modelFingerprint,lastSuccessfulRenderAt:profile.validation?.lastSuccessfulRenderAt
    }))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const availableModels=[...new Set(availableRoutes.map(route=>route.modelFamily))].sort();
  const existingShots=project.shots
    .filter(shot=>shot.sceneId===scene.id)
    .sort((a,b)=>a.index-b.index||a.id.localeCompare(b.id))
    .map(shot=>({id:shot.id,index:shot.index,input:shotRenderInputKey(shot)}));
  return JSON.stringify({
    projectId:project.id,
    story:{title:project.story.title,logline:project.story.logline,notes:project.story.notes},
    scene:{id:scene.id,index:scene.index,heading:scene.heading,body:scene.body,location:scene.location,timeOfDay:scene.timeOfDay},
    existingShots,
    assets:relevant,
    availableModels,
    availableRoutes
  });
}

export function continuityPredecessorShots(project:FilmProject,shot:Shot):Shot[]{
  const dependencies=project.shotDependencies??[];
  const incoming=dependencies
    .filter(edge=>edge.toShotId===shot.id&&edge.relation!=='parallel'&&edge.propagate.length>0)
    .sort((a,b)=>(a.strength===b.strength?0:a.strength==='hard'?-1:1)||a.id.localeCompare(b.id));
  const seen=new Set<string>(),resolved:Shot[]=[];
  for(const edge of incoming){
    const source=project.shots.find(item=>item.id===edge.fromShotId);
    if(source&&!seen.has(source.id)){seen.add(source.id);resolved.push(source);}
  }
  if(resolved.length||dependencies.length>0)return resolved;
  const siblings=project.shots.filter(item=>item.sceneId===shot.sceneId).sort((a,b)=>a.index-b.index);
  const index=siblings.findIndex(item=>item.id===shot.id),prior=index>0?siblings[index-1]:undefined;
  return prior?[prior]:[];
}

export function continuityReviewInputKey(project:FilmProject,shot:Shot):string{
  const scene=project.scenes.find(item=>item.id===shot.sceneId);
  const predecessors=continuityPredecessorShots(project,shot);
  const incoming=(project.shotDependencies??[]).filter(edge=>edge.toShotId===shot.id&&edge.relation!=='parallel'&&edge.propagate.length>0)
    .map(edge=>({id:edge.id,fromShotId:edge.fromShotId,relation:edge.relation,strength:edge.strength,propagate:edge.propagate})).sort((a,b)=>a.id.localeCompare(b.id));
  const ids=new Set<string>([
    ...shot.characterAssetIds,
    ...(shot.referenceAssetIds??[]),
    ...shot.propAssetIds,
    ...(shot.locationAssetId?[shot.locationAssetId]:[]),
    ...(shot.startFrameAssetId?[shot.startFrameAssetId]:[]),
    ...(shot.endFrameAssetId?[shot.endFrameAssetId]:[])
  ]);
  const assets=[...ids].map(id=>project.assets.find(asset=>asset.id===id)).filter((asset):asset is Asset=>Boolean(asset))
    .map(asset=>({id:asset.id,kind:asset.kind,name:asset.name,notes:asset.notes,tags:asset.tags})).sort((a,b)=>a.id.localeCompare(b.id));
  return JSON.stringify({
    projectId:project.id,
    scene:scene?{id:scene.id,heading:scene.heading,body:scene.body}:undefined,
    shot:shotRenderInputKey(shot),
    predecessors:predecessors.map(item=>({id:item.id,input:shotRenderInputKey(item)})),
    incoming,
    assets
  });
}

export function filterDirectorAssetIds(project:FilmProject,kind:'character'|'location'|'reference'|'prop',ids:string[]):string[]{
  const allowed=kind==='prop'?new Set(['prop','wardrobe']):new Set([kind]);
  return [...new Set(ids)].filter(id=>{const asset=project.assets.find(item=>item.id===id);return Boolean(asset&&allowed.has(asset.kind));});
}

export function validatedVideoRouteForDirectorDraft(project:FilmProject,model:ModelFamily|undefined,draft:DirectorShotDraft){
  if(!model)return undefined;
  const defaults=MODEL_DEFAULTS[model];
  return project.settings.workflowProfiles
    .filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid'&&profile.modelFamily===model)
    .filter(profile=>workflowCapabilityErrors(profile,{
      generation:{modelFamily:model,mode:profile.mode,includeAudio:defaults.includeAudio??false},
      characterAssetIds:draft.characterAssetIds??[],
      locationAssetId:draft.locationAssetId,
      propAssetIds:draft.propAssetIds??[],
      referenceAssetIds:draft.referenceAssetIds??[]
    }).length===0)
    .sort((a,b)=>
      Number(Boolean(b.validation?.lastSuccessfulRenderAt))-Number(Boolean(a.validation?.lastSuccessfulRenderAt))||
      (b.validation?.successfulRenderCount??0)-(a.validation?.successfulRenderCount??0)||
      (b.validation?.lastSuccessfulRenderAt??'').localeCompare(a.validation?.lastSuccessfulRenderAt??'')||
      a.id.localeCompare(b.id)
    )[0];
}

export function validatedVideoRouteForModel(project:FilmProject,model:ModelFamily|undefined){
  if(!model)return undefined;
  return project.settings.workflowProfiles
    .filter(profile=>profile.enabled&&(profile.purpose??'video')==='video'&&profile.workflowPath&&profile.validation?.structuralStatus==='valid'&&profile.modelFamily===model)
    .sort((a,b)=>(b.validation?.lastSuccessfulRenderAt??'').localeCompare(a.validation?.lastSuccessfulRenderAt??'')||a.id.localeCompare(b.id))[0];
}

export function isValidatedVideoModel(project:FilmProject,model:ModelFamily|undefined):model is ModelFamily{
  return Boolean(validatedVideoRouteForModel(project,model));
}
