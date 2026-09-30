import type {
  ContinuityField, FilmProject, HumanTask, QcLayer, RenderOutput, Shot, ShotDependency, ShotState, WorkflowProfile
} from './types';
import { shotProjectRenderInputKey, shotProjectRenderInputKeyForProfile } from './shot-signature';

export const DEFAULT_CONTINUITY_FIELDS:ContinuityField[]=[
  'character','wardrobe','prop','location','lighting','action','dialogue'
];
const LEGACY_DEFAULT_CONTINUITY_FIELDS:ContinuityField[]=[
  'character','wardrobe','prop','location','lighting','action','camera','dialogue'
];
const FULL_FRAME_CONTINUITY_FIELDS:ContinuityField[]=[
  'character','wardrobe','prop','location','lighting','action','camera'
];

export const OBSERVED_STATE_CONFIDENCE_TASK_PREFIX='Observed final state confidence · ';
export const OBSERVED_STATE_APPROVAL_PREFIX='Observed final state extraction approved:';

export function isObservedStateConfidenceTaskTitle(title:string):boolean{
  return title.startsWith(OBSERVED_STATE_CONFIDENCE_TASK_PREFIX);
}

export function isObservedStateApprovalResolution(resolution:string|undefined):boolean{
  return Boolean(resolution?.startsWith(OBSERVED_STATE_APPROVAL_PREFIX));
}

export function isApprovedObservedStateReview(
  task:Pick<HumanTask,'shotId'|'type'|'title'|'status'|'relatedRenderOutputIds'|'resolution'>,
  shotId:string,
  title:string,
  outputId:string
):boolean{
  return task.shotId===shotId&&
    task.type==='manual-qc'&&
    task.title===title&&
    task.status==='resolved'&&
    task.relatedRenderOutputIds.includes(outputId)&&
    isObservedStateApprovalResolution(task.resolution);
}

function shouldPropagateContinuityFrame(fields:ReadonlySet<ContinuityField>):boolean{
  return FULL_FRAME_CONTINUITY_FIELDS.every(field=>fields.has(field));
}

function editorialShotCompare(project:Pick<FilmProject,'scenes'>,a:Shot,b:Shot):number{
  const sceneA=project.scenes.find(scene=>scene.id===a.sceneId)?.index??0;
  const sceneB=project.scenes.find(scene=>scene.id===b.sceneId)?.index??0;
  return sceneA-sceneB||a.index-b.index||a.id.localeCompare(b.id);
}

export function productionShotOrder(project:Pick<FilmProject,'shots'|'scenes'|'shotDependencies'>):Shot[]{
  const shots=[...project.shots].sort((a,b)=>editorialShotCompare(project,a,b));
  const byId=new Map(shots.map(shot=>[shot.id,shot] as const));

  // Validate the complete non-parallel graph first. Even soft edges describe production
  // intent and a cycle is ambiguous enough that CineForge should not silently guess.
  const allIndegree=new Map<string,number>(shots.map(shot=>[shot.id,0]));
  const allOutgoing=new Map<string,string[]>();
  for(const edge of project.shotDependencies){
    if(edge.relation==='parallel'||!byId.has(edge.fromShotId)||!byId.has(edge.toShotId))continue;
    allIndegree.set(edge.toShotId,(allIndegree.get(edge.toShotId)??0)+1);
    const list=allOutgoing.get(edge.fromShotId)??[];list.push(edge.toShotId);allOutgoing.set(edge.fromShotId,list);
  }
  const cycleReady=shots.filter(shot=>(allIndegree.get(shot.id)??0)===0);
  let visited=0;
  while(cycleReady.length){
    const shot=cycleReady.shift()!;visited++;
    for(const targetId of allOutgoing.get(shot.id)??[]){
      const next=(allIndegree.get(targetId)??0)-1;allIndegree.set(targetId,next);
      if(next===0){const target=byId.get(targetId);if(target)cycleReady.push(target);}
    }
  }
  if(visited!==shots.length){
    const blocked=shots.filter(shot=>(allIndegree.get(shot.id)??0)>0).map(shot=>shot.id).slice(0,16);
    throw new Error(`Shot dependency graph contains a cycle involving: ${blocked.join(', ')||'unknown shots'}.`);
  }

  const hardIndegree=new Map<string,number>(shots.map(shot=>[shot.id,0]));
  const hardOutgoing=new Map<string,string[]>();
  const softPredecessors=new Map<string,Set<string>>();
  for(const edge of project.shotDependencies){
    if(edge.relation==='parallel'||!byId.has(edge.fromShotId)||!byId.has(edge.toShotId))continue;
    if(edge.strength==='hard'){
      hardIndegree.set(edge.toShotId,(hardIndegree.get(edge.toShotId)??0)+1);
      const list=hardOutgoing.get(edge.fromShotId)??[];list.push(edge.toShotId);hardOutgoing.set(edge.fromShotId,list);
    }else{
      const set=softPredecessors.get(edge.toShotId)??new Set<string>();set.add(edge.fromShotId);softPredecessors.set(edge.toShotId,set);
    }
  }

  const ready=shots.filter(shot=>(hardIndegree.get(shot.id)??0)===0);
  const emitted=new Set<string>(),result:Shot[]=[];
  const unresolvedSoft=(shot:Shot)=>[...(softPredecessors.get(shot.id)??[])].filter(id=>!emitted.has(id)).length;
  while(ready.length){
    ready.sort((a,b)=>unresolvedSoft(a)-unresolvedSoft(b)||editorialShotCompare(project,a,b));
    const shot=ready.shift()!;result.push(shot);emitted.add(shot.id);
    for(const targetId of hardOutgoing.get(shot.id)??[]){
      const next=(hardIndegree.get(targetId)??0)-1;hardIndegree.set(targetId,next);
      if(next===0){const target=byId.get(targetId);if(target)ready.push(target);}
    }
  }
  if(result.length!==shots.length)throw new Error('Hard shot dependency scheduling could not resolve every shot.');
  return result;
}

