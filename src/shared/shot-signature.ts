import type { FilmProject, Shot } from './types';

export function shotRenderInputKey(shot:Shot):string{
  return JSON.stringify({
    prompt:shot.prompt,
    camera:shot.camera,
    action:shot.action,
    dialogue:shot.dialogue,
    continuityNotes:shot.continuityNotes,
    characterAssetIds:shot.characterAssetIds,
    locationAssetId:shot.locationAssetId,
    propAssetIds:shot.propAssetIds,
    referenceAssetIds:shot.referenceAssetIds??[],
    startFrameAssetId:shot.startFrameAssetId,
    endFrameAssetId:shot.endFrameAssetId,
    referenceVideoAssetId:shot.referenceVideoAssetId,
    audioAssetId:shot.audioAssetId,
    generation:shot.generation
  });
}

export function shotKeyframeInputKey(shot:Shot,role:'start'|'end'):string{
  return JSON.stringify({
    role,
    prompt:shot.prompt,
    camera:shot.camera,
    action:shot.action,
    continuityNotes:shot.continuityNotes,
    characterAssetIds:shot.characterAssetIds,
    locationAssetId:shot.locationAssetId,
    propAssetIds:shot.propAssetIds,
    referenceAssetIds:shot.referenceAssetIds??[],
    startFrameAssetId:role==='end'?shot.startFrameAssetId:undefined,
    generation:{
      modelFamily:shot.generation.modelFamily,
      width:shot.generation.width,
      height:shot.generation.height,
      steps:shot.generation.steps,
      cfg:shot.generation.cfg,
      seed:shot.generation.seed,
      negativePrompt:shot.generation.negativePrompt
    }
  });
}


export function shotProjectRenderInputKey(project:FilmProject,shot:Shot):string{
  const ids=[...shot.characterAssetIds,...shot.propAssetIds,...(shot.referenceAssetIds??[]),shot.locationAssetId].filter((id):id is string=>Boolean(id));
  const promptAssets=[...new Set(ids)].map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({
    id:asset!.id,kind:asset!.kind,name:asset!.name,notes:asset!.notes
  })).sort((a,b)=>a.id.localeCompare(b.id));
  return JSON.stringify({shot:shotRenderInputKey(shot),promptAssets});
}
