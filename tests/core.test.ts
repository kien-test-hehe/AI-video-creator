import { describe, expect, it } from 'vitest';
import { parseScreenplay } from '../src/main/services/script-parser';
import { applyBindings, detectWorkflowFormat, suggestBindings, uiWorkflowToApi, validateComfyNodeAvailability, validateProfileBindings, type ApiWorkflow } from '../src/main/services/workflow-engine';
import { assertLocalUrl } from '../src/main/services/local-url';
import { assertPathInside, assertRelativeProjectPath } from '../src/main/services/path-safety';
import { chooseModelForShot } from '../src/shared/routing';
import { deriveHardwarePlan } from '../src/main/services/hardware-advisor';
import type { AppMachineSettings, Asset, FilmProject, RenderJobSpec, Shot, WorkflowProfile } from '../src/shared/types';
import { autoAssignAssetToShot } from '../src/renderer/src/asset-assignment';
import { insertTimelineOutput, isStudioWorkflowReady, reorderTimeline, resolveStudioWorkflow, routeShotToWorkflow, studioPreflightState, studioWorkflowIssue } from '../src/renderer/src/studio-logic';
import { compileWanGpProfile, suggestWanGpBindings } from '../src/main/services/wangp-engine';
import { planShotReferences } from '../src/main/services/reference-plan';
import { cineforgePromptIdentities, cineforgePromptIdentitiesByMetadata, hasActiveComfyPrompts, historyWasInterrupted, promptQueueState } from '../src/main/services/comfy-client';
import { canRefreshProfileValidationFromRender, keyframeProjectInputKey, preserveTrustedProfileValidation, shotKeyframeInputKey, shotProjectRenderInputKey, shotRenderInputKey, workflowExecutionKey } from '../src/shared/shot-signature';
import { continuityReviewInputKey, filterDirectorAssetIds, sceneDirectorInputKey, validatedVideoRouteForModel } from '../src/shared/director-signature';
import { latestPassingVideoTake, takeNeedsConfirmation, takeUseConfirmationMessage } from '../src/shared/take-policy';
import { hasActiveRenderJobs, removedActiveRenderShotIds } from '../src/shared/project-guards';
import { selectRecoveryJob } from '../src/shared/recovery-policy';
import { duplicateTimelineOrderKey, timelineOutputIssue } from '../src/shared/timeline-policy';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { comfyNodeCatalogFingerprint, sha256File } from '../src/main/services/runtime-fingerprint';
import { AppSettingsService } from '../src/main/services/app-settings-service';
import { KeyframeLeaseStore, recoverOrphanedKeyframeLease } from '../src/main/services/keyframe-lease';
import { RenderLeaseStore } from '../src/main/services/render-lease';
import { waitForComfyPromptRelease } from '../src/main/services/comfy-runner';
import { collectComfyHistoryOutputRefs } from '../src/main/services/comfy-output';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileBufferLimited, readJsonFileLimited } from '../src/main/services/json-file';
import { ffmpegConcatFileLine } from '../src/main/services/ffmpeg-service';
import { loadPortableProject } from '../src/main/services/project-schema';

const api: ApiWorkflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'old' }, _meta: { title: 'Positive Prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 1 } }
};