export function assertAcyclicShotDependencies(shots:Shot[],scenes:FilmProject['scenes'],shotDependencies:ShotDependency[]):void{
  productionShotOrder({shots,scenes,shotDependencies});
}

export function currentActualStartFrameAssetId(project:Pick<FilmProject,'shotStates'|'assets'>,shot:Shot):string|undefined{
  if(!shot.actualStartStateId)return undefined;
  const state=project.shotStates.find(item=>item.id===shot.actualStartStateId&&item.shotId===shot.id&&item.role==='actual-start'&&item.status==='current');
  if(!state?.frameAssetId||!project.assets.some(asset=>asset.id===state.frameAssetId))return undefined;
  return state.frameAssetId;
}

function legacyStableId(prefix:string,input:string):string{
  let hash=0x811c9dc5;
  for(let index=0;index<input.length;index++){
    hash^=input.charCodeAt(index);
    hash=Math.imul(hash,0x01000193)>>>0;
  }
  const safePrefix=prefix.replace(/[^a-zA-Z0-9._:-]+/g,'-').slice(0,180)||'id';
  return `${safePrefix}:${hash.toString(16).padStart(8,'0')}`;
}

export function productionStableId(prefix:string,input:string):string{
  let h1=0x6a09e667,h2=0xbb67ae85,h3=0x3c6ef372,h4=0xa54ff53a;
  for(let index=0;index<input.length;index++){
    const k=input.charCodeAt(index);
    h1=Math.imul(h1^k,0x85ebca6b);h2=Math.imul(h2^k,0xc2b2ae35);
    h3=Math.imul(h3^k,0x27d4eb2f);h4=Math.imul(h4^k,0x165667b1);
    h1=(h1^(h2>>>13))>>>0;h2=(h2^(h3>>>11))>>>0;h3=(h3^(h4>>>17))>>>0;h4=(h4^(h1>>>15))>>>0;
  }
  h1=Math.imul(h1^(h1>>>16),0x85ebca6b)>>>0;h2=Math.imul(h2^(h2>>>13),0xc2b2ae35)>>>0;
  h3=Math.imul(h3^(h3>>>16),0x85ebca6b)>>>0;h4=Math.imul(h4^(h4>>>13),0xc2b2ae35)>>>0;
  const digest=[h1,h2,h3,h4].map(value=>value.toString(16).padStart(8,'0')).join('');
  const safePrefix=prefix.replace(/[^a-zA-Z0-9._:-]+/g,'-').slice(0,180)||'id';
  return `${safePrefix}:${digest}`;
}

