import type {
  ContinuityField, FilmProject, QcLayer, Shot, ShotDependency, ShotState
} from './types';

const DEFAULT_CONTINUITY_FIELDS:ContinuityField[]=[
  'character','wardrobe','prop','location','lighting','action','dialogue'
];

export function productionStableId(prefix:string,input:string):string{
  let hash=0x811c9dc5;
  for(let index=0;index<input.length;index++){
    hash^=input.charCodeAt(index);
    hash=Math.imul(hash,0x01000193)>>>0;
  }
  const safePrefix=prefix.replace(/[^a-zA-Z0-9._:-]+/g,'-').slice(0,180)||'id';
  return `${safePrefix}:${hash.toString(16).padStart(8,'0')}`;
}

export function defaultSequentialDependencies(shots:Shot[],createdAt:string):ShotDependency[]{
  const byScene=new Map<string,Shot[]>();
  for(const shot of shots){
    const list=byScene.get(shot.sceneId)??[];
    list.push(shot);
    byScene.set(shot.sceneId,list);
  }
  const result:ShotDependency[]=[];
  for(const list of byScene.values()){
    const ordered=[...list].sort((a,b)=>a.index-b.index||a.id.localeCompare(b.id));
    for(let index=1;index<ordered.length;index++){
      const from=ordered[index-1],to=ordered[index];
      result.push({
        id:productionStableId('continuity',`${from.id}>${to.id}`),
        fromShotId:from.id,
        toShotId:to.id,
        relation:'continuity',
        strength:'soft',
        propagate:[...DEFAULT_CONTINUITY_FIELDS],
        createdAt
      });
    }
  }
  return result;
}

export function shotStateContentKey(state:Pick<ShotState,
  'shotId'|'role'|'source'|'frameAssetId'|'sourceRenderOutputId'|'derivedFromStateId'|'characters'|'props'|'environment'|'camera'|'actionPhase'|'dialogueState'
>):string{
  return JSON.stringify({
    shotId:state.shotId,
    role:state.role,
    source:state.source,
    frameAssetId:state.frameAssetId,
    sourceRenderOutputId:state.sourceRenderOutputId,
    derivedFromStateId:state.derivedFromStateId,
    characters:state.characters,
    props:state.props,
    environment:state.environment,
    camera:state.camera,
    actionPhase:state.actionPhase,
    dialogueState:state.dialogueState
  });
}

export function invalidateObservedFinalState(project:FilmProject,shotId:string,reason:string):void{
  const shot=project.shots.find(item=>item.id===shotId);
  if(!shot)return;
  const roots=project.shotStates.filter(state=>state.shotId===shotId&&state.role==='observed-final'&&state.status!=='stale');
  if(!roots.length){
    shot.observedFinalStateId=undefined;
    return;
  }
  const staleIds=new Set(roots.map(state=>state.id));
  let changed=true;
  while(changed){
    changed=false;
    for(const state of project.shotStates){
      if(state.status==='stale'||staleIds.has(state.id)||!state.derivedFromStateId||!staleIds.has(state.derivedFromStateId))continue;
      staleIds.add(state.id);
      changed=true;
    }
  }
  for(const state of project.shotStates){
    if(!staleIds.has(state.id))continue;
    state.status='stale';
    state.staleReason=reason.slice(0,4096);
  }
  shot.observedFinalStateId=undefined;
  for(const dependent of project.shots){
    if(!dependent.actualStartStateId||!staleIds.has(dependent.actualStartStateId))continue;
    const staleStart=project.shotStates.find(state=>state.id===dependent.actualStartStateId);
    if(staleStart?.frameAssetId&&dependent.startFrameAssetId===staleStart.frameAssetId)dependent.startFrameAssetId=undefined;
    dependent.actualStartStateId=undefined;
  }
}

function selectFields(source:ShotState,fields:ReadonlySet<ContinuityField>):Pick<ShotState,'characters'|'props'|'environment'|'camera'|'actionPhase'|'dialogueState'>{
  const characters=fields.has('character')||fields.has('wardrobe')
    ? structuredClone(source.characters)
    : [];
  const props=fields.has('prop')?structuredClone(source.props):[];
  const environment=fields.has('location')||fields.has('lighting')
    ? {
        ...(fields.has('location')?{locationAssetId:source.environment.locationAssetId,timeOfDay:source.environment.timeOfDay,weather:source.environment.weather}:{}),
        ...(fields.has('lighting')?{lighting:source.environment.lighting}:{}),
        notes:source.environment.notes
      }
    : {};
  const camera=fields.has('camera')?structuredClone(source.camera):{};
  return{
    characters,
    props,
    environment,
    camera,
    actionPhase:fields.has('action')?source.actionPhase:'',
    dialogueState:fields.has('dialogue')?source.dialogueState:''
  };
}

