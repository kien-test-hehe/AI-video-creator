import type { AppMachineSettings, CharacterContinuityState, FilmProject, PropContinuityState, QcIssue, QcStatus, Shot } from '../../shared/types';
import { analyzeImagesWithLocalVision, LocalVisionUnavailableError } from './local-vision-service';

export interface AutoQcEvaluation{status:QcStatus;issues:QcIssue[];note?:string;}
export interface ObservedStateDraft{
  characters:CharacterContinuityState[];
  props:PropContinuityState[];
  environment:{locationAssetId?:string;timeOfDay?:string;lighting?:string;weather?:string;notes?:string};
  camera:{shotSize?:string;angle?:string;screenDirection?:string;movement?:string;lensMm?:number;notes?:string};
  actionPhase:string;dialogueState:string;confidence:number;
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

export async function evaluateSemanticQc(machine:AppMachineSettings,shot:Shot,framePaths:string[]):Promise<AutoQcEvaluation>{
  try{
    const contract=`TITLE: ${text(shot.title,500)}\nPROMPT: ${text(shot.prompt,8000)}\nCAMERA: ${text(shot.camera,2000)}\nACTION: ${text(shot.action,4000)}\nDIALOGUE/AUDIO INTENT: ${text(shot.dialogue,3000)}\nCONTINUITY NOTES: ${text(shot.continuityNotes,4000)}`;
    const raw=await analyzeImagesWithLocalVision(machine,
      `These chronological frames must satisfy this shot contract:\n${contract}\nJudge only evidence visible in the supplied frames. Check required subject, location, broad action progression, composition/camera intent and obvious prop/wardrobe requirements. If motion/action cannot be established from sparse frames, use human-verify rather than guessing. Return {"status":"pass|fail|human-verify","issues":[{"code":"...","severity":"info|warning|major|blocker","message":"...","expected":"...","observed":"..."}],"note":"..."}.`,framePaths);
    return normalizeEvaluation(raw,'Shot intent cannot be verified confidently from sampled frames.');
  }catch(error){if(error instanceof LocalVisionUnavailableError)return unavailable(error,'SEMANTIC_REVIEW_REQUIRED');throw error;}
}

export async function evaluateContinuityQc(machine:AppMachineSettings,project:FilmProject,shot:Shot,previousFinalPath:string|undefined,currentFirstPath:string|undefined):Promise<AutoQcEvaluation>{
  const incoming=project.shotDependencies.filter(edge=>edge.toShotId===shot.id&&edge.relation!=='parallel'&&edge.propagate.length>0);
  if(!incoming.length)return{status:'pass',issues:[]};
  if(!previousFinalPath||!currentFirstPath)return{status:'human-verify',issues:[{code:'CONTINUITY_FRAMES_MISSING',severity:'warning',message:'Automatic continuity QC needs both the upstream observed-final frame and the current rendered first frame.'}]};
  const edgeSummary=incoming.map(edge=>`${edge.fromShotId} -> ${edge.toShotId}: ${edge.propagate.join(', ')}`).join('\n');
  try{
    const raw=await analyzeImagesWithLocalVision(machine,
      `Image 1 is the actual observed final frame of an upstream shot. Image 2 is the first rendered frame of the current shot "${text(shot.title,300)}". Continuity fields required by the active dependency graph:\n${edgeSummary}\nCompare identity, wardrobe, held props/object state, location, lighting, screen direction and action phase only where requested. Minor generative texture variation is not a failure. Return {"status":"pass|fail|human-verify","issues":[{"code":"...","severity":"info|warning|major|blocker","message":"...","expected":"...","observed":"..."}],"note":"..."}.`,[previousFinalPath,currentFirstPath]);
    return normalizeEvaluation(raw,'Cross-shot continuity is uncertain.');
  }catch(error){if(error instanceof LocalVisionUnavailableError)return unavailable(error,'CONTINUITY_REVIEW_REQUIRED');throw error;}
}

export async function extractObservedStateDraft(machine:AppMachineSettings,project:FilmProject,shot:Shot,finalFramePath:string):Promise<ObservedStateDraft>{
  const knownCharacters=shot.characterAssetIds.map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({id:asset!.id,name:asset!.name}));
  const knownProps=shot.propAssetIds.map(id=>project.assets.find(asset=>asset.id===id)).filter(Boolean).map(asset=>({id:asset!.id,name:asset!.name}));
  const location=shot.locationAssetId?project.assets.find(asset=>asset.id===shot.locationAssetId):undefined;
  try{
    const raw=await analyzeImagesWithLocalVision(machine,
      `This is the stable final frame of generated shot "${text(shot.title,300)}". Known characters: ${JSON.stringify(knownCharacters)}. Known props: ${JSON.stringify(knownProps)}. Known location: ${JSON.stringify(location?{id:location.id,name:location.name}:null)}. Return strict JSON {"characters":[{"characterAssetId":"known-id-or-empty","label":"...","visible":true,"screenPosition":"left|center|right|offscreen|unknown","pose":"...","facing":"...","gaze":"...","expression":"...","wardrobeAssetId":"","heldPropAssetIds":["known-prop-id"],"notes":"..."}],"props":[{"propAssetId":"known-id-or-empty","label":"...","holderCharacterAssetId":"known-character-id-or-empty","position":"...","state":"...","notes":"..."}],"environment":{"locationAssetId":"known-location-id-or-empty","timeOfDay":"...","lighting":"...","weather":"...","notes":"..."},"camera":{"shotSize":"...","angle":"...","screenDirection":"...","movement":"...","lensMm":0,"notes":"..."},"actionPhase":"what action state is visibly true at this final frame","dialogueState":"unknown unless visibly inferable","confidence":0.0}. Use only supplied ids; omit uncertain ids.`,[finalFramePath]);
    const characterIds=new Set(shot.characterAssetIds),propIds=new Set(shot.propAssetIds);
    const characters:CharacterContinuityState[]=Array.isArray(raw?.characters)?raw.characters.slice(0,16).map((item:any)=>({
      characterAssetId:characterIds.has(item?.characterAssetId)?item.characterAssetId:undefined,label:text(item?.label,500)||undefined,visible:typeof item?.visible==='boolean'?item.visible:undefined,
      screenPosition:['left','center','right','offscreen','unknown'].includes(item?.screenPosition)?item.screenPosition:undefined,pose:text(item?.pose,2000)||undefined,facing:text(item?.facing,1000)||undefined,gaze:text(item?.gaze,1000)||undefined,expression:text(item?.expression,2000)||undefined,wardrobeAssetId:undefined,
      heldPropAssetIds:Array.isArray(item?.heldPropAssetIds)?item.heldPropAssetIds.filter((id:unknown)=>typeof id==='string'&&propIds.has(id)).slice(0,16):[],notes:text(item?.notes,3000)||undefined
    })):[];
    const props:PropContinuityState[]=Array.isArray(raw?.props)?raw.props.slice(0,24).map((item:any)=>({propAssetId:propIds.has(item?.propAssetId)?item.propAssetId:undefined,label:text(item?.label,500)||undefined,holderCharacterAssetId:characterIds.has(item?.holderCharacterAssetId)?item.holderCharacterAssetId:undefined,position:text(item?.position,2000)||undefined,state:text(item?.state,2000)||undefined,notes:text(item?.notes,3000)||undefined})):[];
    const confidence=Number(raw?.confidence);
    return{characters,props,environment:{locationAssetId:location&&raw?.environment?.locationAssetId===location.id?location.id:location?.id,timeOfDay:text(raw?.environment?.timeOfDay,500)||undefined,lighting:text(raw?.environment?.lighting,2000)||undefined,weather:text(raw?.environment?.weather,1000)||undefined,notes:text(raw?.environment?.notes,3000)||undefined},camera:{shotSize:text(raw?.camera?.shotSize,500)||undefined,angle:text(raw?.camera?.angle,1000)||undefined,screenDirection:text(raw?.camera?.screenDirection,1000)||undefined,movement:text(raw?.camera?.movement,1000)||undefined,lensMm:Number.isFinite(Number(raw?.camera?.lensMm))&&Number(raw.camera.lensMm)>0?Number(raw.camera.lensMm):undefined,notes:text(raw?.camera?.notes,3000)||undefined},actionPhase:text(raw?.actionPhase,3000)||text(shot.action,3000),dialogueState:text(raw?.dialogueState,2000)||'unknown',confidence:Number.isFinite(confidence)?Math.max(0,Math.min(1,confidence)):.65};
  }catch(error){
    if(!(error instanceof LocalVisionUnavailableError))throw error;
    return{
      characters:shot.characterAssetIds.map(id=>({characterAssetId:id,label:project.assets.find(asset=>asset.id===id)?.name,heldPropAssetIds:[]})),
      props:shot.propAssetIds.map(id=>({propAssetId:id,label:project.assets.find(asset=>asset.id===id)?.name})),
      environment:{locationAssetId:shot.locationAssetId,timeOfDay:project.scenes.find(scene=>scene.id===shot.sceneId)?.timeOfDay,notes:'Fallback metadata state; local visual extraction unavailable.'},
      camera:{notes:text(shot.camera,3000)||undefined},actionPhase:text(shot.action,3000),dialogueState:shot.dialogue?'planned dialogue; rendered state unverified':'silent/unknown',confidence:.35
    };
  }
}