export function productionFingerprint(prefix:string,input:string):string{
  let a=0x811c9dc5,b=0x9e3779b9,c=0x85ebca6b,d=0xc2b2ae35;
  for(let index=0;index<input.length;index++){
    const value=input.charCodeAt(index);
    a=Math.imul((a^value)>>>0,0x01000193)>>>0;
    b=Math.imul((b^(value+index))>>>0,0x27d4eb2d)>>>0;
    c=Math.imul((c^(value+(a&0xffff)))>>>0,0x165667b1)>>>0;
    d=Math.imul((d^(value+(b>>>16)))>>>0,0x85ebca77)>>>0;
  }
  const safePrefix=prefix.replace(/[^a-zA-Z0-9._:-]+/g,'-').slice(0,180)||'fingerprint';
  const hex=(value:number)=>value.toString(16).padStart(8,'0');
  return `${safePrefix}:${hex(a)}${hex(b)}${hex(c)}${hex(d)}`;
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

function isDefaultSequentialDependency(edge:ShotDependency):boolean{
  const input=`${edge.fromShotId}>${edge.toShotId}`;
  if(![productionStableId('continuity',input),legacyStableId('continuity',input)].includes(edge.id)||edge.relation!=='continuity'||edge.strength!=='soft')return false;
  const matches=(fields:ContinuityField[])=>edge.propagate.length===fields.length&&fields.every(field=>edge.propagate.includes(field));
  return matches(DEFAULT_CONTINUITY_FIELDS)||matches(LEGACY_DEFAULT_CONTINUITY_FIELDS);
}

export function shotStateContentKey(state:Pick<ShotState,
  'shotId'|'role'|'source'|'frameAssetId'|'sourceRenderOutputId'|'derivedFromStateId'|'characters'|'props'|'environment'|'camera'|'actionPhase'|'dialogueState'|'confidence'
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
    dialogueState:state.dialogueState,
    confidence:state.confidence
  });
}

export function shotStateFingerprint(state:Parameters<typeof shotStateContentKey>[0]):string{
  return productionFingerprint('state-content',shotStateContentKey(state));
}

export function invalidateStateCascade(project:FilmProject,rootStateIds:Iterable<string>,reason:string):Set<string>{
  const staleIds=new Set(rootStateIds);
  let changed=true;
  while(changed){
    changed=false;
    for(const state of project.shotStates){
      if(state.status==='stale'||staleIds.has(state.id)||!state.derivedFromStateId||!staleIds.has(state.derivedFromStateId))continue;
      staleIds.add(state.id);
      changed=true;
    }
    for(const shot of project.shots){
      if(!shot.actualStartStateId||!staleIds.has(shot.actualStartStateId))continue;
      for(const state of project.shotStates){
        if(state.shotId!==shot.id||state.role!=='observed-final'||state.status==='stale'||staleIds.has(state.id))continue;
        staleIds.add(state.id);
        changed=true;
      }
    }
  }
  const message=reason.slice(0,4096);
  for(const state of project.shotStates){
    if(!staleIds.has(state.id))continue;
    state.status='stale';
    state.staleReason=message;
  }
  for(const shot of project.shots){
    if(shot.plannedStartStateId&&staleIds.has(shot.plannedStartStateId))shot.plannedStartStateId=undefined;
    if(shot.plannedEndStateId&&staleIds.has(shot.plannedEndStateId))shot.plannedEndStateId=undefined;
    if(shot.observedFinalStateId&&staleIds.has(shot.observedFinalStateId))shot.observedFinalStateId=undefined;
    if(!shot.actualStartStateId||!staleIds.has(shot.actualStartStateId))continue;
    const staleStart=project.shotStates.find(state=>state.id===shot.actualStartStateId);
    if(staleStart?.frameAssetId&&shot.startFrameAssetId===staleStart.frameAssetId)shot.startFrameAssetId=undefined;
    shot.actualStartStateId=undefined;
    shot.latestRenderId=undefined;
    shot.canonicalRenderId=undefined;
    if(['rendered','failed'].includes(shot.status))shot.status='ready';
  }
  reconcileHumanQcTasks(project,new Set(project.shotStates.filter(state=>staleIds.has(state.id)).map(state=>state.shotId)));
  return staleIds;
}

