import type { AppMachineSettings, CharacterContinuityState, FilmProject, PropContinuityState, QcIssue, QcStatus, Shot, ShotDependency } from '../../shared/types';
import { analyzeImagesWithLocalVision, LocalVisionUnavailableError } from './local-vision-service';
import { OBSERVED_STATE_CONFIDENCE_TASK_PREFIX, productionFingerprint } from '../../shared/production-state';

export interface AutoQcEvaluation{status:QcStatus;issues:QcIssue[];note?:string;}
export interface ObservedStateDraft{
  characters:CharacterContinuityState[];
  props:PropContinuityState[];
  environment:{locationAssetId?:string;timeOfDay?:string;lighting?:string;weather?:string;notes?:string};
  camera:{shotSize?:string;angle?:string;screenDirection?:string;movement?:string;lensMm?:number;notes?:string};
  actionPhase:string;dialogueState:string;confidence:number;
}

export function observedStateDraftFingerprint(draft:ObservedStateDraft):string{
  return productionFingerprint('observed-draft',JSON.stringify({
    characters:draft.characters,
    props:draft.props,
    environment:draft.environment,
    camera:draft.camera,
    actionPhase:draft.actionPhase,
    dialogueState:draft.dialogueState,
    confidence:draft.confidence
  }));
}

export function observedStateReviewTitle(shotTitle:string,draft:ObservedStateDraft):string{
  return `${OBSERVED_STATE_CONFIDENCE_TASK_PREFIX}${shotTitle} · ${observedStateDraftFingerprint(draft)}`;
}

const statuses=new Set<QcStatus>(['pass','fail','unknown','human-verify']);
const severities=new Set<QcIssue['severity']>(['info','warning','major','blocker']);

function text(value:unknown,max=4096):string{const out=value==null?'':String(value);return out.length>max?out.slice(0,max):out;}
function normalizeEvaluation(value:any,fallback='The local visual evaluator returned an uncertain result.'):AutoQcEvaluation{
  const status:QcStatus=statuses.has(value?.status)?value.status:'human-verify';
  const issues:Array<QcIssue>=Array.isArray(value?.issues)?value.issues.slice(0,32).map((issue:any)=>({
    code:text(issue?.code||'AUTO_QC',128)||'AUTO_QC',
    severity:severities.has(issue?.severity)?issue.severity:(status==='fail'?'major':'warning'),
    message:text(issue?.message||fallback,4096)||fallback,
    expected:text(issue?.expected,2048)||undefined,
    observed:text(issue?.observed,2048)||undefined
  })):[];
  if(status!=='pass'&&!issues.length)issues.push({code:'AUTO_QC_UNCERTAIN',severity:status==='fail'?'major':'warning',message:fallback});
  return{status,issues,note:text(value?.note,4096)||undefined};
}

function unavailable(error:unknown,code:string):AutoQcEvaluation{
  const message=error instanceof Error?error.message:String(error);
  return{status:'human-verify',issues:[{code,severity:'warning',message:`Automatic QC could not make a trustworthy decision: ${message}`}]};
}

export async function evaluateVisualQc(machine:AppMachineSettings,shot:Shot,framePaths:string[]):Promise<AutoQcEvaluation>{
  try{
    const raw=await analyzeImagesWithLocalVision(machine,
      `Frames are chronological samples from one generated video take for shot "${text(shot.title,300)}". Inspect visual integrity only: identity drift, severe anatomy/geometry failure, flicker, subject disappearance, accidental cuts, corrupted frames, extreme warping, unreadable composition, or motion collapse. Do not judge story intent here. Return {"status":"pass|fail|human-verify","issues":[{"code":"...","severity":"info|warning|major|blocker","message":"...","observed":"..."}],"note":"..."}. PASS only if no major/blocker defect is visible.`,framePaths);
    return normalizeEvaluation(raw,'Visual integrity is uncertain from the sampled frames.');
  }catch(error){if(error instanceof LocalVisionUnavailableError)return unavailable(error,'VISUAL_REVIEW_REQUIRED');throw error;}
}