export function propagateObservedFinalState(project:FilmProject,sourceShotId:string,createdAt=new Date().toISOString()):string[]{
  const sourceShot=project.shots.find(shot=>shot.id===sourceShotId);
  const sourceState=sourceShot?.observedFinalStateId
    ? project.shotStates.find(state=>state.id===sourceShot.observedFinalStateId)
    : undefined;
  if(!sourceShot||!sourceState||sourceState.role!=='observed-final'||sourceState.status!=='current')return[];

  const created:string[]=[];
  const outgoing=project.shotDependencies
    .filter(edge=>edge.fromShotId===sourceShotId&&edge.relation!=='parallel'&&edge.propagate.length>0)
    .sort((a,b)=>a.id.localeCompare(b.id));

  for(const edge of outgoing){
    const target=project.shots.find(shot=>shot.id===edge.toShotId);
    if(!target)continue;
    const existing=target.actualStartStateId?project.shotStates.find(state=>state.id===target.actualStartStateId):undefined;
    if(existing?.status==='current'&&existing.source==='human')continue;
    const startFrameOwnedByExisting=Boolean(existing?.frameAssetId&&existing.source!=='human'&&target.startFrameAssetId===existing.frameAssetId);
    if(target.startFrameAssetId&&!startFrameOwnedByExisting)continue;
    if(existing?.derivedFromStateId===sourceState.id&&existing.status!=='stale')continue;
    if(existing&&existing.status!=='stale'){
      existing.status='stale';
      existing.staleReason=`Superseded by propagated state from ${sourceShotId}.`;
    }

    const fields=new Set(edge.propagate);
    const selected=selectFields(sourceState,fields);
    const id=productionStableId('state',`${edge.id}:${sourceState.id}:${shotStateContentKey({...sourceState,...selected,shotId:target.id,role:'actual-start',source:'generated',derivedFromStateId:sourceState.id})}`);
    const propagated:ShotState={
      id,
      shotId:target.id,
      role:'actual-start',
      source:'generated',
      status:'unreviewed',
      frameAssetId:sourceState.frameAssetId,
      sourceRenderOutputId:sourceState.sourceRenderOutputId,
      derivedFromStateId:sourceState.id,
      ...selected,
      confidence:sourceState.confidence,
      createdAt
    };
    const duplicate=project.shotStates.find(state=>state.id===id);
    if(duplicate)Object.assign(duplicate,propagated);
    else project.shotStates.push(propagated);
    target.actualStartStateId=id;
    if(sourceState.frameAssetId)target.startFrameAssetId=sourceState.frameAssetId;
    created.push(id);
  }
  return created;
}

export function canonicalTakeReadiness(project:FilmProject,shotId:string,outputId:string):{ready:boolean;blockers:string[]}{
  const blockers:string[]=[];
  const output=project.renderOutputs.find(item=>item.id===outputId&&item.shotId===shotId&&item.mediaType==='video');
  if(!output){return{ready:false,blockers:['Render output is missing, belongs to another shot, or is not video.']};}
  if(!output.technicalQc?.passed)blockers.push('Technical QC has not passed.');
  const latestByLayer=new Map<QcLayer,typeof project.qcResults[number]>();
  for(const result of project.qcResults){
    if(result.shotId!==shotId||result.renderOutputId!==outputId)continue;
    const prior=latestByLayer.get(result.layer);
    if(!prior||prior.createdAt<result.createdAt)latestByLayer.set(result.layer,result);
  }
  for(const layer of ['visual','semantic'] as const){
    const result=latestByLayer.get(layer);
    if(!result)blockers.push(`${layer} QC is missing.`);
    else if(result.status!=='pass')blockers.push(`${layer} QC is ${result.status}.`);
  }
  const hasContinuityDependency=project.shotDependencies.some(edge=>edge.fromShotId===shotId||edge.toShotId===shotId);
  if(hasContinuityDependency){
    const continuity=latestByLayer.get('continuity');
    if(!continuity)blockers.push('continuity QC is missing.');
    else if(continuity.status!=='pass')blockers.push(`continuity QC is ${continuity.status}.`);
  }
  return{ready:blockers.length===0,blockers};
}

export function refreshCanonicalRender(project:FilmProject,shotId:string):void{
  const shot=project.shots.find(item=>item.id===shotId);
  if(!shot)return;
  if(shot.canonicalRenderId&&canonicalTakeReadiness(project,shotId,shot.canonicalRenderId).ready)return;
  const candidates=project.renderOutputs
    .filter(output=>output.shotId===shotId&&output.mediaType==='video')
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  shot.canonicalRenderId=candidates.find(output=>canonicalTakeReadiness(project,shotId,output.id).ready)?.id;
}