export function invalidateObservedFinalState(project:FilmProject,shotId:string,reason:string):void{
  const shot=project.shots.find(item=>item.id===shotId);
  if(!shot)return;
  const roots=project.shotStates.filter(state=>state.shotId===shotId&&state.role==='observed-final'&&state.status!=='stale');
  if(roots.length)invalidateStateCascade(project,roots.map(state=>state.id),reason);
  shot.observedFinalStateId=undefined;
}

export function rebuildDefaultSequentialDependencies(project:FilmProject,sceneIds?:Iterable<string>,createdAt=new Date().toISOString()):void{
  const scope=new Set(sceneIds??project.scenes.map(scene=>scene.id));
  const shotById=new Map(project.shots.map(shot=>[shot.id,shot] as const));
  const preserved=project.shotDependencies.filter(edge=>{
    const from=shotById.get(edge.fromShotId),to=shotById.get(edge.toShotId);
    if(!from||!to)return false;
    if(!scope.has(from.sceneId)&&!scope.has(to.sceneId))return true;
    return !isDefaultSequentialDependency(edge);
  });
  const defaults=defaultSequentialDependencies(project.shots.filter(shot=>scope.has(shot.sceneId)),createdAt)
    .filter(edge=>!preserved.some(existing=>existing.fromShotId===edge.fromShotId&&existing.toShotId===edge.toShotId));
  project.shotDependencies=[...preserved,...defaults];

  for(const shot of project.shots){
    if(!scope.has(shot.sceneId)||!shot.actualStartStateId)continue;
    const state=project.shotStates.find(item=>item.id===shot.actualStartStateId);
    if(!state||state.status==='stale'||!state.derivedFromStateId)continue;
    const source=project.shotStates.find(item=>item.id===state.derivedFromStateId);
    const stillConnected=Boolean(source&&project.shotDependencies.some(edge=>
      edge.fromShotId===source.shotId&&edge.toShotId===shot.id&&edge.relation!=='parallel'&&edge.propagate.length>0
    ));
    if(!stillConnected)invalidateStateCascade(project,[state.id],'Shot order/dependency topology changed; propagated start state is no longer connected to its source shot.');
  }
  reconcileHumanQcTasks(project,new Set(project.shots.filter(shot=>scope.has(shot.sceneId)).map(shot=>shot.id)));
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

export function continuityFrameForShot(project:FilmProject,shot:Shot|undefined):{assetId:string;source:'observed-final'|'planned-end'}|undefined{
  if(!shot)return undefined;
  const observed=shot.observedFinalStateId?project.shotStates.find(state=>state.id===shot.observedFinalStateId&&state.shotId===shot.id&&state.role==='observed-final'&&state.status==='current'):undefined;
  if(observed?.frameAssetId)return{assetId:observed.frameAssetId,source:'observed-final'};
  if(shot.endFrameAssetId)return{assetId:shot.endFrameAssetId,source:'planned-end'};
  return undefined;
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

    const fields=new Set(edge.propagate);
    const selected=selectFields(sourceState,fields);
    const frameAssetId=shouldPropagateContinuityFrame(fields)?sourceState.frameAssetId:undefined;
    const id=productionFingerprint('state',`${edge.id}:${sourceState.id}:${shotStateContentKey({...sourceState,...selected,frameAssetId,shotId:target.id,role:'actual-start',source:'generated',derivedFromStateId:sourceState.id})}`);
    if(existing?.id===id&&existing.status!=='stale')continue;
    if(existing&&existing.status!=='stale')invalidateStateCascade(project,[existing.id],`Superseded by propagated state from ${sourceShotId}.`);
    const propagated:ShotState={
      id,
      shotId:target.id,
      role:'actual-start',
      source:'generated',
      status:frameAssetId?'current':'unreviewed',
      frameAssetId,
      sourceRenderOutputId:sourceState.sourceRenderOutputId,
      derivedFromStateId:sourceState.id,
      ...selected,
      confidence:sourceState.confidence,
      createdAt
    };
    propagated.fingerprint=shotStateFingerprint(propagated);
    const duplicate=project.shotStates.find(state=>state.id===id);
    if(duplicate)Object.assign(duplicate,propagated);
    else project.shotStates.push(propagated);
    target.actualStartStateId=id;
    if(frameAssetId)target.startFrameAssetId=frameAssetId;
    target.latestRenderId=undefined;
    target.canonicalRenderId=undefined;
    if(['rendered','failed'].includes(target.status))target.status='ready';
    created.push(id);
  }
  return created;
}