describe('streamed large-file primitives',()=>{
  it('streams SHA-256 fingerprints and bounds buffered file reads',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-stream-hash-')),path=join(root,'asset.bin');
    try{
      const payload=Buffer.alloc(1024*1024+17,0x5a);await writeFile(path,payload);
      expect(await sha256File(path)).toBe(createHash('sha256').update(payload).digest('hex'));
      expect((await readFileBufferLimited(path,'test asset',payload.length)).length).toBe(payload.length);
      await expect(readFileBufferLimited(path,'test asset',payload.length-1)).rejects.toThrow(/too large|safety limit/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('bounded workflow JSON reads',()=>{
  it('parses valid JSON and rejects files that exceed the caller safety limit',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-json-limit-')),small=join(root,'small.json'),large=join(root,'large.json');
    try{
      await writeFile(small,JSON.stringify({ok:true}),'utf8');
      await writeFile(large,JSON.stringify({payload:'x'.repeat(256)}),'utf8');
      expect(await readJsonFileLimited<{ok:boolean}>(small,'test JSON',128)).toEqual({ok:true});
      await expect(readJsonFileLimited(large,'test JSON',64)).rejects.toThrow(/too large|safety limit/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('FFmpeg concat path formatting',()=>{
  it('normalizes Windows separators before writing concat-demuxer file entries',()=>{
    expect(ffmpegConcatFileLine(String.raw`C:\Projects\My Film\clip.mp4`)).toBe("file 'C:/Projects/My Film/clip.mp4'");
  });
});
describe('project schema canonicalization',()=>{
  const baseProject=()=>({
    schemaVersion:2,id:'project-1',name:'Film',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
    story:{title:'Film',logline:'',script:'',notes:''},
    scenes:[{id:'scene-1',index:1,heading:'INT. ROOM',body:'',shotIds:[]}],
    assets:[],
    shots:[{id:'shot-1',sceneId:'scene-1',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false},latestRenderId:'missing-output'}],
    renderJobs:[],
    renderOutputs:[{id:'passing-output',jobId:'missing-job',shotId:'shot-1',path:'/project/renders/take.mp4',filename:'take.mp4',mediaType:'video',createdAt:'2026-01-02T00:00:00.000Z',technicalQc:{checkedAt:'2026-01-02T00:00:00.000Z',passed:true,issues:[],warnings:[]}}],
    timeline:[],settings:{}
  });
  it('rebuilds scene shot membership and repairs an invalid preferred take from QC-passing history',()=>{
    const loaded=loadPortableProject(baseProject(),'/project').project;
    expect(loaded.scenes[0].shotIds).toEqual(['shot-1']);
    expect(loaded.shots[0].latestRenderId).toBe('passing-output');
    expect(loaded.shots[0].status).toBe('rendered');
  });
  it('rejects render outputs that do not have a durable path',()=>{
    const raw=baseProject();raw.renderOutputs[0].path='';
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/render output path is required/i);
  });
  it('rejects render jobs whose immutable spec targets a different shot id',()=>{
    const raw:any=baseProject(),specShot=structuredClone(raw.shots[0]);specShot.id='shot-2';
    raw.renderJobs=[{
      id:'job-1',shotId:'shot-1',createdAt:'2026-01-03T00:00:00.000Z',updatedAt:'2026-01-03T00:00:00.000Z',status:'failed',progress:0,message:'',modelFamily:'ltx-2.5-fast',outputs:[],
      spec:{
        shot:specShot,
        workflowProfile:{id:'wf-1',runtime:'wangp',purpose:'video',name:'WF',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'/project/workflows/wf.json',workflowFormat:'wangp-settings',bindings:[],enabled:true},
        effectivePrompt:'',queuedProjectUpdatedAt:'2026-01-03T00:00:00.000Z',workflowSha256:'0'.repeat(64),assetFingerprints:[],
        runtimeFingerprint:{backend:'wangp',executionMode:'native',environmentSha256:'1'.repeat(64)}
      }
    }];
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/immutable spec shot id .* does not match job shotid/i);
  });

});
describe('screenplay parsing',()=>{it('splits INT/EXT headings',()=>{const scenes=parseScreenplay('INT. GARAGE - NIGHT\nCar waits.\n\nEXT. ROAD - DAWN\nCar moves.');expect(scenes).toHaveLength(2);expect(scenes[0].location).toBe('GARAGE');expect(scenes[1].timeOfDay).toBe('DAWN');});});
describe('strict workflow numeric transforms',()=>{
  it('rejects non-finite ComfyUI numeric transforms instead of writing NaN/null',()=>{
    const workflow:ApiWorkflow={'1':{class_type:'Sampler',inputs:{steps:1}}};
    expect(()=>applyBindings(workflow,[{key:'prompt',selector:{nodeId:'1'},input:'steps',transform:'integer',required:true}],{prompt:'abc',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'})).toThrow(/finite number safely/);
  });
  it('rejects non-finite WanGP numeric transforms',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-wangp-number-')),path=join(root,'settings.json');
    try{
      await writeFile(path,JSON.stringify({prompt:'old',seed:1,steps:1}),'utf8');
      const profile={id:'p',runtime:'wangp' as const,purpose:'video' as const,name:'number',modelFamily:'custom' as const,mode:'t2v' as const,workflowPath:path,workflowFormat:'wangp-settings' as const,enabled:true,bindings:[
        {key:'prompt' as const,jsonPath:'steps',transform:'integer' as const,required:true}
      ]};
      await expect(compileWanGpProfile(profile,{prompt:'abc',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'})).rejects.toThrow(/finite number safely/);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('strict workflow boolean transforms',()=>{
  it('does not coerce the string "false" to true in ComfyUI bindings',()=>{
    const workflow:ApiWorkflow={'1':{class_type:'Switch',inputs:{enabled:true}}};
    const out=applyBindings(workflow,[{key:'prompt',selector:{nodeId:'1'},input:'enabled',transform:'boolean',required:true}],{prompt:'false',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'});
    expect(out['1'].inputs.enabled).toBe(false);
    expect(()=>applyBindings(workflow,[{key:'prompt',selector:{nodeId:'1'},input:'enabled',transform:'boolean',required:true}],{prompt:'maybe',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'})).toThrow(/Cannot transform value to boolean safely/);
  });
  it('does not coerce the string "false" to true in WanGP bindings',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-wangp-bool-')),path=join(root,'settings.json');
    try{
      await writeFile(path,JSON.stringify({prompt:'old',seed:1,enabled:true}),'utf8');
      const profile={id:'p',runtime:'wangp' as const,purpose:'video' as const,name:'bool',modelFamily:'custom' as const,mode:'t2v' as const,workflowPath:path,workflowFormat:'wangp-settings' as const,enabled:true,bindings:[
        {key:'prompt' as const,jsonPath:'enabled',transform:'boolean' as const,required:true}
      ]};
      const compiled=await compileWanGpProfile(profile,{prompt:'false',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'});
      expect(compiled.enabled).toBe(false);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('workflow engine',()=>{
 it('detects and binds API workflow',()=>{expect(detectWorkflowFormat(api)).toBe('api');const suggestions=suggestBindings(api);expect(suggestions.some(b=>b.key==='prompt')).toBe(true);const out=applyBindings(api,[{key:'prompt',selector:{nodeId:'1'},input:'text',required:true}],{prompt:'new',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:2,filenamePrefix:'x'});expect(out['1'].inputs.text).toBe('new');expect(api['1'].inputs.text).toBe('old');});
 it('converts a minimal UI graph using object_info',()=>{const ui={nodes:[{id:1,type:'PrimitiveNode',mode:0,inputs:[],widgets_values:[7]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:3}],widgets_values:[]}],links:[[3,1,0,2,0,'INT']]};const info={PrimitiveNode:{input:{required:{value:['INT',{}]}}},Consumer:{input:{required:{value:['INT',{forceInput:true}]}}}};const converted=uiWorkflowToApi(ui,info);expect(converted.workflow['1'].inputs.value).toBe(7);expect(converted.workflow['2'].inputs.value).toEqual(['1',0]);expect(converted.requiresApiExport).toBe(false);});
 it('does not infer negative_prompt as a positive prompt binding',()=>{
   const workflow:ApiWorkflow={'1':{class_type:'CLIPTextEncode',inputs:{negative_prompt:'bad'},_meta:{title:'Conditioning'}},'2':{class_type:'KSampler',inputs:{seed:1}}};
   const suggestions=suggestBindings(workflow);
   expect(suggestions.some(binding=>binding.key==='prompt'&&binding.selector?.nodeId==='1')).toBe(false);
   expect(suggestions.some(binding=>binding.key==='negativePrompt'&&binding.selector?.nodeId==='1')).toBe(true);
 });
 it('rejects Comfy profiles whose workflow node classes are unavailable in the connected runtime',async()=>{
   const root=await mkdtemp(join(tmpdir(),'cineforge-comfy-nodes-')),path=join(root,'workflow.json');
   await writeFile(path,JSON.stringify({'1':{class_type:'InstalledNode',inputs:{}},'2':{class_type:'MissingCustomNode',inputs:{}}}),'utf8');
   try{
     const profile={id:'p',runtime:'comfyui' as const,purpose:'video' as const,name:'nodes',modelFamily:'custom' as const,mode:'t2v' as const,workflowPath:path,workflowFormat:'api' as const,bindings:[],enabled:false};
     expect(await validateComfyNodeAvailability(profile,{InstalledNode:{}})).toEqual(['ComfyUI node class is unavailable in the connected runtime: MissingCustomNode']);
     expect(await validateComfyNodeAvailability(profile,{InstalledNode:{},MissingCustomNode:{}})).toEqual([]);
   }finally{await rm(root,{recursive:true,force:true});}
 });
 it('rejects a video Comfy profile that cannot receive prompt or seed',async()=>{
   const root=await mkdtemp(join(tmpdir(),'cineforge-comfy-')),path=join(root,'workflow.json');
   await writeFile(path,JSON.stringify({'1':{class_type:'Dummy',inputs:{width:512}}}),'utf8');
   try{
     const issues=await validateProfileBindings({id:'p',runtime:'comfyui',purpose:'video',name:'broken',modelFamily:'custom',mode:'i2v',workflowPath:path,workflowFormat:'api',bindings:[{key:'width',selector:{nodeId:'1'},input:'width'}],enabled:false});
     expect(issues.join(' ')).toMatch(/prompt/i);expect(issues.join(' ')).toMatch(/seed/i);
   }finally{await rm(root,{recursive:true,force:true});}
 });
 it('refuses to silently flatten unknown connected subgraphs',()=>{const ui={nodes:[{id:10,type:'792f0fd8-129e-48eb-9904-8d1aa82154d1',mode:0,inputs:[{name:'image',link:7}],outputs:[{name:'latent',links:[8]}],widgets_values:[]}],links:[]};const converted=uiWorkflowToApi(ui,{});expect(converted.requiresApiExport).toBe(true);expect(converted.warnings.join(' ')).toMatch(/API Format/i);});
});
describe('local-only networking',()=>{it('accepts loopback and blocks public hosts',()=>{expect(assertLocalUrl('http://127.0.0.1:8188').hostname).toBe('127.0.0.1');expect(()=>assertLocalUrl('https://example.com')).toThrow(/Local-only/);});});
function routedShot(overrides:Partial<Shot>={}):Pick<Shot,'dialogue'|'generation'|'camera'|'action'>{const generation:Shot['generation']={modelFamily:'ltx-2.5-fast',mode:'i2v',width:1280,height:720,frames:121,fps:24,steps:8,cfg:1,seed:42,quality:'balanced',includeAudio:false,negativePrompt:''};return{dialogue:'',camera:'locked tripod',action:'A person looks out of a window.',...overrides,generation:{...generation,...(overrides.generation||{})}};}
describe('drag-drop asset assignment',()=>{
 it('assigns visual roles predictably and refuses silent overflow',()=>{
   const shot:Shot={id:'s',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],status:'draft',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}};
   const asset=(id:string,kind:Asset['kind']):Asset=>({id,kind,name:id,sourcePath:id,projectPath:`assets/${id}.png`,tags:[],notes:'',createdAt:new Date(0).toISOString()});
   expect(autoAssignAssetToShot(shot,asset('hero','character')).role).toBe('character');
   expect(autoAssignAssetToShot(shot,asset('look','reference')).role).toBe('visual reference');
   expect(autoAssignAssetToShot(shot,asset('coat','wardrobe')).role).toBe('prop / wardrobe');
   expect(shot.referenceAssetIds).toEqual(['look']);expect(shot.propAssetIds).toEqual(['coat']);
   expect(autoAssignAssetToShot(shot,asset('start','keyframe')).role).toBe('start frame');
   expect(autoAssignAssetToShot(shot,asset('end','image')).role).toBe('end frame');
   expect(autoAssignAssetToShot(shot,asset('extra','image')).ok).toBe(false);
   expect(shot.status).toBe('ready');
 });
});
describe('Studio preflight freshness',()=>{
 it('marks a previously-ready report stale after the project changes',()=>{
   const ready={createdAt:'2026-01-01T00:00:00.000Z',ready:true,issues:[],probe:{} as never};
   expect(studioPreflightState(undefined,undefined,'rev-1')).toBe('unchecked');
   expect(studioPreflightState(ready,'rev-1','rev-1')).toBe('ready');
   expect(studioPreflightState(ready,'rev-1','rev-2')).toBe('stale');
   expect(studioPreflightState({...ready,ready:false},'rev-2','rev-2')).toBe('blocked');
 });
});
describe('Studio workflow routing and timeline drag',()=>{
 it('routes a shot through an enabled profile without losing shot intent fields',()=>{
   const shot:Shot={id:'s',sceneId:'scene',index:1,title:'Shot',prompt:'p',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],status:'draft',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'hero',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:99,negativePrompt:'keep me',includeAudio:true}};
   const result=routeShotToWorkflow(shot,{id:'wf',runtime:'wangp',purpose:'video',name:'Wan motion',modelFamily:'wan-2.2-5b',mode:'i2v',workflowPath:'workflows/wan.json',workflowFormat:'wangp-settings',bindings:[],enabled:true,validation:{structuralStatus:'valid'}});
   expect(result.ok).toBe(true);expect(shot.generation.workflowProfileId).toBe('wf');expect(shot.generation.modelFamily).toBe('wan-2.2-5b');expect(shot.generation.seed).toBe(99);expect(shot.generation.negativePrompt).toBe('keep me');expect(shot.generation.quality).toBe('hero');expect(shot.status).toBe('ready');
 });
 it('refuses drag-routing to unvalidated workflows and auto-resolves a validated candidate first',()=>{
   const shot:Shot={id:'s',sceneId:'scene',index:1,title:'Shot',prompt:'p',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],status:'draft',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}};
   const unvalidated={id:'u',runtime:'wangp' as const,purpose:'video' as const,name:'Unvalidated',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'workflows/u.json',workflowFormat:'wangp-settings' as const,bindings:[],enabled:true,validation:{structuralStatus:'unvalidated' as const}};
   const valid={...unvalidated,id:'v',name:'Validated',workflowPath:'workflows/v.json',validation:{structuralStatus:'valid' as const}};
   expect(routeShotToWorkflow(shot,unvalidated).ok).toBe(false);
   expect(resolveStudioWorkflow([unvalidated,valid],shot)?.id).toBe('v');
   expect(shot.generation.workflowProfileId).toBeUndefined();
 });
 it('never hides a broken explicit workflow behind an auto fallback',()=>{
   const shot:Shot={id:'s',sceneId:'scene',index:1,title:'Shot',prompt:'p',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],status:'draft',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true,workflowProfileId:'explicit'}};
   const explicit={id:'explicit',runtime:'wangp' as const,purpose:'video' as const,name:'Explicit disabled',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'workflows/explicit.json',workflowFormat:'wangp-settings' as const,bindings:[],enabled:false,validation:{structuralStatus:'valid' as const}};
   const fallback={...explicit,id:'fallback',name:'Valid fallback',enabled:true,workflowPath:'workflows/fallback.json'};
   const resolved=resolveStudioWorkflow([explicit,fallback],shot);
   expect(resolved?.id).toBe('explicit');
   expect(isStudioWorkflowReady(resolved,shot)).toBe(false);
   expect(studioWorkflowIssue(resolved,shot)).toMatch(/disabled/i);
 });
 it('inserts a rendered take at the requested canonical timeline position',()=>{
   const project={shots:[{id:'s1'},{id:'s2'}],renderOutputs:[{id:'o1',shotId:'s1',mediaType:'video'},{id:'o2',shotId:'s2',mediaType:'video'}],timeline:[{id:'a',shotId:'s1',renderOutputId:'o1',track:0,order:0,trimInSec:0,volume:1}]} as unknown as FilmProject;
   expect(insertTimelineOutput(project,'o2','a')).toBe(true);expect(project.timeline.map(clip=>clip.renderOutputId)).toEqual(['o2','o1']);expect(project.timeline.map(clip=>clip.order)).toEqual([0,1]);
 });
 it('reorders canonical timeline clips by drag target',()=>{
   const project={timeline:[{id:'a',shotId:'s1',renderOutputId:'o1',track:0,order:0,trimInSec:0,volume:1},{id:'b',shotId:'s2',renderOutputId:'o2',track:0,order:1,trimInSec:0,volume:1},{id:'c',shotId:'s3',renderOutputId:'o3',track:0,order:2,trimInSec:0,volume:1}]} as unknown as FilmProject;
   expect(reorderTimeline(project,'c','a')).toBe(true);expect(project.timeline.map(clip=>clip.id)).toEqual(['c','a','b']);expect(project.timeline.map(clip=>clip.order)).toEqual([0,1,2]);
 });
});
describe('workflow validation authority',()=>{
  it('preserves main validation for metadata-only edits and resets it for execution changes or new profiles',()=>{
    const current:WorkflowProfile={id:'wf',runtime:'wangp',purpose:'video',name:'Old',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'workflows/wf.json',workflowFormat:'wangp-settings',bindings:[{key:'prompt',jsonPath:'prompt'}],enabled:true,validation:{structuralStatus:'valid',sourceSha256:'a'.repeat(64),runtimeFingerprint:'runtime-a'}};
    const renamed=structuredClone(current);renamed.name='Renamed';renamed.notes='metadata only';renamed.validation={structuralStatus:'invalid'};
    expect(preserveTrustedProfileValidation(current,renamed).validation?.structuralStatus).toBe('valid');
    const changed=structuredClone(current);changed.bindings=[{key:'prompt',jsonPath:'generation.prompt'}];changed.validation={structuralStatus:'valid',sourceSha256:'forged'};
    expect(preserveTrustedProfileValidation(current,changed).validation?.structuralStatus).toBe('unvalidated');
    expect(preserveTrustedProfileValidation(undefined,current).validation?.structuralStatus).toBe('unvalidated');
  });
});
describe('stale creative result guards',()=>{
  const shot=():Shot=>({id:'s',sceneId:'scene',index:1,title:'Shot',prompt:'p',camera:'locked',action:'walk',dialogue:'',continuityNotes:'keep coat',characterAssetIds:['char'],locationAssetId:'loc',propAssetIds:[],referenceAssetIds:[],status:'rendered',latestRenderId:'old',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}});
  it('changes render signatures for prompt/reference/generation edits but not runtime status',()=>{
    const a=shot(),b=structuredClone(a);b.status='failed';b.latestRenderId='different';
    expect(shotRenderInputKey(a)).toBe(shotRenderInputKey(b));
    b.prompt='changed';expect(shotRenderInputKey(a)).not.toBe(shotRenderInputKey(b));
  });
  it('changes project render signatures when the effective workflow execution config changes',()=>{
    const base=shot();base.generation.workflowProfileId='wf';
    const profile={id:'wf',runtime:'wangp' as const,purpose:'video' as const,name:'Workflow',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'workflows/wf.json',workflowFormat:'wangp-settings' as const,bindings:[{key:'prompt' as const,jsonPath:'prompt'}],enabled:true,modelFingerprint:'model-a',validation:{structuralStatus:'valid' as const}};
    const project={assets:[{id:'char',kind:'character',name:'Hero',sourcePath:'',projectPath:'assets/char.png',tags:[],notes:'',createdAt:'x'},{id:'loc',kind:'location',name:'Room',sourcePath:'',projectPath:'assets/loc.png',tags:[],notes:'',createdAt:'x'}],settings:{workflowProfiles:[profile]}} as unknown as FilmProject;
    const beforeWorkflow=workflowExecutionKey(profile),before=shotProjectRenderInputKey(project,base);project.settings.workflowProfiles[0].bindings=[{key:'prompt',jsonPath:'generation.prompt'}];
    expect(shotProjectRenderInputKey(project,base)).not.toBe(before);
    expect(workflowExecutionKey(project.settings.workflowProfiles[0])).not.toBe(beforeWorkflow);
  });
  it('does not let an old successful render revalidate a changed workflow profile',()=>{
    const profile:WorkflowProfile={id:'wf',runtime:'wangp',purpose:'video',name:'Workflow',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'workflows/wf.json',workflowFormat:'wangp-settings',bindings:[{key:'prompt',jsonPath:'prompt'}],enabled:true,modelFingerprint:'model-a',validation:{structuralStatus:'valid',sourceSha256:'a'.repeat(64),runtimeFingerprint:'runtime-a'}};
    const spec={shot:shot(),workflowProfile:structuredClone(profile),effectivePrompt:'p',queuedProjectUpdatedAt:'2026-01-01T00:00:00.000Z',workflowSha256:'a'.repeat(64),assetFingerprints:[],runtimeFingerprint:{backend:'wangp',executionMode:'native',environmentSha256:'runtime-a'},modelFingerprint:'model-a'} satisfies RenderJobSpec;
    expect(canRefreshProfileValidationFromRender(profile,spec)).toBe(true);
    const changedBindings=structuredClone(profile);changedBindings.bindings=[{key:'prompt',jsonPath:'generation.prompt'}];
    expect(canRefreshProfileValidationFromRender(changedBindings,spec)).toBe(false);
    const revalidatedAgainstAnotherFile=structuredClone(profile);revalidatedAgainstAnotherFile.validation!.sourceSha256='b'.repeat(64);
    expect(canRefreshProfileValidationFromRender(revalidatedAgainstAnotherFile,spec)).toBe(false);
    const revalidatedAgainstAnotherRuntime=structuredClone(profile);revalidatedAgainstAnotherRuntime.validation!.runtimeFingerprint='runtime-b';
    expect(canRefreshProfileValidationFromRender(revalidatedAgainstAnotherRuntime,spec)).toBe(false);
  });
  it('changes project render signatures when profile validation changes the auto-selected route',()=>{
    const base=shot();base.generation.workflowProfileId=undefined;
    const first={id:'a',runtime:'wangp' as const,purpose:'video' as const,name:'A',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'workflows/a.json',workflowFormat:'wangp-settings' as const,bindings:[{key:'prompt' as const,jsonPath:'prompt'}],enabled:true,validation:{structuralStatus:'unvalidated' as const}};
    const second={id:'b',runtime:'wangp' as const,purpose:'video' as const,name:'B',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'workflows/b.json',workflowFormat:'wangp-settings' as const,bindings:[{key:'prompt' as const,jsonPath:'prompt'}],enabled:true,validation:{structuralStatus:'valid' as const}};
    const project={assets:[{id:'char',kind:'character',name:'Hero',sourcePath:'',projectPath:'assets/char.png',tags:[],notes:'',createdAt:'x'},{id:'loc',kind:'location',name:'Room',sourcePath:'',projectPath:'assets/loc.png',tags:[],notes:'',createdAt:'x'}],settings:{workflowProfiles:[first,second]}} as unknown as FilmProject;
    const before=shotProjectRenderInputKey(project,base);
    project.settings.workflowProfiles[0].validation!.structuralStatus='valid';
    expect(shotProjectRenderInputKey(project,base)).not.toBe(before);
  });
  it('changes keyframe project signatures when the workflow execution config changes',()=>{
    const base=shot();
    const profile={id:'img',runtime:'wangp' as const,purpose:'image' as const,name:'Image',modelFamily:'custom' as const,mode:'i2i' as const,workflowPath:'workflows/image.json',workflowFormat:'wangp-settings' as const,bindings:[{key:'prompt' as const,jsonPath:'prompt'}],enabled:true,validation:{structuralStatus:'valid' as const}};
    const project={settings:{workflowProfiles:[profile]}} as unknown as FilmProject;
    const before=keyframeProjectInputKey(project,base,'start',profile);
    profile.bindings=[{key:'prompt',jsonPath:'generation.prompt'}];
    expect(keyframeProjectInputKey(project,base,'start',profile)).not.toBe(before);
  });
  it('changes end-keyframe signatures when the chained start frame changes',()=>{
    const a=shot(),b=structuredClone(a);a.startFrameAssetId='kf-a';b.startFrameAssetId='kf-b';
    expect(shotKeyframeInputKey(a,'start')).toBe(shotKeyframeInputKey(b,'start'));
    expect(shotKeyframeInputKey(a,'end')).not.toBe(shotKeyframeInputKey(b,'end'));
  });
  it('makes Director signatures sensitive to scene/asset metadata and filters deleted/wrong-kind ids',()=>{
    const project={id:'p',story:{title:'Film',logline:'L',notes:'N'},scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'Body',location:'ROOM',timeOfDay:'DAY',shotIds:['s']}],shots:[shot()],assets:[
      {id:'char',kind:'character',name:'Hero',sourcePath:'',projectPath:'assets/char.png',tags:['lead'],notes:'red coat',createdAt:'x'},
      {id:'loc',kind:'location',name:'Room',sourcePath:'',projectPath:'assets/loc.png',tags:[],notes:'',createdAt:'x'}
    ],settings:{workflowProfiles:[{id:'v',runtime:'wangp',purpose:'video',name:'v',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'workflows/v.json',workflowFormat:'wangp-settings',bindings:[],enabled:true,validation:{structuralStatus:'valid'}}]}} as unknown as FilmProject;
    const before=sceneDirectorInputKey(project,project.scenes[0]);project.assets[0].notes='blue coat';expect(sceneDirectorInputKey(project,project.scenes[0])).not.toBe(before);
    expect(filterDirectorAssetIds(project,'character',['char','loc','missing'])).toEqual(['char']);
    const review=continuityReviewInputKey(project,project.shots[0]);project.shots[0].prompt='new';expect(continuityReviewInputKey(project,project.shots[0])).not.toBe(review);
  });
});
describe('active render project guards',()=>{
  it('detects active renders and rejects structural removal only for active shot ids',()=>{
    const jobs=[
      {shotId:'s1',status:'running' as const},
      {shotId:'s2',status:'done' as const},
      {shotId:'s3',status:'queued' as const}
    ];
    expect(hasActiveRenderJobs(jobs)).toBe(true);
    const project={shots:[{id:'s1'}]} as unknown as FilmProject;
    expect(removedActiveRenderShotIds(project,jobs)).toEqual(['s3']);
    expect(removedActiveRenderShotIds({shots:[{id:'s1'},{id:'s3'}]} as unknown as FilmProject,jobs)).toEqual([]);
  });
});
describe('signed journal recovery policy',()=>{
  const job=(status:any,updatedAt:string)=>({id:'j',shotId:'s',createdAt:'2026-01-01T00:00:00.000Z',updatedAt,status,progress:0,message:'',modelFamily:'ltx-2.5-fast',outputs:[]}) as any;
  it('uses a newer signed active state but never resurrects a newer terminal project state',()=>{
    expect(selectRecoveryJob(job('queued','2026-01-01T00:00:01.000Z'),job('running','2026-01-01T00:00:02.000Z')).job.status).toBe('running');
    const terminal=selectRecoveryJob(job('cancelled','2026-01-01T00:00:03.000Z'),job('running','2026-01-01T00:00:02.000Z'));
    expect(terminal.job.status).toBe('cancelled');expect(terminal.signed).toBe(false);
  });
  it('persists a newer signed terminal state over a stale active project summary',()=>{
    const selected=selectRecoveryJob(job('running','2026-01-01T00:00:01.000Z'),job('cancelled','2026-01-01T00:00:02.000Z'));
    expect(selected.job.status).toBe('cancelled');expect(selected.signed).toBe(true);expect(selected.persistTerminal).toBe(true);
  });
  it('lets an active machine lease make the signed journal authoritative over a newer unsigned terminal summary',()=>{
    const selected=selectRecoveryJob(job('cancelled','2026-01-01T00:00:03.000Z'),job('running','2026-01-01T00:00:02.000Z'),true);
    expect(selected.job.status).toBe('running');expect(selected.signed).toBe(true);expect(selected.persistTerminal).toBe(false);
  });
});
describe('canonical timeline integrity',()=>{
  const output=(id:string,shotId:string,mediaType:'video'|'image'='video')=>({id,jobId:'j',shotId,path:`/tmp/${id}`,filename:id,mediaType,createdAt:'2026-01-01T00:00:00.000Z'}) as any;
  it('rejects cross-shot and non-video output references',()=>{
    const clip={id:'c',shotId:'s1',renderOutputId:'o1'};
    expect(timelineOutputIssue(clip,output('o1','s1'))).toBeUndefined();
    expect(timelineOutputIssue(clip,output('o1','s2'))).toMatch(/belongs to shot s2/);
    expect(timelineOutputIssue(clip,output('o1','s1','image'))).toMatch(/non-video/);
  });
  it('detects duplicate track/order slots',()=>{
    expect(duplicateTimelineOrderKey([{track:0,order:0},{track:0,order:1}])).toBeUndefined();
    expect(duplicateTimelineOrderKey([{track:0,order:0},{track:0,order:0}])).toBe('0:0');
  });
});
describe('rendered take QC policy',()=>{
  const output=(technicalQc?:any)=>({id:'o',jobId:'j',shotId:'s',path:'/tmp/o.mp4',filename:'o.mp4',mediaType:'video' as const,createdAt:'x',technicalQc});
  it('requires confirmation for failed or unknown QC and not for passing takes',()=>{
    expect(takeNeedsConfirmation(output())).toBe(true);
    expect(takeUseConfirmationMessage(output(),'preferred')).toMatch(/no technical QC/i);
    expect(takeUseConfirmationMessage(output({passed:false,issues:['bad duration']}),'timeline')).toMatch(/bad duration/i);
    expect(takeNeedsConfirmation(output({passed:true,issues:[]}))).toBe(false);
    expect(takeUseConfirmationMessage(output({passed:true,issues:[]}),'preferred')).toBeUndefined();
    const passingOld=output({passed:true,issues:[]});passingOld.id='pass-old';passingOld.createdAt='2026-01-01T00:00:00.000Z';
    const failingNew=output({passed:false,issues:['bad']});failingNew.id='fail-new';failingNew.createdAt='2026-01-03T00:00:00.000Z';
    const passingNew=output({passed:true,issues:[]});passingNew.id='pass-new';passingNew.createdAt='2026-01-02T00:00:00.000Z';
    expect(latestPassingVideoTake([passingOld,failingNew,passingNew])?.id).toBe('pass-new');
    expect(latestPassingVideoTake([failingNew])).toBeUndefined();
  });
});
describe('machine settings persistence trust',()=>{
  it('uses strict booleans and backs up trusted memory instead of tampered disk bytes',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-settings-trust-')),bootstrap=join(root,'bootstrap.json'),userdata=join(root,'userdata'),prior=process.env.CINEFORGE_BOOTSTRAP_SETTINGS;
    try{
      await writeFile(bootstrap,JSON.stringify({schemaVersion:1,diagnostics:{persistVerboseLogs:'true'}}),'utf8');
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS=bootstrap;
      const service=new AppSettingsService(userdata);await service.load();
      expect(service.get().diagnostics.persistVerboseLogs).toBe(false);
      const trusted=service.get();trusted.director.model='trusted-a';await service.save(trusted);
      await writeFile(join(userdata,'machine-settings.v1.json'),JSON.stringify({schemaVersion:1,director:{model:'tampered'}}),'utf8');
      const next=service.get();next.director.model='trusted-b';await service.save(next);
      const backup=JSON.parse(await readFile(join(userdata,'machine-settings.v1.backup.json'),'utf8'));
      const primary=JSON.parse(await readFile(join(userdata,'machine-settings.v1.json'),'utf8'));
      expect(backup.director.model).toBe('trusted-a');expect(primary.director.model).toBe('trusted-b');
    }finally{
      if(prior==null)delete process.env.CINEFORGE_BOOTSTRAP_SETTINGS;else process.env.CINEFORGE_BOOTSTRAP_SETTINGS=prior;
      await rm(root,{recursive:true,force:true});
    }
  });
});
describe('machine settings bootstrap failure',()=>{
  it('fails closed when an explicit bootstrap file exists but is invalid',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-bootstrap-invalid-')),bootstrap=join(root,'bootstrap.json'),prior=process.env.CINEFORGE_BOOTSTRAP_SETTINGS;
    try{
      await writeFile(bootstrap,'{broken','utf8');
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS=bootstrap;
      await expect(new AppSettingsService(join(root,'userdata')).load()).rejects.toThrow(/bootstrap settings are present but invalid or unreadable/i);
    }finally{
      if(prior==null)delete process.env.CINEFORGE_BOOTSTRAP_SETTINGS;else process.env.CINEFORGE_BOOTSTRAP_SETTINGS=prior;
      await rm(root,{recursive:true,force:true});
    }
  });
});
describe('machine settings bootstrap import',()=>{
  it('imports explicit bootstrap machine settings on first load and then persists them',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-bootstrap-settings-'));
    const bootstrap=join(root,'bootstrap.json'),prior=process.env.CINEFORGE_BOOTSTRAP_SETTINGS;
    try{
      await writeFile(bootstrap,JSON.stringify({schemaVersion:1,wangp:{rootPath:'C:/CineForge/Wan2GP',pythonPath:'C:/CineForge/Wan2GP/venv/python.exe'},ffmpeg:{path:'C:/ffmpeg.exe',ffprobePath:'C:/ffprobe.exe'}}),'utf8');
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS=bootstrap;
      const service=new AppSettingsService(join(root,'userdata'));await service.load();
      expect(service.get().wangp.rootPath).toBe('C:/CineForge/Wan2GP');
      expect(service.get().ffmpeg.path).toBe('C:/ffmpeg.exe');
      delete process.env.CINEFORGE_BOOTSTRAP_SETTINGS;
      const reloaded=new AppSettingsService(join(root,'userdata'));await reloaded.load();
      expect(reloaded.get().wangp.rootPath).toBe('C:/CineForge/Wan2GP');
    }finally{
      if(prior==null)delete process.env.CINEFORGE_BOOTSTRAP_SETTINGS;else process.env.CINEFORGE_BOOTSTRAP_SETTINGS=prior;
      await rm(root,{recursive:true,force:true});
    }
  });
});
describe('render GPU ownership lease',()=>{
  it('persists a signed active render lease and refuses tampered ownership',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-render-lease-')),store=new RenderLeaseStore(root,Buffer.alloc(32,5));
    try{
      await store.write({version:1,projectId:'project-1',projectRoot:'/projects/one',jobId:'job-1',createdAt:'2026-01-01T00:00:00.000Z'});
      expect((await store.read())?.jobId).toBe('job-1');
      const path=join(root,'active-render.v1.json'),envelope=JSON.parse(await readFile(path,'utf8'));envelope.lease.jobId='job-forged';await writeFile(path,JSON.stringify(envelope),'utf8');
      await expect(store.read()).rejects.toThrow(/signature/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});

describe('keyframe crash recovery lease',()=>{
  it('signs the machine-local lease and clears prepared work without touching a backend',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-keyframe-lease-')),key=Buffer.alloc(32,7),store=new KeyframeLeaseStore(root,key);
    try{
      const lease={version:1 as const,id:'lease-1',projectId:'project-1',runtime:'comfyui' as const,runId:'keyframe-lease-1',phase:'prepared' as const,comfyUrl:'http://127.0.0.1:8188',createdAt:'2026-01-01T00:00:00.000Z'};
      await store.write(lease);expect((await store.read())?.id).toBe('lease-1');
      await recoverOrphanedKeyframeLease(store,{} as AppMachineSettings);
      expect(await store.read()).toBeUndefined();
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('rejects a tampered submitted lease instead of trusting backend identity from disk',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-keyframe-lease-tamper-')),key=Buffer.alloc(32,9),store=new KeyframeLeaseStore(root,key);
    try{
      await store.write({version:1,id:'lease-a',projectId:'project-1',runtime:'wangp',runId:'keyframe-lease-a',phase:'submitting',wanGpExecutionMode:'native',createdAt:'2026-01-01T00:00:00.000Z'});
      const path=join(root,'active-keyframe.v1.json'),envelope=JSON.parse(await readFile(path,'utf8'));envelope.lease.runId='keyframe-forged';await writeFile(path,JSON.stringify(envelope),'utf8');
      await expect(store.read()).rejects.toThrow(/signature/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('render journal signing key safety',()=>{
  it('refuses to rotate a corrupt signing key on an existing installation',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-journal-key-safety-'));
    try{
      const first=new AppSettingsService(root);await first.load();
      await writeFile(join(root,'journal-hmac.key'),'corrupt-key','utf8');
      await expect(new AppSettingsService(root).load()).rejects.toThrow(/signing key/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('machine settings persistence recovery',()=>{
  it('recovers the previous valid machine settings from backup after primary corruption',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-settings-'));
    try{
      const service=new AppSettingsService(root);await service.load();
      const first=service.get();first.director.model='director-first';await service.save(first);
      const second=service.get();second.director.model='director-second';await service.save(second);
      await writeFile(join(root,'machine-settings.v1.json'),'{broken','utf8');
      const recovered=new AppSettingsService(root);await recovered.load();
      expect(recovered.get().director.model).toBe('director-first');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('hardware advisor',()=>{
 it('recognizes a 16 GB RTX 50-series workstation and chooses the managed low-VRAM profile',()=>{
   const plan=deriveHardwarePlan({cpu:{model:'Intel Core i5-14400F',logicalCores:16,physicalCores:10},gpu:{name:'NVIDIA GeForce RTX 5060 Ti',totalVramMb:16384,freeVramMb:15000},memory:{totalMb:48*1024,freeMb:32*1024}});
   expect(plan.tier).toBe('rtx50-16gb');expect(plan.recommendedWanGpProfile).toBe(4);expect(plan.defaultVideoModel).toBe('ltx-2.5-fast');
 });
});
describe('model routing',()=>{
 it('keeps dialogue/audio on LTX 2.5 Fast',()=>{expect(chooseModelForShot(routedShot({dialogue:'Hello.'}))).toBe('ltx-2.5-fast');expect(chooseModelForShot(routedShot({generation:{...routedShot().generation,includeAudio:true}}))).toBe('ltx-2.5-fast');});
 it('routes hero shots to Hunyuan and action shots to Wan',()=>{expect(chooseModelForShot(routedShot({generation:{...routedShot().generation,quality:'hero'}}))).toBe('hunyuan-video-1.5');expect(chooseModelForShot(routedShot({camera:'fast tracking orbit',action:'car chase'}))).toBe('wan-2.2-5b');});
 it('keeps long shots on the managed LTX route instead of auto-selecting optional FramePack',()=>{expect(chooseModelForShot(routedShot({dialogue:'Long dialogue.',generation:{...routedShot().generation,frames:265,fps:24}}))).toBe('ltx-2.5-fast');});
});
describe('project path containment',()=>{const root='/tmp/cineforge-project';it('accepts paths contained by the project',()=>{expect(assertPathInside(root,`${root}/assets/character/a.png`)).toContain('/assets/character/a.png');expect(assertRelativeProjectPath(root,'assets/character/a.png','assets','asset')).toContain('/assets/character/a.png');});it('blocks path traversal and absolute project-relative values',()=>{expect(()=>assertPathInside(root,'/tmp/outside/secret.txt')).toThrow(/outside the allowed project directory/);expect(()=>assertRelativeProjectPath(root,'../outside/secret.txt','assets','asset')).toThrow(/outside the allowed project directory/);expect(()=>assertRelativeProjectPath(root,'/etc/passwd','assets','asset')).toThrow(/project-relative/);});});
describe('continuity/reference workflow bindings',()=>{it('can bind character and location references without mutating the source workflow',()=>{const workflow:ApiWorkflow={'1':{class_type:'LoadImage',inputs:{image:'old-character.png'},_meta:{title:'Character 1'}},'2':{class_type:'LoadImage',inputs:{image:'old-location.png'},_meta:{title:'Location'}}};const bound=applyBindings(workflow,[{key:'characterImage1',selector:{nodeId:'1'},input:'image',required:true},{key:'locationImage',selector:{nodeId:'2'},input:'image',required:true}],{prompt:'shot',negativePrompt:'',width:1280,height:720,frames:121,fps:24,seed:1,characterImage1:'cineforge/char.png',locationImage:'cineforge/location.png',filenamePrefix:'shot'});expect(bound['1'].inputs.image).toBe('cineforge/char.png');expect(bound['2'].inputs.image).toBe('cineforge/location.png');expect(workflow['1'].inputs.image).toBe('old-character.png');});});
describe('WanGP compile media modes',()=>{
 it('activates start/end/reference mode flags when attached assets are bound',async()=>{
   const root=await mkdtemp(join(tmpdir(),'cineforge-wangp-'));
   const path=join(root,'settings.json');
   await writeFile(path,JSON.stringify({prompt:'old',seed:1,image_start:null,image_end:null,image_refs:null,image_prompt_type:'',video_prompt_type:''}),'utf8');
   try{
     const profile={id:'p',runtime:'wangp' as const,purpose:'video' as const,name:'test',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:path,workflowFormat:'wangp-settings' as const,enabled:true,bindings:[
       {key:'prompt' as const,jsonPath:'prompt',required:true},{key:'seed' as const,jsonPath:'seed',required:true},
       {key:'startImage' as const,jsonPath:'image_start'},{key:'endImage' as const,jsonPath:'image_end'},{key:'referenceImages' as const,jsonPath:'image_refs'}
     ]};
     const compiled=await compileWanGpProfile(profile,{prompt:'new',negativePrompt:'',width:1280,height:704,frames:121,fps:24,seed:7,startImage:'start.png',endImage:'end.png',referenceImages:['char.png'],filenamePrefix:'x'});
     expect(compiled.image_prompt_type).toBe('SE');expect(compiled.video_prompt_type).toBe('I');expect(compiled.image_refs).toEqual(['char.png']);
   }finally{await rm(root,{recursive:true,force:true});}
 });
});
describe('AI Director validated route selection',()=>{
  it('returns the actual validated workflow mode for a model family',()=>{
    const project={settings:{workflowProfiles:[
      {id:'wf',runtime:'wangp',purpose:'video',name:'WF',modelFamily:'ltx-2.5-fast',mode:'t2v',workflowPath:'/tmp/wf.json',workflowFormat:'wangp-settings',bindings:[],enabled:true,validation:{structuralStatus:'valid'}}
    ]}} as unknown as FilmProject;
    const route=validatedVideoRouteForModel(project,'ltx-2.5-fast');
    expect(route?.id).toBe('wf');expect(route?.mode).toBe('t2v');
  });
});
describe('binding-aware continuity reference planning',()=>{
  const baseShot:Shot={id:'s',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:['c1','c2'],locationAssetId:'loc',propAssetIds:['p1'],referenceAssetIds:['look'],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}};
  it('does not duplicate assets already served by dedicated bindings into generic refs',()=>{const profile={id:'p',runtime:'wangp' as const,purpose:'video' as const,name:'p',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'x',workflowFormat:'wangp-settings' as const,enabled:true,bindings:[{key:'characterImage1' as const,jsonPath:'character'},{key:'locationImage' as const,jsonPath:'location'},{key:'referenceImages' as const,jsonPath:'image_refs'}]};const plan=planShotReferences(baseShot,profile);expect(plan.characterIds[0]).toBe('c1');expect(plan.locationId).toBe('loc');expect(plan.genericIds).toEqual(['c2','look','p1']);expect(plan.genericIds).not.toContain('c1');expect(plan.genericIds).not.toContain('loc');});
  it('maps fallback images to only the generic slots actually exposed',()=>{const profile={id:'p',runtime:'comfyui' as const,purpose:'video' as const,name:'p',modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,workflowPath:'x',workflowFormat:'api' as const,enabled:true,bindings:[{key:'referenceImage1' as const,selector:{nodeId:'1'},input:'image'},{key:'referenceImage3' as const,selector:{nodeId:'3'},input:'image'}]};const plan=planShotReferences(baseShot,profile);expect(plan.genericBindingKeys).toEqual(['referenceImage1','referenceImage3']);expect(plan.genericIds).toHaveLength(2);expect(plan.unservedIds.length).toBeGreaterThan(0);});
});
describe('Comfy runtime fingerprint inputs',()=>{
  it('changes when node classes or node schemas change but not when object key order changes',()=>{
    expect(comfyNodeCatalogFingerprint({B:{input:{required:{x:['INT']}}},A:{}})).toBe(comfyNodeCatalogFingerprint({A:{},B:{input:{required:{x:['INT']}}}}));
    expect(comfyNodeCatalogFingerprint({A:{},B:{}})).not.toBe(comfyNodeCatalogFingerprint({A:{},C:{}}));
    expect(comfyNodeCatalogFingerprint({A:{input:{required:{x:['INT']}}}})).not.toBe(comfyNodeCatalogFingerprint({A:{input:{required:{x:['FLOAT']}}}}));
  });
});
describe('Comfy output identity',()=>{
  it('collects filenames only from history.outputs and never from prompt/input metadata',()=>{
    const completedWithoutOutputs={status:{completed:true},prompt:{inputs:{filename:'uploaded-input.png',type:'input'}}};
    expect(collectComfyHistoryOutputRefs(completedWithoutOutputs)).toEqual([]);
    const withOutput={outputs:{'7':{images:[{filename:'result.png',subfolder:'cineforge',type:'output'}]}},prompt:{filename:'uploaded-input.png'}};
    expect(collectComfyHistoryOutputRefs(withOutput)).toEqual([{filename:'result.png',subfolder:'cineforge',type:'output'}]);
  });
});
describe('Comfy submission recovery identity',()=>{
  it('finds only exact CineForge job metadata across queue and history',()=>{
    const queue={queue_running:[[1,'run-prompt',{}, {cineforge:{jobId:'job-a'}}]],queue_pending:[[2,'other-prompt',{}, {cineforge:{jobId:'job-b',note:'job-a'}}]]};
    const history={'done-prompt':{prompt:[3,'done-prompt',{}, {cineforge:{jobId:'job-a'}}]},noise:{prompt:[4,'noise',{}, {cineforge:{jobId:'job-c',note:'job-a'}}]}};
    expect(cineforgePromptIdentities(queue,history,'job-a')).toEqual([
      {promptId:'run-prompt',state:'running'},
      {promptId:'done-prompt',state:'history'}
    ]);
    const keyframeQueue={queue_running:[],queue_pending:[[5,'kf-prompt',{}, {cineforge:{purpose:'keyframe',submissionId:'sub-1'}}]]};
    expect(cineforgePromptIdentitiesByMetadata(keyframeQueue,{}, {purpose:'keyframe',submissionId:'sub-1'})).toEqual([{promptId:'kf-prompt',state:'pending'}]);
  });
});
describe('Comfy dedicated active-work detection',()=>{
  it('treats either running or pending queue entries as active GPU work',()=>{
    expect(hasActiveComfyPrompts({queue_running:[[1,'p',{}]],queue_pending:[]})).toBe(true);
    expect(hasActiveComfyPrompts({queue_running:[],queue_pending:[[2,'q',{}]]})).toBe(true);
    expect(hasActiveComfyPrompts({queue_running:[],queue_pending:[]})).toBe(false);
  });
});
describe('Comfy queue identity',()=>{
  it('matches prompt ids only in structured queue entries, not arbitrary metadata text',()=>{
    const queue={queue_running:[[1,'running-id',{note:'target-id'}]],queue_pending:[[2,'pending-id',{prompt:'target-id'}]]};
    expect(promptQueueState(queue,'running-id')).toBe('running');
    expect(promptQueueState(queue,'pending-id')).toBe('pending');
    expect(promptQueueState(queue,'target-id')).toBe('absent');
  });
});
describe('Comfy prompt release safety',()=>{
  it('does not release the GPU lock on a transient state error and waits for exact queue absence',async()=>{
    let historyCalls=0,queueCalls=0;
    const client={
      history:async()=>{historyCalls+=1;if(historyCalls===1)throw new Error('temporary network error');return null;},
      queue:async()=>{queueCalls+=1;return queueCalls===1?{queue_running:[[1,'p',{}]],queue_pending:[]}:{queue_running:[],queue_pending:[]};}
    } as any;
    await waitForComfyPromptRelease(client,'p',{intervalMs:1});
    expect(historyCalls).toBeGreaterThanOrEqual(2);expect(queueCalls).toBeGreaterThanOrEqual(2);
  });
});
describe('Comfy cancellation history',()=>{
  it('distinguishes interrupted history from normal terminal history',()=>{
    expect(historyWasInterrupted({status:{messages:[['execution_interrupted',{prompt_id:'p'}]]}})).toBe(true);
    expect(historyWasInterrupted({status:{messages:[['execution_success',{prompt_id:'p'}]]}})).toBe(false);
    expect(historyWasInterrupted({prompt:['execution_interrupted'],status:{messages:[['execution_success',{}]]}})).toBe(false);
  });
});
describe('WanGP list-valued binding inference',()=>{
  it('binds image_refs as the whole list even when the default list is empty',()=>{const bindings=suggestWanGpBindings({prompt:'x',seed:1,image_refs:[]});expect(bindings.find(binding=>binding.key==='referenceImages')?.jsonPath).toBe('image_refs');});
});
describe('WanGP settings binding',()=>{it('infers current WanGP timing and reference-array keys without coupling to one nesting layout',()=>{const bindings=suggestWanGpBindings({prompt:'old',generation:{seed:1,width:832,height:480,num_frames:81,num_inference_steps:30},inputs:{start_image:'start.png',image_refs:null}});expect(bindings.find(b=>b.key==='prompt')?.jsonPath).toBe('prompt');expect(bindings.find(b=>b.key==='seed')?.jsonPath).toBe('generation.seed');expect(bindings.find(b=>b.key==='frames')?.jsonPath).toBe('generation.num_frames');expect(bindings.find(b=>b.key==='steps')?.jsonPath).toBe('generation.num_inference_steps');expect(bindings.find(b=>b.key==='startImage')?.jsonPath).toBe('inputs.start_image');expect(bindings.find(b=>b.key==='referenceImages')?.jsonPath).toBe('inputs.image_refs');});});