export async function evaluateSemanticQc(
  machine:AppMachineSettings,
  project:FilmProject,
  shot:Shot,
  framePaths:string[],
  referenceImages:SemanticReferenceImage[]=[]
):Promise<AutoQcEvaluation>{
  try{
    const assetIds=[...new Set([...shot.characterAssetIds,...shot.propAssetIds,...(shot.referenceAssetIds??[]),shot.locationAssetId].filter((id):id is string=>Boolean(id)))];
    const assetContract=assetIds.map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({
      id:asset!.id,kind:asset!.kind,name:asset!.name,notes:text(asset!.notes,3000),continuity:asset!.continuity
    }));
    const takeFrames=framePaths.slice(0,4);
    const refs=referenceImages.slice(0,Math.max(0,8-takeFrames.length));
    const legend=refs.map((ref,index)=>`Image ${takeFrames.length+index+1}: REFERENCE · ${text(ref.label,500)}`).join('\n');
    const contract=`TITLE: ${text(shot.title,500)}\nPROMPT: ${text(shot.prompt,8000)}\nCAMERA: ${text(shot.camera,2000)}\nACTION: ${text(shot.action,4000)}\nDIALOGUE/AUDIO INTENT: ${text(shot.dialogue,3000)}\nCONTINUITY NOTES: ${text(shot.continuityNotes,4000)}\nASSET BIBLE: ${text(JSON.stringify(assetContract),20_000)}`;
    const raw=await analyzeImagesWithLocalVision(machine,
      `Images 1-${takeFrames.length} are chronological frames from the GENERATED TAKE. Any later images are visual REFERENCES, not additional video frames.\n${legend||'No visual reference images were supplied.'}\nThe generated take must satisfy this shot contract:\n${contract}\nJudge only evidence visible in the generated frames. When a matching visual reference is supplied, compare stable identity, wardrobe/prop identity, location identity and other persistent visual anchors against it; do not require identical pose, framing or lighting unless the contract requires them. Check broad action progression and composition/camera intent. If motion/action or identity cannot be established from the available evidence, use human-verify rather than guessing. Return {"status":"pass|fail|human-verify","issues":[{"code":"...","severity":"info|warning|major|blocker","message":"...","expected":"...","observed":"..."}],"note":"..."}.`,
      [...takeFrames,...refs.map(ref=>ref.path)]);
    return normalizeEvaluation(raw,'Shot intent cannot be verified confidently from sampled frames and references.');
  }catch(error){if(error instanceof LocalVisionUnavailableError)return unavailable(error,'SEMANTIC_REVIEW_REQUIRED');throw error;}
}

export interface SemanticReferenceImage{path:string;label:string;}

export function semanticReferenceAssetIds(shot:Shot):string[]{
  return [...new Set([
    ...shot.characterAssetIds,
    ...(shot.locationAssetId?[shot.locationAssetId]:[]),
    ...shot.propAssetIds,
    ...(shot.referenceAssetIds??[])
  ])].slice(0,4);
}

export interface ContinuityQcComparison{edge:ShotDependency;previousFinalPath?:string;}

export async function evaluateContinuityQc(machine:AppMachineSettings,project:FilmProject,shot:Shot,comparisons:ContinuityQcComparison[],currentFirstPath:string|undefined):Promise<AutoQcEvaluation>{
  if(!comparisons.length)return{status:'pass',issues:[]};
  if(!currentFirstPath)return{status:'human-verify',issues:[{code:'CONTINUITY_CURRENT_FRAME_MISSING',severity:'warning',message:'Automatic continuity QC needs the current rendered first frame.'}]};
  const evaluations:AutoQcEvaluation[]=[];
  for(const comparison of comparisons){
    const edge=comparison.edge;
    if(!comparison.previousFinalPath){
      evaluations.push({status:'human-verify',issues:[{code:'CONTINUITY_UPSTREAM_FRAME_MISSING',severity:'warning',message:`Automatic continuity QC could not resolve the observed-final frame for upstream shot ${edge.fromShotId}.`}]});
      continue;
    }
    const prior=project.shots.find(item=>item.id===edge.fromShotId);
    const edgeSummary=`${edge.fromShotId} -> ${edge.toShotId} [${edge.strength}]: ${edge.propagate.join(', ')}`;
    try{
      const raw=await analyzeImagesWithLocalVision(machine,
        `Image 1 is the actual observed final frame of upstream shot "${text(prior?.title||edge.fromShotId,300)}". Image 2 is the first rendered frame of current shot "${text(shot.title,300)}". Evaluate ONLY this continuity dependency: ${edgeSummary}. Compare only the requested continuity fields. Camera/screen direction must be judged only when camera is explicitly propagated. Minor generative texture variation is not a failure. Return {"status":"pass|fail|human-verify","issues":[{"code":"...","severity":"info|warning|major|blocker","message":"...","expected":"...","observed":"..."}],"note":"..."}.`,[comparison.previousFinalPath,currentFirstPath]);
      const evaluation=normalizeEvaluation(raw,'Cross-shot continuity is uncertain.');
      evaluations.push({...evaluation,issues:evaluation.issues.map(issue=>({...issue,code:`${edge.id}:${issue.code}`.slice(0,128),message:`[${prior?.title||edge.fromShotId}] ${issue.message}`.slice(0,4096)}))});
    }catch(error){
      if(error instanceof LocalVisionUnavailableError)evaluations.push(unavailable(error,'CONTINUITY_REVIEW_REQUIRED'));
      else throw error;
    }
  }
  const status:QcStatus=evaluations.some(item=>item.status==='fail')?'fail':evaluations.some(item=>item.status==='human-verify'||item.status==='unknown')?'human-verify':'pass';
  return{status,issues:evaluations.flatMap(item=>item.issues).slice(0,128)};
}

