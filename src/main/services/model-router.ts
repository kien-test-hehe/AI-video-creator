import type { FilmProject, Shot, WorkflowProfile } from '../../shared/types';
import { chooseModelForShot } from '../../shared/routing';
import { profileCompatibilityErrors } from './profile-validation';

export function routeWorkflow(project: FilmProject, shot: Shot, forcedProfileId?: string): WorkflowProfile {
  if (forcedProfileId) {
    const forced = project.settings.workflowProfiles.find(p => p.id === forcedProfileId && p.enabled && (p.purpose ?? 'video') === 'video');
    if (!forced) throw new Error(`Forced workflow profile is missing or disabled: ${forcedProfileId}`);
    assertUsableProfile(forced, shot);
    return forced;
  }

  if (shot.generation.workflowProfileId) {
    const explicit = project.settings.workflowProfiles.find(p => p.id === shot.generation.workflowProfileId && p.enabled && (p.purpose ?? 'video') === 'video');
    if (!explicit) throw new Error(`Selected workflow profile is missing or disabled: ${shot.generation.workflowProfileId}`);
    assertUsableProfile(explicit, shot);
    return explicit;
  }

  const candidates = project.settings.workflowProfiles.filter(p =>
    p.enabled &&
    (p.purpose ?? 'video') === 'video' &&
    p.modelFamily === shot.generation.modelFamily &&
    p.mode === shot.generation.mode &&
    p.workflowPath
  );
  if (candidates.length === 0) throw new Error(`No enabled ${shot.generation.modelFamily}/${shot.generation.mode} workflow profile. Import, validate and enable a matching WanGP settings profile or ComfyUI workflow in Settings.`);

  const validated = candidates
    .filter(p=>p.validation?.structuralStatus==='valid'&&profileShotBindingErrors(p,shot).length===0)
    .sort((a,b)=>(b.validation?.lastSuccessfulRenderAt??'').localeCompare(a.validation?.lastSuccessfulRenderAt??'')||a.id.localeCompare(b.id))[0];
  if(!validated){
    const structurallyValid=candidates.filter(p=>p.validation?.structuralStatus==='valid');
    if(structurallyValid.length){
      const detail=structurallyValid.map(profile=>`${profile.name}: ${profileShotBindingErrors(profile,shot).join(' ')}`).join(' | ');
      throw new Error(`No validated ${shot.generation.modelFamily}/${shot.generation.mode} workflow can bind the current shot inputs. ${detail}`);
    }
    throw new Error(`No validated ${shot.generation.modelFamily}/${shot.generation.mode} workflow profile. Validate a matching profile in Settings before rendering.`);
  }
  return validated;
}

function assertUsableProfile(profile: WorkflowProfile, shot: Shot): void {
  if (!profile.workflowPath) throw new Error(`Workflow profile has no workflow path: ${profile.name}`);
  if(profile.validation?.structuralStatus!=='valid')throw new Error(`Workflow profile is ${profile.validation?.structuralStatus||'unvalidated'}: ${profile.name}. Validate it before production use.`);
  const mismatch = [...profileCompatibilityErrors(profile,shot),...profileShotBindingErrors(profile,shot)];
  if (mismatch.length) throw new Error(`${profile.name}: ${mismatch.join(' ')}`);
}

export function profileShotBindingErrors(profile:WorkflowProfile,shot:Shot):string[]{
  const keys=new Set(profile.bindings.map(binding=>binding.key));
  const required:Array<[string|undefined,string,string]>= [
    [shot.startFrameAssetId,'startImage','start frame'],
    [shot.endFrameAssetId,'endImage','end frame'],
    [shot.referenceVideoAssetId,'inputVideo','motion/reference video'],
    [shot.audioAssetId,'inputAudio','input audio']
  ];
  return required
    .filter(([assetId,key])=>Boolean(assetId)&&!keys.has(key as any))
    .map(([,key,label])=>`Shot has a ${label}, but this profile has no ${key} binding.`);
}

export const autoChooseModel = chooseModelForShot;
