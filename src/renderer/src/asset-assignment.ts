import type { Asset, Shot } from '../../shared/types';

export interface AutoAssetAssignment { ok:boolean; role:string; message:string; }

export function autoAssignAssetToShot(shot:Shot,asset:Asset):AutoAssetAssignment{
  if(asset.kind==='character'){
    if(shot.characterAssetIds.includes(asset.id))return{ok:true,role:'character',message:'Character is already assigned.'};
    if(shot.characterAssetIds.length>=4)return{ok:false,role:'character',message:'This shot already has the maximum of 4 character references.'};
    shot.characterAssetIds.push(asset.id);markReady(shot);return{ok:true,role:'character',message:'Assigned as a character continuity reference.'};
  }
  if(asset.kind==='location'){
    shot.locationAssetId=asset.id;markReady(shot);return{ok:true,role:'location',message:'Assigned as the shot location.'};
  }
  if(['prop','wardrobe','reference'].includes(asset.kind)){
    if(shot.propAssetIds.includes(asset.id))return{ok:true,role:'continuity reference',message:'Reference is already assigned.'};
    if(shot.propAssetIds.length>=2)return{ok:false,role:'continuity reference',message:'This shot already has the maximum of 2 prop / wardrobe / generic reference assets. Use a dedicated Start/End slot if this image is a keyframe.'};
    shot.propAssetIds.push(asset.id);markReady(shot);return{ok:true,role:'continuity reference',message:'Assigned as a prop / wardrobe / generic continuity reference.'};
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