export async function selectStableFinalFrame(machine:AppMachineSettings,candidates:string[]):Promise<string>{
  if(!candidates.length)throw new Error('No final-frame candidates were sampled.');
  if(candidates.length===1)return candidates[0];
  try{
    const raw=await analyzeImagesWithLocalVision(machine,
      `The images are chronological candidate frames sampled increasingly close to the end of one generated video. Choose the LATEST frame that is still a useful continuity anchor: not black/faded out, not severely motion-blurred, not corrupted, not mid-transition, and with subjects/props readable. Return {"index":1,"reason":"..."}, where index is 1-based and must reference one supplied image.`,candidates);
    const index=Math.trunc(Number(raw?.index));
    if(index>=1&&index<=candidates.length)return candidates[index-1];
  }catch(error){if(!(error instanceof LocalVisionUnavailableError))throw error;}
  return candidates[Math.max(0,candidates.length-2)];
}

export function observedStateDraftFromVisionResult(project:FilmProject,shot:Shot,raw:any):ObservedStateDraft{
  const propAssetIds=shot.propAssetIds.filter(id=>project.assets.find(asset=>asset.id===id)?.kind==='prop');
  const wardrobeAssetIds=shot.propAssetIds.filter(id=>project.assets.find(asset=>asset.id===id)?.kind==='wardrobe');
  const characterIds=new Set(shot.characterAssetIds),propIds=new Set(propAssetIds),wardrobeIds=new Set(wardrobeAssetIds);
  const location=shot.locationAssetId?project.assets.find(asset=>asset.id===shot.locationAssetId):undefined;
  const characters:CharacterContinuityState[]=Array.isArray(raw?.characters)?raw.characters.slice(0,16).map((item:any)=>({
    characterAssetId:characterIds.has(item?.characterAssetId)?item.characterAssetId:undefined,label:text(item?.label,500)||undefined,visible:typeof item?.visible==='boolean'?item.visible:undefined,
    screenPosition:['left','center','right','offscreen','unknown'].includes(item?.screenPosition)?item.screenPosition:undefined,pose:text(item?.pose,2000)||undefined,facing:text(item?.facing,1000)||undefined,gaze:text(item?.gaze,1000)||undefined,expression:text(item?.expression,2000)||undefined,wardrobeAssetId:wardrobeIds.has(item?.wardrobeAssetId)?item.wardrobeAssetId:undefined,
    heldPropAssetIds:Array.isArray(item?.heldPropAssetIds)?item.heldPropAssetIds.filter((id:unknown)=>typeof id==='string'&&propIds.has(id)).slice(0,16):[],notes:text(item?.notes,3000)||undefined
  })):[];
  const props:PropContinuityState[]=Array.isArray(raw?.props)?raw.props.slice(0,24).map((item:any)=>({propAssetId:propIds.has(item?.propAssetId)?item.propAssetId:undefined,label:text(item?.label,500)||undefined,holderCharacterAssetId:characterIds.has(item?.holderCharacterAssetId)?item.holderCharacterAssetId:undefined,position:text(item?.position,2000)||undefined,state:text(item?.state,2000)||undefined,notes:text(item?.notes,3000)||undefined})):[];
  const confidence=Number(raw?.confidence);
  return{
    characters,
    props,
    environment:{
      locationAssetId:location&&raw?.environment?.locationAssetId===location.id?location.id:undefined,
      timeOfDay:text(raw?.environment?.timeOfDay,500)||undefined,
      lighting:text(raw?.environment?.lighting,2000)||undefined,
      weather:text(raw?.environment?.weather,1000)||undefined,
      notes:text(raw?.environment?.notes,3000)||undefined
    },
    camera:{
      shotSize:text(raw?.camera?.shotSize,500)||undefined,
      angle:text(raw?.camera?.angle,1000)||undefined,
      screenDirection:text(raw?.camera?.screenDirection,1000)||undefined,
      movement:undefined,
      lensMm:Number.isFinite(Number(raw?.camera?.lensMm))&&Number(raw.camera.lensMm)>0?Number(raw.camera.lensMm):undefined,
      notes:text(raw?.camera?.notes,3000)||undefined
    },
    actionPhase:text(raw?.actionPhase,3000),
    dialogueState:'unknown',
    confidence:Number.isFinite(confidence)?Math.max(0,Math.min(1,confidence)):0
  };
}

