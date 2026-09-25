import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AppMachineSettings, Asset, FilmProject, KeyframeRequest, Shot, WorkflowProfile } from '../../shared/types';
import { ProjectService } from './project-service';
import { ComfyClient } from './comfy-client';
import { compileProfile, type WorkflowValues } from './workflow-engine';
import { compileWanGpProfile } from './wangp-engine';
import { collectWanGpOutputs, outputMediaType, startWanGp, stopWanGpDocker, waitWanGp } from './wangp-runner';
import { mapJsonHostPathsForWanGp } from './runtime-path-mapper';
import { collectComfyFileRefs, inferMediaType, uniqueComfyFileRefs } from './comfy-output';
import { waitForComfyCompletion } from './comfy-runner';
import { assertExistingPathInside, assertExistingRelativeProjectPath, assertPathInside, assertSafeWritePath } from './path-safety';
import { sha256File } from './runtime-fingerprint';
import { killProcessTree } from './process-utils';

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

export async function generateKeyframe(projects:ProjectService,machine:AppMachineSettings,request:KeyframeRequest,signal?:AbortSignal):Promise<FilmProject>{
  throwIfAborted(signal);const project=projects.getCurrent();if(!project)throw new Error('Open a project first.');if(project.rootPath!==request.projectRoot)throw new Error('Keyframe request does not match the open project.');
  const shot=project.shots.find(s=>s.id===request.shotId);if(!shot)throw new Error('Shot not found.');const profile=chooseProfile(project,request.workflowProfileId);
  const workflowPath=await assertExistingPathInside(join(project.rootPath,'workflows'),assertPathInside(join(project.rootPath,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`),`workflow path for ${profile.name}`);
  if(profile.validation?.sourceSha256&&await sha256File(workflowPath)!==profile.validation.sourceSha256)throw new Error('Keyframe profile changed after validation. Revalidate it first.');

  const values:WorkflowValues={prompt:keyframePrompt(shot,request.role),negativePrompt:shot.generation.negativePrompt,width:shot.generation.width,height:shot.generation.height,resolution:`${shot.generation.width}x${shot.generation.height}`,frames:1,fps:1,steps:shot.generation.steps,cfg:shot.generation.cfg,seed:shot.generation.seed+(request.role==='end'?1:0),filenamePrefix:`cineforge/keyframes/${shot.id}/${request.role}`};
  const continuityIds=[...(shot.referenceAssetIds??[]),...shot.characterAssetIds,...(shot.locationAssetId?[shot.locationAssetId]:[]),...shot.propAssetIds];
  const continuityPaths:string[]=[];
  for(const id of [...new Set(continuityIds)].slice(0,10)){
    const asset=project.assets.find(a=>a.id===id);if(asset)continuityPaths.push(await assertExistingRelativeProjectPath(project.rootPath,asset.projectPath,'assets',`asset path for ${asset.name}`));
  }
  values.referenceImages=continuityPaths;
  for(const[i,path]of continuityPaths.slice(0,4).entries())Object.assign(values,{[`referenceImage${i+1}`]:path});
  if(request.role==='end'&&shot.startFrameAssetId){
    const start=project.assets.find(a=>a.id===shot.startFrameAssetId);
    if(start){
      const startPath=await assertExistingRelativeProjectPath(project.rootPath,start.projectPath,'assets',`asset path for ${start.name}`),keys=new Set(profile.bindings.map(binding=>binding.key));
      if(profile.mode==='i2i'&&keys.has('startImage'))values.startImage=startPath;
      if(keys.has('referenceImages'))values.referenceImages=[startPath,...(values.referenceImages??[])].slice(0,10);
      else{
        const slots=['referenceImage1','referenceImage2','referenceImage3','referenceImage4'] as const,existing=(values.referenceImages??[]);
        values.referenceImages=[startPath,...existing].slice(0,slots.filter(key=>keys.has(key)).length);
        values.referenceImages.forEach((path,index)=>Object.assign(values,{[slots[index]]:path}));
      }
    }
  }

  const runtime=profile.runtime??(profile.workflowFormat==='wangp-settings'?'wangp':'comfyui');
  let generatedPath:string;
  if(runtime==='wangp')generatedPath=await generateWithWanGp(project,machine,profile,values,shot,request.role,signal);
  else generatedPath=await generateWithComfy(project,machine,profile,values,shot,request.role,signal);
  throwIfAborted(signal);

  const current=projects.getCurrent();
  if(!current||current.id!==project.id||current.rootPath!==project.rootPath||!current.shots.some(item=>item.id===shot.id)){
    await rm(generatedPath,{force:true}).catch(()=>undefined);
    throw new Error('The project or target shot changed while the keyframe was generating. The generated staging file was discarded safely.');
  }
  const assetId=randomUUID(),extension=extname(generatedPath)||'.png',relativePath=join('assets','keyframe',`${shot.id}-${request.role}-${assetId}${extension}`);
  const target=await assertSafeWritePath(join(project.rootPath,'assets'),join(project.rootPath,relativePath),'generated keyframe');
  await mkdir(join(project.rootPath,'assets','keyframe'),{recursive:true});await copyFile(generatedPath,target);await rm(generatedPath,{force:true}).catch(()=>undefined);
  const asset:Asset={id:assetId,kind:'keyframe',name:`${shot.title} ${request.role} keyframe`,sourcePath:`generated-${request.role}${extension}`,projectPath:relativePath,tags:['generated','keyframe',request.role,profile.modelFamily],notes:`Generated locally with profile ${profile.name}.`,createdAt:new Date().toISOString()};
  return projects.mutate(p=>{p.assets.push(asset);const targetShot=p.shots.find(s=>s.id===shot.id);if(!targetShot)return;if(request.role==='start')targetShot.startFrameAssetId=asset.id;else targetShot.endFrameAssetId=asset.id;if(targetShot.status==='draft')targetShot.status='ready';});
}

async function generateWithWanGp(project:FilmProject,machine:AppMachineSettings,profile:WorkflowProfile,values:WorkflowValues,shot:Shot,role:'start'|'end',signal?:AbortSignal):Promise<string>{
  let compiled=await compileWanGpProfile(profile,values);compiled=mapJsonHostPathsForWanGp(project,machine,compiled);
  const runId=`keyframe-${randomUUID()}`,cache=join(project.rootPath,'cache','keyframes',runId);await mkdir(cache,{recursive:true});
  try{
    const settingsPath=join(cache,'settings.json'),outputDir=join(cache,'output');await mkdir(outputDir,{recursive:true});await writeFile(settingsPath,JSON.stringify(compiled,null,2),'utf8');
    const run=async(dryRun:boolean)=>{
      throwIfAborted(signal);
      const child=startWanGp(project,machine,{settingsPath,outputDir,dryRun,runId});
      const onAbort=()=>{if(machine.wangp.executionMode==='docker')void stopWanGpDocker(machine,runId);else if(child.pid)void killProcessTree(child.pid);};
      signal?.addEventListener('abort',onAbort,{once:true});
      try{await waitWanGp(child);throwIfAborted(signal);}
      catch(error){if(signal?.aborted)throw new Error('Keyframe generation cancelled.');throw error;}
      finally{signal?.removeEventListener('abort',onAbort);}
    };
    if(machine.wangp.dryRunBeforeRender)await run(true);
    await run(false);
    const files=await collectWanGpOutputs(outputDir);const image=files.find(path=>outputMediaType(path)==='image');if(!image)throw new Error(`WanGP keyframe profile completed but returned no image for ${shot.title} ${role}.`);
    const durable=join(project.rootPath,'cache','keyframe-stage',`${randomUUID()}${extname(image)||'.png'}`);await mkdir(join(project.rootPath,'cache','keyframe-stage'),{recursive:true});await copyFile(image,durable);return durable;
  }finally{await rm(cache,{recursive:true,force:true}).catch(()=>undefined);}
}

async function generateWithComfy(project:FilmProject,machine:AppMachineSettings,profile:WorkflowProfile,values:WorkflowValues,shot:Shot,role:'start'|'end',signal?:AbortSignal):Promise<string>{
  if(!machine.comfy.dedicatedInstance)throw new Error('ComfyUI keyframe generation requires a dedicated CineForge instance so cancellation cannot interrupt unrelated work.');
  throwIfAborted(signal);
  const client=new ComfyClient(machine.comfy.url,true);const ping=await client.ping();if(!ping.reachable)throw new Error(`ComfyUI unavailable: ${ping.error||machine.comfy.url}`);
  throwIfAborted(signal);
  if(values.startImage){const uploaded=await client.uploadImage(values.startImage);values.startImage=uploaded.subfolder?`${uploaded.subfolder}/${uploaded.filename}`:uploaded.filename;}
  if(values.referenceImages?.length){
    const staged:string[]=[];
    for(const path of values.referenceImages){
      throwIfAborted(signal);const uploaded=await client.uploadImage(path);
      staged.push(uploaded.subfolder?`${uploaded.subfolder}/${uploaded.filename}`:uploaded.filename);
    }
    values.referenceImages=staged;
    staged.slice(0,4).forEach((path,index)=>Object.assign(values,{[`referenceImage${index+1}`]:path}));
  }
  throwIfAborted(signal);
  const workflow=await compileProfile(profile,values);const queued=await client.queuePrompt(workflow,{cineforge:{projectId:project.id,shotId:shot.id,purpose:'keyframe',role}});
  const onAbort=()=>{void client.interrupt().catch(()=>undefined);};signal?.addEventListener('abort',onAbort,{once:true});
  let history:any;
  try{history=await waitForComfyCompletion(client,queued.prompt_id,{timeoutMs:60*60_000,cancelled:()=>Boolean(signal?.aborted)});throwIfAborted(signal);}
  catch(error){if(signal?.aborted){await client.interrupt().catch(()=>undefined);throw new Error('Keyframe generation cancelled.');}throw error;}
  finally{signal?.removeEventListener('abort',onAbort);}
  const refs=uniqueComfyFileRefs(collectComfyFileRefs(history?.outputs||history));const imageRef=refs.find(r=>inferMediaType(r.filename)==='image');if(!imageRef)throw new Error('Image workflow completed but returned no image output.');
  const bytes=await client.download(imageRef),durable=join(project.rootPath,'cache','keyframe-stage',`${randomUUID()}${extname(imageRef.filename)||'.png'}`);await mkdir(join(project.rootPath,'cache','keyframe-stage'),{recursive:true});await writeFile(durable,bytes);return durable;
}

function throwIfAborted(signal?:AbortSignal):void{if(signal?.aborted)throw new Error('Keyframe generation cancelled.');}
