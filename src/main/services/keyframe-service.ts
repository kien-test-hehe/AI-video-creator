import { randomUUID } from 'node:crypto';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { AppMachineSettings, Asset, FilmProject, KeyframeRequest, Shot, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { ComfyClient, cineforgePromptIdentitiesByMetadata, hasActiveComfyPrompts } from './comfy-client';
import { compileProfile, type WorkflowValues } from './workflow-engine';
import { compileWanGpProfile } from './wangp-engine';
import { collectWanGpOutputs, outputMediaType, startWanGp, stopWanGpDocker, waitWanGp } from './wangp-runner';
import { mapJsonHostPathsForWanGp } from './runtime-path-mapper';
import { collectComfyHistoryOutputRefs, inferMediaType } from './comfy-output';
import { waitForComfyCompletion, waitForComfyPromptRelease } from './comfy-runner';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertPathInside, assertSafeWritePath, ensureSafeDirectory } from './path-safety';
import { fingerprintRuntime, sha256File } from './runtime-fingerprint';
import { killProcessTree } from './process-utils';
import { planShotReferences } from './reference-plan';
import { keyframeProjectInputKey } from '../../shared/shot-signature';
import { stageWorkflowProfileSnapshot } from './workflow-snapshot';
import { KeyframeLeaseStore, recoverOrphanedKeyframeLease, type KeyframeLease } from './keyframe-lease';

function keyframePrompt(shot:Shot,role:'start'|'end'):string{
  const temporal=role==='start'?'Create the opening hero frame before the described motion begins.':'Create the final hero frame after the described action has resolved.';
  return[shot.prompt,temporal,shot.camera&&`Camera: ${shot.camera}`,shot.action&&`Action context: ${shot.action}`,shot.continuityNotes&&`Continuity: ${shot.continuityNotes}`,'Single cinematic still frame. No split screen, no storyboard grid.'].filter(Boolean).join('\n');
}

function chooseProfile(project:FilmProject,id:string):WorkflowProfile{
  const profile=project.settings.workflowProfiles.find(p=>p.id===id&&p.enabled);if(!profile)throw new Error('Keyframe workflow profile is missing or disabled.');
  if((profile.purpose??'video')!=='image')throw new Error('Selected workflow profile is not marked as an image workflow.');
  if(!profile.workflowPath)throw new Error('Keyframe workflow profile has no workflow/settings path.');
  if(profile.validation?.structuralStatus!=='valid')throw new Error('Validate the keyframe profile in Settings before using it.');
  return profile;
}

interface KeyframeAssetFingerprint{assetId:string;projectPath:string;sha256:string}