export function shotProductionInputKey(project:FilmProject,shot:Shot,profile?:WorkflowProfile):string{
  return productionFingerprint('render-input',profile?shotProjectRenderInputKeyForProfile(project,shot,profile):shotProjectRenderInputKey(project,shot));
}

export function renderOutputProductionInputKey(project:FilmProject,output:RenderOutput):string|undefined{
  if(output.productionInputKey)return output.productionInputKey;
  return project.renderJobs?.find(job=>job.id===output.jobId)?.spec?.productionInputKey;
}

export function currentProductionInputKeyForOutput(project:FilmProject,shot:Shot,output:RenderOutput):string|undefined{
  const job=project.renderJobs?.find(item=>item.id===output.jobId);
  const specProfile=job?.spec?.workflowProfile;
  if(specProfile){
    const currentProfile=project.settings.workflowProfiles.find(profile=>profile.id===specProfile.id);
    if(!currentProfile||!currentProfile.enabled||(currentProfile.purpose??'video')!=='video'||!currentProfile.workflowPath||currentProfile.validation?.structuralStatus!=='valid')return undefined;
    if(job?.spec?.workflowSha256&&currentProfile.validation?.sourceSha256!==job.spec.workflowSha256)return undefined;
    if((currentProfile.modelFingerprint||undefined)!==(job?.spec?.modelFingerprint||undefined))return undefined;
    return shotProductionInputKey(project,shot,currentProfile);
  }
  return shotProductionInputKey(project,shot);
}

export function shotQcInputKey(project:FilmProject,shotId:string,outputId:string,layer:Exclude<QcLayer,'technical'>):string{
  const shot=project.shots.find(item=>item.id===shotId);
  const output=project.renderOutputs.find(item=>item.id===outputId&&item.shotId===shotId);
  const productionInputKey=output?renderOutputProductionInputKey(project,output):undefined;
  const currentProductionInputKey=shot&&output?currentProductionInputKeyForOutput(project,shot,output):undefined;
  const incident=layer==='continuity'
    ? project.shotDependencies
      .filter(edge=>edge.toShotId===shotId&&edge.propagate.length>0&&edge.relation!=='parallel')
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(edge=>{
        const from=project.shots.find(item=>item.id===edge.fromShotId);
        const to=project.shots.find(item=>item.id===edge.toShotId);
        const fromState=from?.observedFinalStateId?project.shotStates.find(state=>state.id===from.observedFinalStateId):undefined;
        const toState=to?.actualStartStateId?project.shotStates.find(state=>state.id===to.actualStartStateId):undefined;
        return{
          id:edge.id,from:edge.fromShotId,to:edge.toShotId,relation:edge.relation,strength:edge.strength,propagate:edge.propagate,
          fromObserved:fromState?{id:fromState.id,status:fromState.status,fingerprint:shotStateFingerprint(fromState)}:undefined,
          toActualStart:toState?{id:toState.id,status:toState.status,fingerprint:shotStateFingerprint(toState)}:undefined
        };
      })
    : [];
  return productionFingerprint('qc-input',JSON.stringify({
    layer,shotId,outputId,productionInputKey,
    currentShotInput:currentProductionInputKey,
    incident
  }));
}

export function latestShotQcResult(
  project:FilmProject,
  shotId:string,
  outputId:string,
  layer:QcLayer,
  inputKey?:string
):FilmProject['qcResults'][number]|undefined{
  let latest:FilmProject['qcResults'][number]|undefined;
  for(const result of project.qcResults){
    if(result.shotId!==shotId||result.renderOutputId!==outputId||result.layer!==layer)continue;
    if(inputKey!==undefined&&result.inputKey!==inputKey)continue;
    if(!latest||result.createdAt>latest.createdAt||result.createdAt===latest.createdAt)latest=result;
  }
  return latest;
}