export async function extractObservedStateDraft(machine:AppMachineSettings,project:FilmProject,shot:Shot,finalFramePath:string):Promise<ObservedStateDraft>{
  const knownCharacters=shot.characterAssetIds.map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({id:asset!.id,name:asset!.name}));
  const propAssetIds=shot.propAssetIds.filter(id=>project.assets.find(asset=>asset.id===id)?.kind==='prop');
  const wardrobeAssetIds=shot.propAssetIds.filter(id=>project.assets.find(asset=>asset.id===id)?.kind==='wardrobe');
  const knownProps=propAssetIds.map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({id:asset!.id,name:asset!.name}));
  const knownWardrobes=wardrobeAssetIds.map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({id:asset!.id,name:asset!.name}));
  const location=shot.locationAssetId?project.assets.find(asset=>asset.id===shot.locationAssetId):undefined;
  try{
    const raw=await analyzeImagesWithLocalVision(machine,
      `This is the stable final frame of generated shot "${text(shot.title,300)}". Known characters: ${JSON.stringify(knownCharacters)}. Known props: ${JSON.stringify(knownProps)}. Known wardrobes: ${JSON.stringify(knownWardrobes)}. Known location: ${JSON.stringify(location?{id:location.id,name:location.name}:null)}. Return strict JSON {"characters":[{"characterAssetId":"known-id-or-empty","label":"...","visible":true,"screenPosition":"left|center|right|offscreen|unknown","pose":"...","facing":"...","gaze":"...","expression":"...","wardrobeAssetId":"known-wardrobe-id-or-empty","heldPropAssetIds":["known-prop-id"],"notes":"..."}],"props":[{"propAssetId":"known-id-or-empty","label":"...","holderCharacterAssetId":"known-character-id-or-empty","position":"...","state":"...","notes":"..."}],"environment":{"locationAssetId":"known-location-id-or-empty","timeOfDay":"...","lighting":"...","weather":"...","notes":"..."},"camera":{"shotSize":"...","angle":"...","screenDirection":"...","lensMm":0,"notes":"..."},"actionPhase":"what action state is visibly true at this final frame","dialogueState":"unknown","confidence":0.0}. Use only supplied ids; omit uncertain ids. A single still frame cannot establish camera movement or dialogue/audio state, so never infer those from this image.`,[finalFramePath]);
    return observedStateDraftFromVisionResult(project,shot,raw);
  }catch(error){
    if(!(error instanceof LocalVisionUnavailableError))throw error;
    return{
      characters:[],
      props:[],
      environment:{notes:'Local visual extraction unavailable; no observed environment facts were inferred.'},
      camera:{notes:'Local visual extraction unavailable; no observed camera facts were inferred.'},
      actionPhase:'',
      dialogueState:'unknown',
      confidence:0
    };
  }
}