async function assertKeyframeSnapshotCurrent(
  projects:ProjectService,
  machine:AppMachineSettings,
  baseline:{projectId:string;rootPath:string;shotId:string;role:'start'|'end';profileId:string;inputSignature:string;workflowSha256:string;runtimeFingerprint:string;assetFingerprints:Map<string,KeyframeAssetFingerprint>},
  checkRuntime:boolean
):Promise<void>{
  const current=projects.getCurrent();
  if(!current||current.id!==baseline.projectId||current.rootPath!==baseline.rootPath)throw new Error('The project changed while keyframe generation was running.');
  const shot=current.shots.find(item=>item.id===baseline.shotId),profile=current.settings.workflowProfiles.find(item=>item.id===baseline.profileId);
  if(!shot||!profile||keyframeProjectInputKey(current,shot,baseline.role,profile)!==baseline.inputSignature)throw new Error('The shot or keyframe workflow configuration changed while generation was running.');
  const workflowPath=await assertExistingPathInside(join(current.rootPath,'workflows'),assertPathInside(join(current.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`),`workflow path for ${profile.name}`);
  if(await sha256File(workflowPath)!==baseline.workflowSha256)throw new Error('The keyframe workflow file changed while generation was running.');
  for(const fp of baseline.assetFingerprints.values()){
    const asset=current.assets.find(item=>item.id===fp.assetId);
    if(!asset||asset.projectPath!==fp.projectPath)throw new Error(`A keyframe input asset changed or was removed while generation was running: ${fp.assetId}`);
    const path=await assertExistingRelativeProjectPath(current.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
    if(await sha256File(path)!==fp.sha256)throw new Error(`A keyframe input asset changed while generation was running: ${asset.name}`);
  }
  if(checkRuntime){
    const runtime=await fingerprintRuntime(machine,profile);
    if(runtime.environmentSha256!==baseline.runtimeFingerprint)throw new Error('The local AI runtime changed before keyframe submission. Revalidate the profile and generate again.');
  }
}

export async function generateKeyframe(projects:ProjectService,machine:AppMachineSettings,request:KeyframeRequest,leaseStore:KeyframeLeaseStore,signal?:AbortSignal):Promise<FilmProject>{
  throwIfAborted(signal);
  const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');if(project.rootPath!==request.projectRoot)throw new Error('Keyframe request does not match the open project.');
  const shot=project.shots.find(s=>s.id===request.shotId);if(!shot)throw new Error('Shot not found.');
  const profile=chooseProfile(project,request.workflowProfileId),inputSignature=keyframeProjectInputKey(project,shot,request.role,profile);
  const workflowPath=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`),`workflow path for ${profile.name}`);
  if(!profile.validation?.sourceSha256)throw new Error('Keyframe profile has no validated source fingerprint. Revalidate it first.');
  const workflowSha256=await sha256File(workflowPath);
  if(workflowSha256!==profile.validation.sourceSha256)throw new Error('Keyframe profile changed after validation. Revalidate it first.');
  if(!profile.validation.runtimeFingerprint)throw new Error('Keyframe profile has no validated runtime fingerprint. Revalidate it on this workstation.');
  const currentRuntime=await fingerprintRuntime(machine,profile);
  if(currentRuntime.environmentSha256!==profile.validation.runtimeFingerprint)throw new Error('Local AI runtime changed after keyframe profile validation. Revalidate it before generating keyframes.');

  const assetFingerprints=new Map<string,KeyframeAssetFingerprint>();
  const values:WorkflowValues={prompt:keyframePrompt(shot,request.role),negativePrompt:shot.generation.negativePrompt,width:shot.generation.width,height:shot.generation.height,resolution:`${shot.generation.width}x${shot.generation.height}`,frames:1,fps:1,steps:shot.generation.steps,cfg:shot.generation.cfg,seed:shot.generation.seed+(request.role==='end'?1:0),filenamePrefix:`cineforge/keyframes/${shot.id}/${request.role}`};
  const assetPath=async(id:string)=>{
    const asset=project.assets.find(item=>item.id===id);if(!asset)throw new Error(`Referenced asset not found: ${id}`);
    const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
    if(!assetFingerprints.has(id))assetFingerprints.set(id,{assetId:id,projectPath:asset.projectPath,sha256:await sha256File(path)});
    return path;
  };
  const plan=planShotReferences(shot,profile);
  if(plan.locationId)values.locationImage=await assetPath(plan.locationId);
  for(const[index,id]of plan.characterIds.entries())if(id)Object.assign(values,{[`characterImage${index+1}`]:await assetPath(id)});
  for(const[index,id]of plan.propIds.entries())if(id)Object.assign(values,{[`propImage${index+1}`]:await assetPath(id)});
  const genericPaths=await Promise.all(plan.genericIds.map(id=>assetPath(id)));
  if(plan.genericArray)values.referenceImages=genericPaths;
  else for(const[index,key]of plan.genericBindingKeys.entries())Object.assign(values,{[key]:genericPaths[index]});

  if(request.role==='end'&&shot.startFrameAssetId){
    const startPath=await assetPath(shot.startFrameAssetId),keys=new Set(profile.bindings.map(binding=>binding.key));
    if(profile.mode==='i2i'&&keys.has('startImage'))values.startImage=startPath;
    else if(plan.genericArray)values.referenceImages=[startPath,...(values.referenceImages??[])].slice(0,plan.genericCapacity);
    else if(plan.genericBindingKeys.length){
      const shifted=[startPath,...genericPaths].slice(0,plan.genericBindingKeys.length);
      for(const[index,key]of plan.genericBindingKeys.entries())Object.assign(values,{[key]:shifted[index]});
    }
  }

  const baseline={projectId:project.id,rootPath:project.rootPath,shotId:shot.id,role:request.role,profileId:profile.id,inputSignature,workflowSha256,runtimeFingerprint:currentRuntime.environmentSha256,assetFingerprints};
  const assertCurrent=(checkRuntime=true)=>assertKeyframeSnapshotCurrent(projects,machine,baseline,checkRuntime);
  const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui'),workflowSnapshotRoot=join(project.rootPath,'cache','keyframe-workflows',randomUUID());
  const leaseId=randomUUID(),runId=`keyframe-${leaseId}`;
  let lease:KeyframeLease={version:1,id:leaseId,projectId:project.id,runtime,runId,phase:'prepared',comfyUrl:runtime==='comfyui'?machine.comfy.url:undefined,wanGpExecutionMode:runtime==='wangp'?machine.wangp.executionMode:undefined,dockerCommand:runtime==='wangp'&&machine.wangp.executionMode==='docker'?machine.wangp.docker.command:undefined,createdAt:new Date().toISOString()};
  await leaseStore.write(lease);
  let leaseActivated=false,generatedPath:string;
  const markSubmitting=async()=>{if(leaseActivated)return;leaseActivated=true;lease={...lease,phase:'submitting'};await leaseStore.write(lease);};
  try{
    const snapshotProfile=await stageWorkflowProfileSnapshot(project.rootPath,profile,workflowSha256,workflowSnapshotRoot);
    if(runtime==='wangp')generatedPath=await generateWithWanGp(project,machine,snapshotProfile,values,shot,request.role,assetFingerprints,assertCurrent,runId,markSubmitting,signal);
    else generatedPath=await generateWithComfy(project,machine,snapshotProfile,values,shot,request.role,assetFingerprints,assertCurrent,leaseId,markSubmitting,signal);
    await leaseStore.clear();
  }catch(error){
    if(leaseActivated)await recoverOrphanedKeyframeLease(leaseStore,machine);
    else await leaseStore.clear().catch(()=>undefined);
    throw error;
  }finally{await rm(workflowSnapshotRoot,{recursive:true,force:true}).catch(()=>undefined);}
  throwIfAborted(signal);

  try{await assertCurrent(true);}
  catch(error){await rm(generatedPath,{force:true}).catch(()=>undefined);throw error;}
  const assetId=randomUUID(),extension=extname(generatedPath)||'.png',relativePath=join('assets','keyframe',`${shot.id}-${request.role}-${assetId}${extension}`);
  const keyframeAssetDir=await ensureSafeDirectory(join(project.rootPath,'assets'),join(project.rootPath,'assets','keyframe'),'generated keyframe directory');
  const target=await assertSafeWritePath(keyframeAssetDir,join(project.rootPath,relativePath),'generated keyframe');
  await copyFile(generatedPath,target);await rm(generatedPath,{force:true}).catch(()=>undefined);
  const asset:Asset={id:assetId,kind:'keyframe',name:`${shot.title} ${request.role} keyframe`,sourcePath:`generated-${request.role}${extension}`,projectPath:relativePath,tags:['generated','keyframe',request.role,profile.modelFamily],notes:`Generated locally with profile ${profile.name}.`,createdAt:new Date().toISOString()};
  try{
    return await projects.mutate(p=>{
      const targetShot=p.shots.find(s=>s.id===shot.id),targetProfile=p.settings.workflowProfiles.find(item=>item.id===profile.id);
      if(!targetShot||!targetProfile||keyframeProjectInputKey(p,targetShot,request.role,targetProfile)!==inputSignature)throw new Error('The shot or keyframe workflow changed before the generated frame could be attached.');
      p.assets.push(asset);
      if(request.role==='start')targetShot.startFrameAssetId=asset.id;else targetShot.endFrameAssetId=asset.id;
      targetShot.latestRenderId=undefined;
      if(['draft','rendered','failed'].includes(targetShot.status))targetShot.status='ready';
    });
  }catch(error){await rm(target,{force:true}).catch(()=>undefined);throw error;}
}

async function stageWanGpKeyframeInputs(project:FilmProject,values:WorkflowValues,root:string,fingerprints:Map<string,KeyframeAssetFingerprint>):Promise<void>{
  const expectedByPath=new Map<string,string>();
  for(const fp of fingerprints.values()){
    const asset=project.assets.find(item=>item.id===fp.assetId);if(!asset)throw new Error(`Referenced asset not found: ${fp.assetId}`);
    const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
    expectedByPath.set(path,fp.sha256);
  }
  root=await ensureSafeDirectory(join(project.rootPath,'cache'),root,'keyframe immutable input directory');
  const staged=new Map<string,string>();let index=0;
  const stage=async(source:string)=>{
    const cached=staged.get(source);if(cached)return cached;
    const expected=expectedByPath.get(source);if(!expected)throw new Error(`Keyframe input is not covered by the immutable asset snapshot: ${source}`);
    const target=await assertSafeWritePath(root,join(root,`${String(index++).padStart(2,'0')}-${basename(source).replace(/[^a-zA-Z0-9._-]+/g,'_')||'input.bin'}`),'keyframe immutable input');
    await copyFile(source,target);
    if(await sha256File(target)!==expected)throw new Error(`Keyframe input changed while staging: ${basename(source)}`);
    staged.set(source,target);return target;
  };
  const scalarKeys=['startImage','endImage','locationImage','characterImage1','characterImage2','characterImage3','characterImage4','propImage1','propImage2','referenceImage1','referenceImage2','referenceImage3','referenceImage4'] as const;
  for(const key of scalarKeys){const value=values[key];if(typeof value==='string'&&value)(values as any)[key]=await stage(value);}
  if(values.referenceImages)values.referenceImages=await Promise.all(values.referenceImages.map(stage));
}

async function generateWithWanGp(project:FilmProject,machine:AppMachineSettings,profile:WorkflowProfile,values:WorkflowValues,shot:Shot,role:'start'|'end',assetFingerprints:Map<string,KeyframeAssetFingerprint>,assertCurrent:(checkRuntime?:boolean)=>Promise<void>,runId:string,markSubmitting:()=>Promise<void>,signal?:AbortSignal):Promise<string>{
  const cache=await ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','keyframes',runId),'WanGP keyframe cache directory');
  try{
    await stageWanGpKeyframeInputs(project,values,join(cache,'inputs'),assetFingerprints);
    let compiled=await compileWanGpProfile(profile,values);compiled=mapJsonHostPathsForWanGp(project,machine,compiled);
    const settingsPath=await assertSafeWritePath(cache,join(cache,'settings.json'),'WanGP keyframe settings'),outputDir=await ensureSafeDirectory(cache,join(cache,'output'),'WanGP keyframe output directory');await writeFile(settingsPath,JSON.stringify(compiled,null,2),'utf8');
    const run=async(dryRun:boolean)=>{
      throwIfAborted(signal);await assertCurrent(true);await markSubmitting();throwIfAborted(signal);
      const child=startWanGp(project,machine,{settingsPath,outputDir,dryRun,runId});
      const onAbort=()=>{if(machine.wangp.executionMode==='docker')void stopWanGpDocker(machine,runId);else if(child.pid)void killProcessTree(child.pid);};
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
      try{await waitWanGp(child);throwIfAborted(signal);}
      catch(error){if(signal?.aborted)throw new Error('Keyframe generation cancelled.');throw error;}
      finally{signal?.removeEventListener('abort',onAbort);}
    };
    if(machine.wangp.dryRunBeforeRender)await run(true);
    await run(false);
    const files=await collectWanGpOutputs(outputDir);const image=files.find(path=>outputMediaType(path)==='image');if(!image)throw new Error(`WanGP keyframe profile completed but returned no image for ${shot.title} ${role}.`);
    const stageDir=await ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','keyframe-stage'),'keyframe staging directory'),durable=await assertSafeWritePath(stageDir,join(stageDir,`${randomUUID()}${extname(image)||'.png'}`),'staged keyframe output');await copyFile(image,durable);return durable;
  }finally{await rm(cache,{recursive:true,force:true}).catch(()=>undefined);}
}

async function generateWithComfy(project:FilmProject,machine:AppMachineSettings,profile:WorkflowProfile,values:WorkflowValues,shot:Shot,role:'start'|'end',assetFingerprints:Map<string,KeyframeAssetFingerprint>,assertCurrent:(checkRuntime?:boolean)=>Promise<void>,submissionId:string,markSubmitting:()=>Promise<void>,signal?:AbortSignal):Promise<string>{
  if(!machine.comfy.dedicatedInstance)throw new Error('ComfyUI keyframe generation requires a dedicated CineForge instance so cancellation cannot interrupt unrelated work.');
  throwIfAborted(signal);
  const client=new ComfyClient(machine.comfy.url,true);const ping=await client.ping();if(!ping.reachable)throw new Error(`ComfyUI unavailable: ${ping.error||machine.comfy.url}`);
  throwIfAborted(signal);
  const expectedByPath=new Map<string,string>();
  for(const fp of assetFingerprints.values()){
    const asset=project.assets.find(item=>item.id===fp.assetId);if(!asset)throw new Error(`Referenced asset not found: ${fp.assetId}`);
    const path=await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`);
    expectedByPath.set(path,fp.sha256);
  }
  const snapshotRoot=await ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','keyframe-comfy-inputs',randomUUID()),'ComfyUI keyframe immutable input directory');
  const stagedBySource=new Map<string,string>();let snapshotIndex=0;
  const stageImage=async(path:string)=>{
    const cached=stagedBySource.get(path);if(cached)return cached;
    throwIfAborted(signal);
    const expected=expectedByPath.get(path);if(!expected)throw new Error(`Keyframe Comfy input is not covered by the immutable asset snapshot: ${path}`);
    const snapshot=await assertSafeWritePath(snapshotRoot,join(snapshotRoot,`${String(snapshotIndex++).padStart(2,'0')}-${basename(path).replace(/[^a-zA-Z0-9._-]+/g,'_')||'input.bin'}`),'keyframe Comfy immutable input');
    await copyFile(path,snapshot);
    if(await sha256File(snapshot)!==expected)throw new Error(`Keyframe input changed while staging the immutable ComfyUI snapshot: ${basename(path)}`);
    const uploaded=await client.uploadImage(snapshot),staged=uploaded.subfolder?`${uploaded.subfolder}/${uploaded.filename}`:uploaded.filename;
    stagedBySource.set(path,staged);return staged;
  };
  try{
    const scalarKeys=['startImage','endImage','locationImage','characterImage1','characterImage2','characterImage3','characterImage4','propImage1','propImage2','referenceImage1','referenceImage2','referenceImage3','referenceImage4'] as const;
    for(const key of scalarKeys){const value=values[key];if(typeof value==='string'&&value)(values as any)[key]=await stageImage(value);}
    if(values.referenceImages?.length)values.referenceImages=await Promise.all(values.referenceImages.map(stageImage));
    throwIfAborted(signal);
    const workflow=await compileProfile(profile,values);await assertCurrent(true);await markSubmitting();throwIfAborted(signal);
    let queued:{prompt_id:string}|undefined;
    try{queued=await client.queuePrompt(workflow,{cineforge:{projectId:project.id,shotId:shot.id,purpose:'keyframe',role,submissionId}});}
    catch(submitError){
      let emptyScans=0;
      while(!queued&&emptyScans<3){
        try{
          const [queue,history]=await Promise.all([client.queue(),client.historyAll()]);
          const matches=cineforgePromptIdentitiesByMetadata(queue,history,{purpose:'keyframe',submissionId});
          if(matches.length>1){
            for(const match of matches.filter(item=>item.state!=='history')){
              try{await client.cancelPrompt(match.promptId);}
              catch{await waitForComfyPromptRelease(client,match.promptId);}
            }
            throw new Error('Multiple ComfyUI prompts matched one keyframe submission; active duplicates were stopped. Retry the keyframe explicitly.');
          }
          if(matches.length===1){queued={prompt_id:matches[0].promptId};break;}
          if(hasActiveComfyPrompts(queue)){emptyScans=0;await new Promise(resolve=>setTimeout(resolve,2000));continue;}
          emptyScans+=1;if(emptyScans<3)await new Promise(resolve=>setTimeout(resolve,500));
        }catch(discoveryError){
          if(discoveryError instanceof Error&&/Multiple ComfyUI prompts/.test(discoveryError.message))throw discoveryError;
          await new Promise(resolve=>setTimeout(resolve,2000));
        }
      }
      if(!queued)throw submitError;
    }
    let cancelPromise:Promise<void>|undefined;
    const requestCancel=()=>cancelPromise??=client.cancelPrompt(queued.prompt_id);
    const onAbort=()=>{void requestCancel().catch(()=>undefined);};signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted){
      try{await requestCancel();}
      catch{await waitForComfyPromptRelease(client,queued.prompt_id);}
      throw new Error('Keyframe generation cancelled after ComfyUI released the submitted prompt.');
    }
    let history:any;
    try{history=await waitForComfyCompletion(client,queued.prompt_id,{timeoutMs:60*60_000,cancelled:()=>Boolean(signal?.aborted)});throwIfAborted(signal);}
    catch(error){
      if(signal?.aborted){
        try{await requestCancel();}
        catch{await waitForComfyPromptRelease(client,queued.prompt_id);}
        throw new Error('Keyframe generation cancelled after ComfyUI released the prompt.');
      }
      if(error instanceof Error&&/timed out/i.test(error.message)){
        try{await requestCancel();}
        catch{await waitForComfyPromptRelease(client,queued.prompt_id);}
        throw new Error(`${error.message} ComfyUI prompt release was confirmed before freeing the GPU slot.`);
      }
      await waitForComfyPromptRelease(client,queued.prompt_id);
      throw error;
    }
    finally{signal?.removeEventListener('abort',onAbort);}
    const refs=collectComfyHistoryOutputRefs(history);const imageRef=refs.find(r=>inferMediaType(r.filename)==='image');if(!imageRef)throw new Error('Image workflow completed but returned no image output in history.outputs.');
    const stageDir=await ensureSafeDirectory(join(project.rootPath,'cache'),join(project.rootPath,'cache','keyframe-stage'),'keyframe staging directory'),durable=await assertSafeWritePath(stageDir,join(stageDir,`${randomUUID()}${extname(imageRef.filename)||'.png'}`),'staged ComfyUI keyframe output'),bytes=await client.download(imageRef);await writeFile(durable,bytes);return durable;
  }finally{await rm(snapshotRoot,{recursive:true,force:true}).catch(()=>undefined);}
}

function throwIfAborted(signal?:AbortSignal):void{if(signal?.aborted)throw new Error('Keyframe generation cancelled.');}