export function reconcileHumanQcTasks(project:FilmProject,shotIds?:Iterable<string>):string[]{
  const scope=shotIds?new Set(shotIds):undefined;
  const qcByTask=new Map(project.qcResults.filter(result=>result.humanOverrideTaskId).map(result=>[result.humanOverrideTaskId!,result] as const));
  const dismissed:string[]=[];
  const affectedShotIds=new Set<string>();
  const now=new Date().toISOString();
  for(const task of project.humanTasks){
    if(task.status!=='open')continue;
    const linked=qcByTask.get(task.id);
    if(!linked||linked.layer==='technical'||!linked.renderOutputId||!linked.inputKey)continue;
    if(scope&&!scope.has(linked.shotId))continue;
    const shot=project.shots.find(item=>item.id===linked.shotId),output=project.renderOutputs.find(item=>item.id===linked.renderOutputId&&item.shotId===linked.shotId);
    const currentKey=shot&&output?shotQcInputKey(project,linked.shotId,linked.renderOutputId,linked.layer):undefined;
    if(currentKey===linked.inputKey)continue;
    task.status='dismissed';
    task.resolvedAt=now;
    task.resolution='Automatically dismissed because the render/QC/state inputs changed and this review task became stale.';
    dismissed.push(task.id);
    affectedShotIds.add(linked.shotId);
  }
  for(const shotId of affectedShotIds)refreshCanonicalRender(project,shotId);
  return dismissed;
}

export function canonicalTakeReadiness(project:FilmProject,shotId:string,outputId:string):{ready:boolean;blockers:string[]}{
  const blockers:string[]=[];
  const shot=project.shots.find(item=>item.id===shotId);
  const output=project.renderOutputs.find(item=>item.id===outputId&&item.shotId===shotId&&item.mediaType==='video');
  if(!shot)return{ready:false,blockers:['Shot is missing.']};
  if(!output)return{ready:false,blockers:['Render output is missing, belongs to another shot, or is not video.']};

  const recordedInputKey=renderOutputProductionInputKey(project,output);
  const currentInputKey=currentProductionInputKeyForOutput(project,shot,output);
  if(!recordedInputKey)blockers.push('Render output predates production-input provenance and cannot be promoted safely.');
  else if(recordedInputKey!==currentInputKey)blockers.push('Render output was generated from stale shot, reference, workflow, or propagated-state inputs.');

  if(!output.technicalQc?.passed)blockers.push('Technical QC has not passed.');
  const openReview=project.humanTasks.find(task=>task.status==='open'&&task.relatedRenderOutputIds.includes(outputId)&&['manual-qc','verify-continuity'].includes(task.type));
  if(openReview)blockers.push(`Human QC review is still open: ${openReview.title}`);

  for(const layer of ['visual','semantic'] as const){
    const expected=shotQcInputKey(project,shotId,outputId,layer);
    const results=project.qcResults.filter(result=>result.shotId===shotId&&result.renderOutputId===outputId&&result.layer===layer);
    const matching=latestShotQcResult(project,shotId,outputId,layer,expected);
    if(!matching){
      blockers.push(results.length?`${layer} QC is stale for current shot/state inputs.`:`${layer} QC is missing.`);
    }else if(matching.status!=='pass')blockers.push(`${layer} QC is ${matching.status}.`);
    else if(matching.issues.some(issue=>issue.severity==='major'||issue.severity==='blocker'))blockers.push(`${layer} QC PASS contains major or blocker issues.`);
  }

  const hasContinuityDependency=project.shotDependencies.some(edge=>edge.toShotId===shotId&&edge.propagate.length>0&&edge.relation!=='parallel');
  if(hasContinuityDependency){
    const layer='continuity' as const,expected=shotQcInputKey(project,shotId,outputId,layer);
    const results=project.qcResults.filter(result=>result.shotId===shotId&&result.renderOutputId===outputId&&result.layer===layer);
    const matching=latestShotQcResult(project,shotId,outputId,layer,expected);
    if(!matching)blockers.push(results.length?'continuity QC is stale for current dependency/state inputs.':'continuity QC is missing.');
    else if(matching.status!=='pass')blockers.push(`continuity QC is ${matching.status}.`);
    else if(matching.issues.some(issue=>issue.severity==='major'||issue.severity==='blocker'))blockers.push('continuity QC PASS contains major or blocker issues.');
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
