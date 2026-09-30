import type { Asset, Shot } from '../../shared/types';

export interface AutoAssetAssignment { ok:boolean; role:string; message:string; }

export function autoAssignAssetToShot(shot:Shot,asset:Asset):AutoAssetAssignment{
  if(asset.kind==='character'){
    if(shot.characterAssetIds.includes(asset.id))return{ok:true,role:'character',message:'Character is already assigned.'};
    if(shot.characterAssetIds.length>=16)return{ok:false,role:'character',message:'This shot already has the 16-character safety limit.'};
    shot.characterAssetIds.push(asset.id);markReady(shot);return{ok:true,role:'character',message:'Assigned as a character continuity reference.'};
  }
  if(asset.kind==='location'){
    shot.locationAssetId=asset.id;markReady(shot);return{ok:true,role:'location',message:'Assigned as the shot location.'};
  }
  if(asset.kind==='reference'){
    const refs=shot.referenceAssetIds??(shot.referenceAssetIds=[]);
    if(refs.includes(asset.id))return{ok:true,role:'visual reference',message:'Visual reference is already assigned.'};
    if(refs.length>=16)return{ok:false,role:'visual reference',message:'This shot already has the 16-reference safety limit. Use Start/End for temporal keyframes or remove an existing reference.'};
    refs.push(asset.id);markReady(shot);return{ok:true,role:'visual reference',message:'Assigned as a generic visual reference.'};
  }
  if(['prop','wardrobe'].includes(asset.kind)){
    if(shot.propAssetIds.includes(asset.id))return{ok:true,role:'prop / wardrobe',message:'Prop / wardrobe reference is already assigned.'};
    if(shot.propAssetIds.length>=16)return{ok:false,role:'prop / wardrobe',message:'This shot already has the 16 prop / wardrobe safety limit.'};
    shot.propAssetIds.push(asset.id);markReady(shot);return{ok:true,role:'prop / wardrobe',message:'Assigned as a prop / wardrobe continuity reference.'};
  }
  if(asset.kind==='image'||asset.kind==='keyframe'){
    if(!shot.startFrameAssetId){shot.startFrameAssetId=asset.id;markReady(shot);return{ok:true,role:'start frame',message:'Assigned as the start frame.'};}
    if(!shot.endFrameAssetId){shot.endFrameAssetId=asset.id;markReady(shot);return{ok:true,role:'end frame',message:'Assigned as the end frame.'};}
    return{ok:false,role:'keyframe',message:'Start and end frames are already occupied. Drop the asset into a specific slot in the Studio inspector or Shot Workshop.'};
  }
  if(asset.kind==='video'){
    shot.referenceVideoAssetId=asset.id;markReady(shot);return{ok:true,role:'motion reference',message:'Assigned as the motion / reference video.'};
  }
  if(asset.kind==='audio'){
    shot.audioAssetId=asset.id;markReady(shot);return{ok:true,role:'audio reference',message:'Assigned as input audio.'};
  }
  return{ok:false,role:asset.kind,message:`No automatic assignment rule exists for ${asset.kind}.`};
}

function markReady(shot:Shot):void{if(shot.status==='draft')shot.status='ready';}
