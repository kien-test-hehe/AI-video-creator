import { describe, expect, it } from 'vitest';
import { parseScreenplay } from '../src/main/services/script-parser';
import { applyBindings, detectWorkflowFormat, suggestBindings, uiWorkflowToApi, validateComfyNodeAvailability, validateProfileBindings, type ApiWorkflow } from '../src/main/services/workflow-engine';
import { assertLocalUrl } from '../src/main/services/local-url';
import { assertPathInside, assertRelativeProjectPath } from '../src/main/services/path-safety';
import { chooseModelForShot } from '../src/shared/routing';
import { MODEL_DEFAULTS } from '../src/shared/defaults';
import { deriveHardwarePlan } from '../src/main/services/hardware-advisor';
import { routeWorkflow } from '../src/main/services/model-router';
import { directorText } from '../src/main/services/director-service';
import { parseVolumeDetectPeak, technicalQcStructuralIssues } from '../src/main/services/technical-qc';
import type { AppMachineSettings, Asset, FilmProject, RenderJobSpec, RenderOutput, Shot, WorkflowProfile } from '../src/shared/types';
import { autoAssignAssetToShot } from '../src/renderer/src/asset-assignment';
import { alternateShotTitle, appendProjectText, canonicalReadyOutputForShot, insertTimelineOutput, isStudioWorkflowReady, reorderTimeline, resolveStudioWorkflow, routeShotToWorkflow, studioNextStep, studioPreflightState, studioWorkflowIssue, timelineInsertIssue } from '../src/renderer/src/studio-logic';
import { compileWanGpProfile, suggestWanGpBindings } from '../src/main/services/wangp-engine';
import { planShotReferences } from '../src/main/services/reference-plan';
import { ComfyClient, cineforgePromptIdentities, cineforgePromptIdentitiesByMetadata, hasActiveComfyPrompts, historyWasInterrupted, promptQueueState, validateComfyFileRef } from '../src/main/services/comfy-client';
import { canRefreshProfileValidationFromRender, keyframeProjectInputKey, preserveTrustedProfileValidation, shotKeyframeInputKey, shotProjectRenderInputKey, shotRenderInputKey, workflowExecutionKey } from '../src/shared/shot-signature';
import { continuityPredecessorShots, continuityReviewInputKey, filterDirectorAssetIds, sceneDirectorInputKey, validatedVideoRouteForModel } from '../src/shared/director-signature';
import { latestCurrentPassingVideoTake, latestPassingVideoTake, takeNeedsConfirmation, takeUseConfirmationMessage } from '../src/shared/take-policy';
import { hasActiveRenderJobs, removedActiveRenderShotIds } from '../src/shared/project-guards';
import { selectRecoveryJob, shotStatusAfterJobSettlement } from '../src/shared/recovery-policy';
import { capcutHandoffInputKey, compareTimelineClips, duplicateTimelineOrderKey, timelineClipUseIssue, timelineExportInputKey, timelineOutputIssue, timelineTakeApprovalInputKey } from '../src/shared/timeline-policy';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { comfyNodeCatalogFingerprint, fingerprintWanGpSourceTree, sha256File } from '../src/main/services/runtime-fingerprint';
import { AppSettingsService } from '../src/main/services/app-settings-service';
import { ProjectService, serializeProjectForStorage } from '../src/main/services/project-service';
import { createHumanTask, promoteCanonicalTake, recordObservedFinalState, recordShotQc, resolveHumanTask } from '../src/main/services/production-state-service';
import { AdmissionGate } from '../src/main/services/admission-gate';
import { KeyframeLeaseStore, recoverOrphanedKeyframeLease } from '../src/main/services/keyframe-lease';
import { generateKeyframe, keyframePrompt } from '../src/main/services/keyframe-service';
import { upsertManagedProfile } from '../src/main/services/wangp-catalog-service';
import { RenderLeaseStore } from '../src/main/services/render-lease';
import { waitForComfyPromptRelease } from '../src/main/services/comfy-runner';
import { collectComfyHistoryOutputRefs } from '../src/main/services/comfy-output';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileBufferLimited, readJsonFileLimited, stringifyJsonLimited } from '../src/main/services/json-file';
import { ffmpegConcatFileLine } from '../src/main/services/ffmpeg-service';
import { buildRenderPrompt } from '../src/main/services/render-queue';
import { wangpEntrypoint } from '../src/main/services/wangp-runner';
import { mapJsonHostPathsForWanGp } from '../src/main/services/runtime-path-mapper';
import { loadPortableProject } from '../src/main/services/project-schema';
import { writeResponseBodyToFileLimited } from '../src/main/services/http-response';
import { buildWorkflowImportNotes, WORKFLOW_BINDING_INPUT_LIMIT, WORKFLOW_BINDING_LIMIT, WORKFLOW_BINDING_NODE_ID_LIMIT, WORKFLOW_PROFILE_NOTES_LIMIT } from '../src/shared/workflow-limits';
import { DEFAULT_CONTINUITY_FIELDS, OBSERVED_STATE_APPROVAL_PREFIX, canonicalTakeReadiness, continuityFrameForShot, currentActualStartFrameAssetId, currentProductionInputKeyForOutput, invalidateObservedFinalState, isApprovedObservedStateReview, latestShotQcResult, productionShotOrder, propagateObservedFinalState, rebuildDefaultSequentialDependencies, reconcileHumanQcTasks, requiresHumanContinuityMerge, shotProductionInputKey, shotQcInputKey } from '../src/shared/production-state';
import { useAppStore } from '../src/renderer/src/store';
import { advisePreviz } from '../src/main/services/previz-service';
import { evaluateContinuityQc, observedStateDraftFingerprint, observedStateDraftFromVisionResult, observedStateReviewTitle } from '../src/main/services/automatic-qc-service';
import { AutomationJournal } from '../src/main/services/automation-journal';
import { assertExternalDependenciesReady, automationTaskDisposition, buildAutomationTimelineIfEmpty } from '../src/main/services/production-runtime-service';
import { qcFailureAutoRetryDecision, renderFailureAutoRetryDecision } from '../src/shared/retry-policy';

const api: ApiWorkflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'old' }, _meta: { title: 'Positive Prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 1 } }
};

describe('Compact Studio source contract',()=>{
  it('uses the compact CapCut-style workspace by default while preserving Advanced Flow',async()=>{
    const studio=await readFile(join(process.cwd(),'src','renderer','src','views','Studio.tsx'),'utf8');
    const compact=await readFile(join(process.cwd(),'src','renderer','src','views','CompactStudio.tsx'),'utf8');
    const shell=await readFile(join(process.cwd(),'src','renderer','src','components','Shell.tsx'),'utf8');
    const styles=await readFile(join(process.cwd(),'src','renderer','src','styles.css'),'utf8');
    expect(studio).toMatch(/return <CompactStudio onOpenAdvanced=/);
    expect(studio).toMatch(/function StudioAdvanced\(\)/);
    expect(compact).toMatch(/Media.*Cast.*Places.*Shots.*AI.*Review.*Audio/s);
    expect(compact).toMatch(/Production timeline/);
    expect(compact).toMatch(/Generate shot/);
    expect(compact).toMatch(/Human Review/);
    expect(shell).toMatch(/studio-shell/);
    expect(styles).toMatch(/\.workspace\.studio-mode>\.topbar\{display:none\}/);
  });
});

describe('Studio guided next step',()=>{
  const base={sceneCount:1,shotCount:2,validVideoWorkflowCount:1,readinessKnown:true,readinessReady:true,preflightState:'ready' as const,openHumanTasks:0,automationRunning:false,canonicalCount:0,timelineCount:0};
  it('guides a fresh project through story, shots, workflows and machine readiness',()=>{
    expect(studioNextStep({...base,sceneCount:0}).action).toBe('story');
    expect(studioNextStep({...base,shotCount:0}).action).toBe('storyboard');
    expect(studioNextStep({...base,validVideoWorkflowCount:0}).action).toBe('settings');
    expect(studioNextStep({...base,readinessKnown:false}).action).toBe('system');
    expect(studioNextStep({...base,readinessReady:false}).tone).toBe('warn');
  });
  it('prioritizes preflight and human blockers before autonomous rendering',()=>{
    expect(studioNextStep({...base,preflightState:'unchecked'}).action).toBe('preflight');
    expect(studioNextStep({...base,preflightState:'blocked'}).action).toBe('system');
    expect(studioNextStep({...base,openHumanTasks:2}).action).toBe('human');
    expect(studioNextStep(base).action).toBe('auto');
  });
  it('moves from active production to timeline and finishing without hiding state',()=>{
    expect(studioNextStep({...base,automationRunning:true}).action).toBe('monitor');
    expect(studioNextStep({...base,canonicalCount:2}).action).toBe('timeline');
    expect(studioNextStep({...base,canonicalCount:2,timelineCount:2}).action).toBe('finishing');
  });
});

describe('WanGP recursive input safety',()=>{
  it('rejects pathological nesting before recursive traversal can exhaust the JS stack',()=>{
    let deep:any='/project/assets/input.png';for(let index=0;index<300;index++)deep={nested:deep};
    expect(()=>suggestWanGpBindings(deep)).toThrow(/nesting safety limit/i);
    const project={rootPath:'/project'} as any,machine={wangp:{executionMode:'docker',rootPath:'/wangp',docker:{projectMount:'/workspace/project',wangpMount:'/workspace/Wan2GP'}}} as any;
    expect(()=>mapJsonHostPathsForWanGp(project,machine,deep)).toThrow(/nesting safety limit/i);
  });
});
describe('WanGP entrypoint containment',()=>{
  it('rejects native/docker entrypoints that escape the configured WanGP root',()=>{
    const root=join(tmpdir(),'cineforge-wangp-root'),machine={wangp:{rootPath:root,entrypoint:'../outside.py'}} as any as AppMachineSettings;
    expect(()=>wangpEntrypoint(machine)).toThrow(/outside|entrypoint/i);
    machine.wangp.entrypoint='wgp.py';
    expect(wangpEntrypoint(machine)).toBe(join(root,'wgp.py'));
  });
});
describe('WanGP source-tree runtime fingerprint',()=>{
  it('changes for mounted source edits but ignores model-weight payloads',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-wangp-source-'));
    try{
      await mkdir(join(root,'pkg'),{recursive:true});await mkdir(join(root,'models'),{recursive:true});await mkdir(join(root,'env_venv','Lib','site-packages','dep'),{recursive:true});
      await writeFile(join(root,'wgp.py'),'from pkg.worker import run\n','utf8');
      await writeFile(join(root,'pkg','worker.py'),'def run(): return 1\n','utf8');
      await writeFile(join(root,'models','weights.safetensors'),Buffer.alloc(1024,1));
      await writeFile(join(root,'env_venv','Lib','site-packages','dep','module.py'),'VERSION=1\n','utf8');
      const first=await fingerprintWanGpSourceTree(root,'wgp.py');
      await writeFile(join(root,'models','weights.safetensors'),Buffer.alloc(2048,2));
      await writeFile(join(root,'env_venv','Lib','site-packages','dep','module.py'),'VERSION=2\n','utf8');
      expect(await fingerprintWanGpSourceTree(root,'wgp.py')).toBe(first);
      await writeFile(join(root,'pkg','worker.py'),'def run(): return 2\n','utf8');
      expect(await fingerprintWanGpSourceTree(root,'wgp.py')).not.toBe(first);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
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
describe('bounded streamed HTTP downloads',()=>{
  it('rejects oversized declarations and growth during streaming without leaving partial files',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-http-stream-limit-'));
    try{
      const declaredPath=join(root,'declared.bin');
      const declared=new Response(new Uint8Array([1]),{headers:{'content-length':'100'}});
      await expect(writeResponseBodyToFileLimited(declared,'test download',declaredPath,16)).rejects.toThrow(/too large|limit/i);
      await expect(readFile(declaredPath)).rejects.toMatchObject({code:'ENOENT'});

      const growingPath=join(root,'growing.bin');
      const growing=new Response(new Uint8Array(32),{headers:{'content-length':'8'}});
      await expect(writeResponseBodyToFileLimited(growing,'test download',growingPath,16)).rejects.toThrow(/streaming safety limit|exceeded/i);
      await expect(readFile(growingPath)).rejects.toMatchObject({code:'ENOENT'});
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
      expect(()=>stringifyJsonLimited({payload:'x'.repeat(256)},'Converted ComfyUI API workflow',64)).toThrow(/storage safety limit/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('FFmpeg concat path formatting',()=>{
  it('normalizes Windows separators before writing concat-demuxer file entries',()=>{
    expect(ffmpegConcatFileLine(String.raw`C:\Projects\My Film\clip.mp4`)).toBe("file 'C:/Projects/My Film/clip.mp4'");
  });
});
describe('renderer save runtime authority',()=>{
  it('invalidates a preferred take when renderer edits change render-relevant inputs',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-renderer-stale-take-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Film');
      const current=await service.mutate(project=>{
        project.scenes.push({id:'scene-1',index:1,heading:'INT. ROOM',body:'',shotIds:['shot-1']});
        project.shots.push({
          id:'shot-1',sceneId:'scene-1',index:1,title:'Shot',prompt:'old prompt',camera:'',action:'',dialogue:'',continuityNotes:'',
          characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',
          generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:20,cfg:1,seed:1,negativePrompt:'',includeAudio:false},
          latestRenderId:'old-output'
        });
        project.renderOutputs.push({id:'old-output',jobId:'old-job',shotId:'shot-1',path:join(root,'renders','old.mp4'),filename:'old.mp4',mediaType:'video',createdAt:new Date().toISOString()});
      });
      const rendererProject=structuredClone(current);
      rendererProject.shots[0].prompt='new prompt';
      rendererProject.shots[0].latestRenderId='old-output';
      rendererProject.shots[0].status='rendered';
      const saved=await service.saveFromRenderer(rendererProject);
      expect(saved.shots[0].latestRenderId).toBeUndefined();
      expect(saved.shots[0].status).toBe('ready');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('rejects oversized renderer edits without truncating or replacing the current project',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-renderer-oversize-'));
    try{
      const service=new ProjectService(),created=await service.createAt(root,'Film');
      const rendererProject=structuredClone(created);rendererProject.story.title='x'.repeat(501);
      await expect(service.saveFromRenderer(rendererProject)).rejects.toThrow(/500-character safety limit/i);
      expect(service.getCurrent()?.story.title).toBe('Film');
      const disk=JSON.parse(await readFile(join(root,'cineforge.project.json'),'utf8'));
      expect(disk.story.title).toBe('Film');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('does not let a newly renderer-created shot forge render runtime state',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-renderer-save-authority-'));
    try{
      const service=new ProjectService(),created=await service.createAt(root,'Film');
      const sceneId='scene-new',shotId='shot-new';
      const rendererProject=structuredClone(created);
      rendererProject.scenes.push({id:sceneId,index:1,heading:'INT. ROOM',body:'',shotIds:[shotId]});
      rendererProject.shots.push({
        id:shotId,sceneId,index:1,title:'New shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',
        characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendering',
        generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:20,cfg:1,seed:1,negativePrompt:'',includeAudio:false},
        latestRenderId:'forged-output'
      });
      const saved=await service.saveFromRenderer(rendererProject),shot=saved.shots.find(item=>item.id===shotId)!;
      expect(shot.status).toBe('draft');
      expect(shot.latestRenderId).toBeUndefined();
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('future project schema compatibility',()=>{
  it('refuses to replace a newer primary project with an older backup',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-future-project-'));
    try{
      const writer=new ProjectService(),created=await writer.createAt(root,'Film');
      await writeFile(join(root,'cineforge.project.json'),JSON.stringify({...created,schemaVersion:4,futureField:{keep:'me'}},null,2),'utf8');
      const reader=new ProjectService();
      await expect(reader.openAt(root)).rejects.toThrow(/unsupported project schema/i);
      const primary=JSON.parse(await readFile(join(root,'cineforge.project.json'),'utf8'));
      expect(primary.schemaVersion).toBe(4);expect(primary.futureField).toEqual({keep:'me'});
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('project backup recovery preservation',()=>{
  it('preserves a rejected primary project before restoring the backup',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-project-recovery-'));
    try{
      const writer=new ProjectService(),created=await writer.createAt(root,'Film');
      const rejected={...created,story:{...created.story,title:'x'.repeat(501)}};
      await writeFile(join(root,'cineforge.project.json'),JSON.stringify(rejected,null,2),'utf8');
      const reader=new ProjectService(),opened=await reader.openAt(root);
      expect(opened.story.title).toBe('Film');
      const recoveryNotice=reader.consumeOpenRecoveryNotice();
      expect(recoveryNotice).toMatch(/opened the trusted backup/i);
      expect(recoveryNotice).toMatch(/rejected primary preserved/i);
      expect(reader.consumeOpenRecoveryNotice()).toBeUndefined();
      const preserved=(await readdir(root)).find(name=>name.startsWith('cineforge.project.rejected-')&&name.endsWith('.json'));
      expect(preserved).toBeTruthy();
      const raw=JSON.parse(await readFile(join(root,preserved!),'utf8'));
      expect(raw.story.title).toHaveLength(501);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('project serialized-size round trip',()=>{
  it('rejects a project payload before write when it exceeds the loader byte limit',()=>{
    const project={schemaVersion:3,id:'p',name:'Film',rootPath:'/tmp/p',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',story:{title:'Film',logline:'',script:'',notes:'💥'.repeat(100)},scenes:[],assets:[],shots:[],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}} as FilmProject;
    expect(()=>serializeProjectForStorage(project,256)).toThrow(/storage safety limit/i);
    expect(serializeProjectForStorage(project,4096)).toContain('"Film"');
  });
});
describe('main-process asset kind validation',()=>{
  it('rejects runtime values outside AssetKind before opening a file dialog',async()=>{
    const service=new ProjectService();
    await expect(service.importAsset('../escape' as any)).rejects.toThrow(/invalid asset kind/i);
  });
});
describe('new project creation bounds',()=>{
  it('rejects an oversized project name before creating project files',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-project-name-bound-'));
    try{
      const service=new ProjectService();
      await expect(service.createAt(root,'x'.repeat(241))).rejects.toThrow(/240-character project safety limit/i);
      await expect(readFile(join(root,'cineforge.project.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('internal shot creation bounds',()=>{
  it('refuses a scene body that cannot fit the canonical shot prompt',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-shot-prompt-bound-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Film');
      await service.mutate(project=>{project.scenes.push({id:'scene-long',index:1,heading:'INT. LONG',body:'x'.repeat(200_001),shotIds:[]});});
      await expect(service.addShot('scene-long')).rejects.toThrow(/shot prompt safety limit/i);
      expect(service.getCurrent()?.shots).toHaveLength(0);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('internal project collection capacity',()=>{
  it('rejects asset import and manual shot creation at canonical capacity before mutating state',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-producer-capacity-'));
    try{
      const service=new ProjectService(),created=await service.createAt(root,'Film');
      const assets:any[]=[];assets.length=100_000;
      (service as any).current={...structuredClone(created),assets};
      await expect(service.importAsset('image')).rejects.toThrow(/100000-asset project safety limit/i);

      const shots:any[]=[];shots.length=100_000;
      (service as any).current={...structuredClone(created),scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:[]}],shots};
      await expect(service.addShot('scene')).rejects.toThrow(/100000-shot project safety limit/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('rejects keyframe generation at asset capacity before touching the GPU runtime',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-keyframe-capacity-'));
    try{
      const service=new ProjectService(),created=await service.createAt(root,'Film'),assets:any[]=[];assets.length=100_000;
      (service as any).current={...structuredClone(created),assets};
      await expect(generateKeyframe(service,{} as AppMachineSettings,{projectRoot:root,shotId:'missing',role:'start'} as any,{} as any)).rejects.toThrow(/100000-asset project safety limit/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('rejects a new managed workflow profile at capacity but still permits replacement by id',()=>{
    const profile={id:'new-profile',runtime:'wangp',purpose:'video',name:'Managed',modelFamily:'custom',mode:'i2v',workflowPath:'/tmp/w.json',workflowFormat:'wangp-settings',bindings:[],enabled:false} as WorkflowProfile;
    const profiles=Array.from({length:512},(_,index)=>({...profile,id:`profile-${index}`}));
    const project={settings:{workflowProfiles:profiles}} as unknown as FilmProject;
    expect(()=>upsertManagedProfile(project,profile)).toThrow(/512-profile project safety limit/i);
    expect(()=>upsertManagedProfile(project,{...profile,id:'profile-0'})).not.toThrow();
    expect(profiles[0].id).toBe('profile-0');
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
  it('rebuilds scene shot membership without resurrecting a stale preferred take from history',()=>{
    const loaded=loadPortableProject(baseProject(),'/project').project;
    expect(loaded.scenes[0].shotIds).toEqual(['shot-1']);
    expect(loaded.shots[0].latestRenderId).toBeUndefined();
    expect(loaded.shots[0].status).toBe('ready');
  });
  it('preserves an explicitly preferred take only when that exact output still exists for the shot',()=>{
    const raw=baseProject();raw.shots[0].latestRenderId='passing-output';
    const loaded=loadPortableProject(raw,'/project').project;
    expect(loaded.shots[0].latestRenderId).toBe('passing-output');
    expect(loaded.shots[0].status).toBe('rendered');
  });
  it('rejects canonical project data that exceeds safety limits instead of truncating it',()=>{
    const longText=baseProject();longText.story.title='x'.repeat(501);
    expect(()=>loadPortableProject(longText,'/project')).toThrow(/500-character safety limit/i);

    const tooManyScenes=baseProject();
    tooManyScenes.shots=[];tooManyScenes.renderOutputs=[];
    tooManyScenes.scenes=Array.from({length:10_001},(_,index)=>({id:`scene-${index}`,index:index+1,heading:'INT. ROOM',body:'',shotIds:[]}));
    expect(()=>loadPortableProject(tooManyScenes,'/project')).toThrow(/project scenes.*10,?000 items/i);
  });
  it('rejects malformed or missing canonical entity identifiers without breaking legacy top-level project id recovery',()=>{
    const raw=baseProject();raw.id='bad project id with spaces';
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/invalid project identifier/i);

    const missingProject=baseProject();delete (missingProject as any).id;
    expect(loadPortableProject(missingProject,'/project').project.id).toMatch(/^[a-f0-9-]{36}$/i);

    const missingShot:any=baseProject();delete missingShot.shots[0].id;
    expect(()=>loadPortableProject(missingShot,'/project')).toThrow(/missing canonical project entity identifier/i);

    const missingOutput:any=baseProject();delete missingOutput.renderOutputs[0].id;
    expect(()=>loadPortableProject(missingOutput,'/project')).toThrow(/missing canonical project entity identifier/i);
  });
  it('rejects missing IDs inside canonical reference arrays instead of generating replacements from map indices',()=>{
    const raw:any=baseProject();raw.scenes[0].shotIds=['shot-1',null];
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/missing canonical project entity identifier/i);

    const rawRefs:any=baseProject();rawRefs.assets=[{id:'ref',kind:'reference',name:'Ref',sourcePath:'ref.png',projectPath:'assets/reference/ref.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}];rawRefs.shots[0].referenceAssetIds=['ref',null];
    expect(()=>loadPortableProject(rawRefs,'/project')).toThrow(/missing canonical project entity identifier/i);
  });
  it('rejects explicit out-of-range project numerics instead of silently clamping them',()=>{
    const raw=baseProject();raw.shots[0].generation.width=9000;
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/allowed range 256\.\.8192/i);
    const timeline:any=baseProject();timeline.timeline=[{id:'clip',shotId:'shot-1',renderOutputId:'passing-output',track:0,order:0,trimInSec:0,volume:9}];
    expect(()=>loadPortableProject(timeline,'/project')).toThrow(/allowed range 0\.\.8/i);
  });
  it('rejects explicit invalid project enums instead of silently changing render semantics',()=>{
    const badMode:any=baseProject();badMode.shots[0].generation.mode='telepathy';
    expect(()=>loadPortableProject(badMode,'/project')).toThrow(/invalid shot generation mode/i);

    const badContainer:any=baseProject();badContainer.settings={outputContainer:'avi'};
    expect(()=>loadPortableProject(badContainer,'/project')).toThrow(/invalid project output container/i);

    const badJob:any=baseProject();badJob.renderJobs=[{id:'job',shotId:'shot-1',createdAt:'2026-01-03T00:00:00.000Z',updatedAt:'2026-01-03T00:00:00.000Z',status:'teleported',progress:0,message:'',modelFamily:'ltx-2.5-fast',outputs:[]}];
    expect(()=>loadPortableProject(badJob,'/project')).toThrow(/invalid render job status/i);

    const badProfile:any=baseProject();badProfile.settings={workflowProfiles:[{id:'wf',purpose:'video',name:'WF',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'/project/workflows/wf.json',workflowFormat:'mystery',bindings:[],enabled:false}]};
    expect(()=>loadPortableProject(badProfile,'/project')).toThrow(/invalid workflow format/i);
  });
  it('rejects explicit invalid project scalar types instead of silently defaulting them',()=>{
    const badNumber:any=baseProject();badNumber.shots[0].generation.fps='not-a-number';
    expect(()=>loadPortableProject(badNumber,'/project')).toThrow(/project integer is invalid/i);

    const badBoolean:any=baseProject();badBoolean.shots[0].generation.includeAudio='yes';
    expect(loadPortableProject(badBoolean,'/project').project.shots[0].generation.includeAudio).toBe(false);

    const badString:any=baseProject();badString.story.title=123;
    expect(()=>loadPortableProject(badString,'/project')).toThrow(/project string must be a string/i);

    const badQc:any=baseProject();badQc.renderOutputs[0].technicalQc={checkedAt:'2026-01-02T00:00:00.000Z',passed:'true',issues:[],warnings:[]};
    expect(loadPortableProject(badQc,'/project').project.renderOutputs[0].technicalQc?.passed).toBe(false);
  });
  it('canonicalizes parseable timestamps before lexical latest/recovery ordering',()=>{
    const raw=baseProject();raw.renderOutputs[0].createdAt='2026-01-01T09:00:00-05:00';
    const loaded=loadPortableProject(raw,'/project').project;
    expect(loaded.renderOutputs[0].createdAt).toBe('2026-01-01T14:00:00.000Z');
  });
  it('rejects out-of-range technical QC measurements instead of silently clamping them',()=>{
    const raw:any=baseProject();raw.renderOutputs[0].technicalQc={checkedAt:'2026-01-02T00:00:00.000Z',passed:false,issues:[],warnings:[],width:20_000};
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/optional integer.*1\.\.16384/i);
    raw.renderOutputs[0].technicalQc.width=1920;raw.renderOutputs[0].technicalQc.audioPeakDb=101;
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/optional number.*-300\.\.100/i);
  });
  it('rejects explicit invalid timestamps and oversized metadata instead of rewriting them',()=>{
    const badTime:any=baseProject();badTime.updatedAt='not-a-date';
    expect(()=>loadPortableProject(badTime,'/project')).toThrow(/invalid project timestamp/i);

    const badMeta:any=baseProject();badMeta.renderOutputs[0].comfyMeta={filename:'x'.repeat(4097)};
    expect(()=>loadPortableProject(badMeta,'/project')).toThrow(/comfy metadata filename.*4096-character/i);

    const badSource:any=baseProject();badSource.assets=[{id:'asset',kind:'reference',name:'A',sourcePath:'x'.repeat(2049),projectPath:'assets/reference/a.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}];
    expect(()=>loadPortableProject(badSource,'/project')).toThrow(/asset source label.*2048-character/i);
  });
  it('rejects malformed nested provenance instead of silently dropping it',()=>{
    const badQc:any=baseProject();badQc.renderOutputs[0].technicalQc='not-an-object';
    expect(()=>loadPortableProject(badQc,'/project')).toThrow(/invalid technical QC.*expected an object/i);

    const badMeta:any=baseProject();badMeta.renderOutputs[0].comfyMeta={filename:42};
    expect(()=>loadPortableProject(badMeta,'/project')).toThrow(/comfy metadata filename must be a string/i);

    const badSpec:any=baseProject();badSpec.renderJobs=[{id:'job',shotId:'shot-1',createdAt:'2026-01-03T00:00:00.000Z',updatedAt:'2026-01-03T00:00:00.000Z',status:'failed',progress:0,message:'',modelFamily:'ltx-2.5-fast',outputs:[],spec:'corrupt'}];
    expect(()=>loadPortableProject(badSpec,'/project')).toThrow(/invalid render job spec.*expected an object/i);

    const badHash:any=baseProject();badHash.settings={workflowProfiles:[{id:'wf',runtime:'wangp',purpose:'video',name:'WF',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'/project/workflows/wf.json',workflowFormat:'wangp-settings',bindings:[],enabled:false,validation:{structuralStatus:'valid',sourceSha256:'not-a-sha'}}]};
    expect(()=>loadPortableProject(badHash,'/project')).toThrow(/invalid SHA-256 project fingerprint/i);
  });
  it('rejects malformed nested story/settings objects instead of replacing them with defaults',()=>{
    const badStory:any=baseProject();badStory.story='lost story';
    expect(()=>loadPortableProject(badStory,'/project')).toThrow(/invalid story.*expected an object/i);

    const badPolicy:any=baseProject();badPolicy.settings={costPolicy:'free-for-all'};
    expect(()=>loadPortableProject(badPolicy,'/project')).toThrow(/invalid project cost policy.*expected an object/i);

    const badCapcut:any=baseProject();badCapcut.settings={capcut:'pro-ish'};
    expect(()=>loadPortableProject(badCapcut,'/project')).toThrow(/invalid CapCut project settings.*expected an object/i);
  });
  it('rejects render outputs that do not have a durable path',()=>{
    const raw=baseProject();raw.renderOutputs[0].path='';
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/render output path is required/i);
  });
  it('infers WanGP runtime for legacy profiles that only declare wangp-settings format',()=>{
    const raw:any=baseProject();
    raw.settings={workflowProfiles:[{id:'legacy-wangp',purpose:'video',name:'Legacy WanGP',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:'/project/workflows/legacy.json',workflowFormat:'wangp-settings',bindings:[],enabled:true}]};
    const loaded=loadPortableProject(raw,'/project').project;
    expect(loaded.settings.workflowProfiles.find(profile=>profile.id==='legacy-wangp')?.runtime).toBe('wangp');
  });
  it('orphans render-output provenance when an existing job belongs to another shot',()=>{
    const raw:any=baseProject();
    raw.scenes.push({id:'scene-2',index:2,heading:'INT. OTHER',body:'',shotIds:['shot-2']});
    raw.shots.push({...structuredClone(raw.shots[0]),id:'shot-2',sceneId:'scene-2',latestRenderId:undefined,status:'ready'});
    raw.renderJobs=[{id:'job-2',shotId:'shot-2',createdAt:'2026-01-03T00:00:00.000Z',updatedAt:'2026-01-03T00:00:00.000Z',status:'done',progress:1,message:'',modelFamily:'ltx-2.5-fast',outputs:[]}];
    raw.renderOutputs[0].jobId='job-2';
    const loaded=loadPortableProject(raw,'/project').project;
    expect(loaded.renderOutputs[0].jobId).toBe('orphaned');
    expect(loaded.renderJobs[0].outputs).toEqual([]);
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
describe('screenplay parsing',()=>{
  it('splits INT/EXT headings',()=>{const scenes=parseScreenplay('INT. GARAGE - NIGHT\nCar waits.\n\nEXT. ROAD - DAWN\nCar moves.');expect(scenes).toHaveLength(2);expect(scenes[0].location).toBe('GARAGE');expect(scenes[1].timeOfDay).toBe('DAWN');});
  it('rejects screenplay and scene sizes that cannot be persisted losslessly',()=>{
    expect(()=>parseScreenplay('x'.repeat(2_000_001))).toThrow(/screenplay exceeds/i);
    expect(()=>parseScreenplay(`INT. ROOM - DAY\n${'x'.repeat(500_001)}`)).toThrow(/scene body exceeds/i);
  });
});
describe('workflow binding object-key safety',()=>{
  it('rejects prototype-polluting Comfy binding inputs at runtime',()=>{
    const workflow:ApiWorkflow={'1':{class_type:'Node',inputs:{text:'old'}}};
    expect(()=>applyBindings(workflow,[{key:'prompt',selector:{nodeId:'1'},input:'__proto__',required:true}],{prompt:'pollute',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'})).toThrow(/forbidden object key/i);
    expect((Object.prototype as any).polluted).toBeUndefined();
  });
  it('rejects prototype-polluting WanGP JSON paths at runtime',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-wangp-safe-path-')),path=join(root,'settings.json');
    try{
      await writeFile(path,JSON.stringify({prompt:'old',seed:1}),'utf8');
      const profile={id:'p',runtime:'wangp' as const,purpose:'video' as const,name:'safe',modelFamily:'custom' as const,mode:'t2v' as const,workflowPath:path,workflowFormat:'wangp-settings' as const,enabled:true,bindings:[
        {key:'prompt' as const,jsonPath:'constructor.prototype.polluted',required:true}
      ]};
      await expect(compileWanGpProfile(profile,{prompt:'yes',negativePrompt:'',width:1,height:1,frames:1,fps:24,seed:1,filenamePrefix:'x'})).rejects.toThrow(/forbidden object key/i);
      expect((Object.prototype as any).polluted).toBeUndefined();
    }finally{await rm(root,{recursive:true,force:true});delete (Object.prototype as any).polluted;}
  });
  it('rejects dangerous workflow binding keys while loading a project',()=>{
    const raw:any={
      schemaVersion:2,id:'p',name:'P',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'P',logline:'',script:'',notes:''},scenes:[],assets:[],shots:[],renderJobs:[],renderOutputs:[],timeline:[],
      settings:{workflowProfiles:[{id:'wf',runtime:'comfyui',purpose:'video',name:'WF',modelFamily:'custom',mode:'t2v',workflowPath:'/project/workflows/wf.json',workflowFormat:'api',enabled:false,bindings:[{key:'prompt',selector:{nodeId:'1'},input:'__proto__'}]}]}
    };
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/forbidden object key/i);
    raw.settings.workflowProfiles[0].runtime='wangp';raw.settings.workflowProfiles[0].workflowFormat='wangp-settings';raw.settings.workflowProfiles[0].bindings=[{key:'prompt',jsonPath:'constructor.prototype.polluted'}];
    expect(()=>loadPortableProject(raw,'/project')).toThrow(/forbidden object key/i);
  });
});
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
 it('refuses partial UI conversion when dependency links are missing, malformed, duplicated, or point at the wrong target',()=>{
   const info={Source:{input:{required:{value:['INT',{}]}}},Consumer:{input:{required:{value:['INT',{forceInput:true}]}}}};
   const missing=uiWorkflowToApi({nodes:[{id:1,type:'Source',mode:0,inputs:[],widgets_values:[1]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:9}],widgets_values:[]}],links:[]},info);
   expect(missing.requiresApiExport).toBe(true);expect(missing.warnings.join(' ')).toMatch(/missing or malformed link/i);

   const malformed=uiWorkflowToApi({nodes:[{id:1,type:'Source',mode:0,inputs:[],widgets_values:[1]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:3}],widgets_values:[]}],links:[[3,1,'NaN',2,0,'INT']]},info);
   expect(malformed.requiresApiExport).toBe(true);expect(malformed.warnings.join(' ')).toMatch(/malformed link/i);

   const duplicate=uiWorkflowToApi({nodes:[{id:1,type:'Source',mode:0,inputs:[],widgets_values:[1]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:3}],widgets_values:[]}],links:[[3,1,0,2,0,'INT'],[3,1,0,2,0,'INT']]},info);
   expect(duplicate.requiresApiExport).toBe(true);expect(duplicate.warnings.join(' ')).toMatch(/duplicate link id/i);

   const wrongTarget=uiWorkflowToApi({nodes:[{id:1,type:'Source',mode:0,inputs:[],widgets_values:[1]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:3}],widgets_values:[]}],links:[[3,1,0,99,0,'INT']]},info);
   expect(wrongTarget.requiresApiExport).toBe(true);expect(wrongTarget.warnings.join(' ')).toMatch(/targets node 99/i);
 });
 it('refuses ambiguous or malformed UI node identity/input graphs',()=>{
   const info={Source:{input:{required:{value:['INT',{}]}}},Consumer:{input:{required:{a:['INT',{forceInput:true}],b:['INT',{forceInput:true}]}}}};
   const duplicateNode=uiWorkflowToApi({nodes:[{id:1,type:'Source',mode:0,inputs:[],widgets_values:[1]},{id:1,type:'Source',mode:0,inputs:[],widgets_values:[2]}],links:[]},info);
   expect(duplicateNode.requiresApiExport).toBe(true);expect(duplicateNode.warnings.join(' ')).toMatch(/duplicate node id 1/i);

   const duplicateInput=uiWorkflowToApi({nodes:[{id:1,type:'Consumer',mode:0,inputs:[{name:'a'},{name:'a'}],widgets_values:[]}],links:[]},info);
   expect(duplicateInput.requiresApiExport).toBe(true);expect(duplicateInput.warnings.join(' ')).toMatch(/duplicate input name a/i);

   const reusedLink=uiWorkflowToApi({nodes:[{id:1,type:'Source',mode:0,inputs:[],widgets_values:[1]},{id:2,type:'Consumer',mode:0,inputs:[{name:'a',link:3},{name:'b',link:3}],widgets_values:[]}],links:[[3,1,0,2,0,'INT']]},info);
   expect(reusedLink.requiresApiExport).toBe(true);expect(reusedLink.warnings.join(' ')).toMatch(/more than one target input/i);

   const malformedNode=uiWorkflowToApi({nodes:[{id:'',type:'Source',mode:0,inputs:[],widgets_values:[]}],links:[]},info);
   expect(malformedNode.requiresApiExport).toBe(true);expect(malformedNode.warnings.join(' ')).toMatch(/invalid id/i);
 });
 it('refuses UI conversion when a required dependency originates from a disabled node',()=>{
   const ui={nodes:[{id:1,type:'Source',mode:2,inputs:[],widgets_values:[1]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:3}],widgets_values:[]}],links:[[3,1,0,2,0,'INT']]};
   const converted=uiWorkflowToApi(ui,{Source:{input:{required:{value:['INT',{}]}}},Consumer:{input:{required:{value:['INT',{forceInput:true}]}}}});
   expect(converted.requiresApiExport).toBe(true);expect(converted.warnings.join(' ')).toMatch(/disabled\/bypassed/i);
 });
 it('rejects auto-suggested bindings beyond the canonical workflow binding limit',()=>{
   const workflow:ApiWorkflow={};
   for(let i=0;i<=WORKFLOW_BINDING_LIMIT;i++)workflow[String(i)]={class_type:'CLIPTextEncode',inputs:{text:'prompt'},_meta:{title:`Positive ${i}`}};
   expect(()=>suggestBindings(workflow)).toThrow(/binding project safety limit/i);
 });
 it('rejects auto-suggested bindings whose node id cannot round-trip through the project schema',()=>{
   const nodeId='n'.repeat(WORKFLOW_BINDING_NODE_ID_LIMIT+1);
   const workflow:ApiWorkflow={[nodeId]:{class_type:'CLIPTextEncode',inputs:{text:'prompt'},_meta:{title:'Positive'}}};
   expect(()=>suggestBindings(workflow)).toThrow(/node id.*project safety limit/i);
 });
 it('rejects auto-suggested bindings whose input name cannot round-trip through the project schema',()=>{
   const input='prompt_'+('x'.repeat(WORKFLOW_BINDING_INPUT_LIMIT));
   const workflow:ApiWorkflow={'1':{class_type:'CLIPTextEncode',inputs:{[input]:'prompt'},_meta:{title:'Positive'}}};
   expect(()=>suggestBindings(workflow)).toThrow(/input name.*project safety limit/i);
 });
 it('keeps generated Comfy selectors minimal and schema-safe',()=>{
   const workflow:ApiWorkflow={'17':{class_type:'CLIPTextEncode',inputs:{text:'prompt'},_meta:{title:'Positive Prompt'}}};
   const binding=suggestBindings(workflow).find(item=>item.key==='prompt');
   expect(binding?.selector).toEqual({nodeId:'17'});
   expect(binding?.input).toBe('text');
 });
 it('caps generated workflow import notes while preserving an explicit truncation marker',()=>{
   const notes=buildWorkflowImportNotes('Imported workflow.',Array.from({length:400},(_,i)=>`warning-${i}-${'x'.repeat(100)}`));
   expect(notes.length).toBeLessThanOrEqual(WORKFLOW_PROFILE_NOTES_LIMIT);
   expect(notes).toMatch(/Additional import warnings truncated/i);
 });
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
 it('does not treat inherited Object prototype fields as real Comfy node inputs',async()=>{
   const root=await mkdtemp(join(tmpdir(),'cineforge-comfy-own-input-')),path=join(root,'workflow.json');
   await writeFile(path,JSON.stringify({'1':{class_type:'Dummy',inputs:{seed:1}}}),'utf8');
   try{
     const issues=await validateProfileBindings({id:'p',runtime:'comfyui',purpose:'video',name:'own input',modelFamily:'custom',mode:'t2v',workflowPath:path,workflowFormat:'api',bindings:[
       {key:'prompt',selector:{nodeId:'1'},input:'toString',required:true},
       {key:'seed',selector:{nodeId:'1'},input:'seed',required:true}
     ],enabled:false});
     expect(issues.join(' ')).toMatch(/toString.*not present|input .* not present/i);
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
 it('does not treat inherited Object prototype names as installed Comfy node schemas',()=>{
   const ui={nodes:[{id:1,type:'toString',mode:0,inputs:[],outputs:[{name:'out',links:[1]}],widgets_values:[]},{id:2,type:'Consumer',mode:0,inputs:[{name:'value',link:1}],widgets_values:[]}],links:[[1,1,0,2,0,'INT']]};
   const converted=uiWorkflowToApi(ui,{Consumer:{input:{required:{value:['INT',{forceInput:true}]}}}});
   expect(converted.requiresApiExport).toBe(true);
   expect(converted.workflow['1']).toBeUndefined();
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
   expect(insertTimelineOutput(project,'o2','a','test override')).toBe(true);const canonical=[...project.timeline].sort(compareTimelineClips);expect(canonical.map(clip=>clip.renderOutputId)).toEqual(['o2','o1']);expect(canonical.map(clip=>clip.order)).toEqual([0,1]);
 });
 it('refuses timeline insertion once the canonical 100000-clip limit is reached',()=>{
   const timeline:any[]=[];timeline.length=100_000;
   const project={shots:[{id:'s1'}],renderOutputs:[{id:'o1',shotId:'s1',mediaType:'video'}],timeline} as unknown as FilmProject;
   expect(timelineInsertIssue(project)).toMatch(/100000 clips/i);
   expect(insertTimelineOutput(project,'o1')).toBe(false);
   expect(project.timeline).toHaveLength(100_000);
 });
 it('keeps duplicate-shot labels and Director append operations within schema limits',()=>{
   const title=alternateShotTitle('x'.repeat(2000));
   expect(title).toHaveLength(2000);expect(title.endsWith(' · alt')).toBe(true);
   expect(appendProjectText('abc','def',7,'Shot prompt')).toBe('abc\ndef');
   expect(()=>appendProjectText('abc','def',6,'Shot prompt')).toThrow(/6-character project safety limit/i);
 });
 it('reorders canonical timeline clips by drag target',()=>{
   const project={timeline:[{id:'a',shotId:'s1',renderOutputId:'o1',track:0,order:0,trimInSec:0,volume:1},{id:'b',shotId:'s2',renderOutputId:'o2',track:0,order:1,trimInSec:0,volume:1},{id:'c',shotId:'s3',renderOutputId:'o3',track:0,order:2,trimInSec:0,volume:1}]} as unknown as FilmProject;
   expect(reorderTimeline(project,'c','a')).toBe(true);const canonical=[...project.timeline].sort(compareTimelineClips);expect(canonical.map(clip=>clip.id)).toEqual(['c','a','b']);expect(canonical.map(clip=>clip.order)).toEqual([0,1,2]);
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
describe('immutable render prompt bounds',()=>{
  it('rejects a valid shot whose combined effective prompt would exceed the job schema limit',()=>{
    const shot:Shot={id:'s',sceneId:'scene',index:1,title:'Huge prompt',prompt:'p'.repeat(200_000),camera:'',action:'a'.repeat(100_000),dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}};
    const project={assets:[]} as unknown as FilmProject;
    expect(()=>buildRenderPrompt(project,shot)).toThrow(/300000-character immutable job safety limit/i);
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
describe('stale render job shot settlement',()=>{
  it('preserves changed creative state while only clearing stale runtime states',()=>{
    expect(shotStatusAfterJobSettlement('draft',false,false,'ready','failed')).toBe('draft');
    expect(shotStatusAfterJobSettlement('failed',false,false,'ready','cancelled')).toBe('failed');
    expect(shotStatusAfterJobSettlement('rendering',false,false,'ready','orphaned')).toBe('ready');
    expect(shotStatusAfterJobSettlement('queued',false,false,'draft','failed')).toBe('ready');
  });
  it('applies the current job outcome only when the queued spec is still current',()=>{
    expect(shotStatusAfterJobSettlement('rendering',false,true,'draft','cancelled')).toBe('draft');
    expect(shotStatusAfterJobSettlement('rendering',false,true,'ready','orphaned')).toBe('ready');
    expect(shotStatusAfterJobSettlement('rendering',false,true,'ready','failed')).toBe('failed');
    expect(shotStatusAfterJobSettlement('draft',true,false,'draft','cancelled')).toBe('rendered');
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
describe('foreground artifact input signatures',()=>{
  const project=():FilmProject=>({
    schemaVersion:3,id:'p',name:'Film',rootPath:'/project',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
    story:{title:'Film',logline:'',script:'',notes:''},
    scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['shot']}],
    assets:[{id:'asset',kind:'reference',name:'Ref',sourcePath:'ref.png',projectPath:'assets/ref.png',tags:['a'],notes:'note',createdAt:'2026-01-01T00:00:00.000Z'}],
    shots:[{id:'shot',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'hello',continuityNotes:'cont',characterAssetIds:[],propAssetIds:[],referenceAssetIds:['asset'],status:'rendered',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:20,cfg:1,seed:1,negativePrompt:'',includeAudio:false},latestRenderId:'out'}],
    renderJobs:[],
    renderOutputs:[{id:'out',jobId:'orphaned',shotId:'shot',path:'/project/renders/out.mp4',filename:'out.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z',technicalQc:{checkedAt:'2026-01-01T00:00:00.000Z',passed:true,issues:[],warnings:[]}}],
    timeline:[{id:'clip',shotId:'shot',renderOutputId:'out',track:0,order:0,trimInSec:0,volume:1}],
    shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
    settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
  });
  it('changes export signature only when export-relevant canonical inputs change',()=>{
    const base=project(),before=timelineExportInputKey(base);
    const storageReorder=structuredClone(base);storageReorder.timeline.reverse();expect(timelineExportInputKey(storageReorder)).toBe(before);
    const storyEdit=structuredClone(base);storyEdit.story.notes='metadata only';expect(timelineExportInputKey(storyEdit)).toBe(before);
    const trimEdit=structuredClone(base);trimEdit.timeline[0].trimInSec=.25;expect(timelineExportInputKey(trimEdit)).not.toBe(before);
    const fpsEdit=structuredClone(base);fpsEdit.settings.defaultFps=30;expect(timelineExportInputKey(fpsEdit)).not.toBe(before);
  });
  it('changes CapCut signature when manifest-relevant story, assets, shot metadata or QC changes',()=>{
    const base=project(),before=capcutHandoffInputKey(base);
    const storageReorder=structuredClone(base);storageReorder.timeline.reverse();expect(capcutHandoffInputKey(storageReorder)).toBe(before);
    const story=structuredClone(base);story.story.notes='changed';expect(capcutHandoffInputKey(story)).not.toBe(before);
    const asset=structuredClone(base);asset.assets[0].notes='changed';expect(capcutHandoffInputKey(asset)).not.toBe(before);
    const shot=structuredClone(base);shot.shots[0].dialogue='changed';expect(capcutHandoffInputKey(shot)).not.toBe(before);
    const qc=structuredClone(base);qc.renderOutputs[0].technicalQc!.warnings=['warn'];expect(capcutHandoffInputKey(qc)).not.toBe(before);
  });
});
describe('multi-track timeline editing',()=>{
  const project=()=>({
    shots:[{id:'s1'},{id:'s2'},{id:'s3'}],
    renderOutputs:[{id:'o1',shotId:'s1',mediaType:'video'},{id:'o2',shotId:'s2',mediaType:'video'},{id:'o3',shotId:'s3',mediaType:'video'}],
    timeline:[
      {id:'a',shotId:'s1',renderOutputId:'o1',track:0,order:0,trimInSec:0,volume:1},
      {id:'b',shotId:'s2',renderOutputId:'o2',track:0,order:1,trimInSec:0,volume:1},
      {id:'c',shotId:'s3',renderOutputId:'o3',track:1,order:0,trimInSec:0,volume:1}
    ]
  }) as any as FilmProject;
  it('reorders only within one track and refuses cross-track drag reorder',()=>{
    const p=project();expect(reorderTimeline(p,'b','a')).toBe(true);
    expect(p.timeline.find(c=>c.id==='b')?.order).toBe(0);expect(p.timeline.find(c=>c.id==='a')?.order).toBe(1);expect(p.timeline.find(c=>c.id==='c')?.order).toBe(0);
    expect(reorderTimeline(p,'a','c')).toBe(false);expect(p.timeline.find(c=>c.id==='c')?.order).toBe(0);
  });
  it('inserts a take into the target clip track without renumbering other tracks',()=>{
    const p=project();expect(insertTimelineOutput(p,'o1','c','test override')).toBe(true);
    const inserted=p.timeline.find(c=>c.id!=='a'&&c.id!=='b'&&c.id!=='c')!;
    expect(inserted.track).toBe(1);expect(inserted.order).toBe(0);expect(p.timeline.find(c=>c.id==='c')?.order).toBe(1);
    expect(p.timeline.find(c=>c.id==='a')?.order).toBe(0);expect(p.timeline.find(c=>c.id==='b')?.order).toBe(1);
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
  it('requires canonical provenance or an explicit human override before timeline media is exportable',()=>{
    const shot:Shot={id:'s1',sceneId:'scene',index:1,title:'Shot',prompt:'p',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false},canonicalRenderId:'o1'};
    const project={shots:[shot],scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['s1']}],assets:[],renderJobs:[],renderOutputs:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],timeline:[],settings:{workflowProfiles:[],costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4'}} as unknown as FilmProject;
    const video={...output('o1','s1'),technicalQc:{checkedAt:'2026-01-01T00:00:00.000Z',passed:true,issues:[],warnings:[]}};project.renderOutputs.push(video);
    video.productionInputKey=shotProductionInputKey(project,shot);
    project.qcResults.push(
      {id:'qv',shotId:'s1',renderOutputId:'o1',layer:'visual',status:'pass',issues:[],inputKey:shotQcInputKey(project,'s1','o1','visual'),createdAt:'2026-01-01T00:00:01.000Z'},
      {id:'qs',shotId:'s1',renderOutputId:'o1',layer:'semantic',status:'pass',issues:[],inputKey:shotQcInputKey(project,'s1','o1','semantic'),createdAt:'2026-01-01T00:00:01.000Z'}
    );
    const canonical={id:'c',shotId:'s1',renderOutputId:'o1',track:0,order:0,trimInSec:0,volume:1,approval:'canonical'} as const;
    expect(timelineClipUseIssue(project,canonical)).toBeUndefined();
    expect(timelineClipUseIssue(project,{...canonical,approval:'legacy'})).toMatch(/legacy take approval/i);
    expect(timelineClipUseIssue(project,{...canonical,approval:'human-override',approvalReason:undefined})).toMatch(/without a recorded reason/i);
    expect(timelineClipUseIssue(project,{...canonical,approval:'human-override',approvalReason:'Human accepted continuity mismatch.'})).toBeUndefined();
    project.qcResults.push({id:'qs2',shotId:'s1',renderOutputId:'o1',layer:'semantic',status:'fail',issues:[],inputKey:shotQcInputKey(project,'s1','o1','semantic'),createdAt:'2026-01-01T00:00:02.000Z'} as any);
    expect(timelineClipUseIssue(project,canonical)).toMatch(/no longer canonical-ready.*semantic QC is fail/i);
  });
});
describe('technical QC structural invariants',()=>{
  const shot:Shot={id:'qc-shot',sceneId:'scene',index:1,title:'QC',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:120,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}};
  it('fails structural QC when duration is unmeasurable or requested audio is absent',()=>{
    const missing=technicalQcStructuralIssues(shot,{video:{width:1280,height:704,fps:24},hasAudio:false});
    expect(missing).toContain('Video duration could not be measured.');
    expect(missing).toContain('Shot requested audio but output has no audio stream.');
  });
  it('detects a volumedetect -inf stream as silent',()=>{
    expect(parseVolumeDetectPeak('max_volume: -inf dB')).toEqual({silent:true});
    expect(parseVolumeDetectPeak('max_volume: -3.5 dB')).toEqual({peakDb:-3.5,silent:false});
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
describe('Windows bootstrap source integrity guards',()=>{
  it('refuses dirty pinned WanGP source without mistaking the managed venv for source',async()=>{
    const setup=await readFile(join(process.cwd(),'scripts','setup-windows.ps1'),'utf8');
    expect(setup).toMatch(/fetch origin --tags --prune/i);
    expect(setup).toMatch(/diff --quiet HEAD --/i);
    expect(setup).toMatch(/ls-files --others --exclude-standard -- '\*\.py' '\*\.pyi'/i);
    expect(setup).toMatch(/env_venv/);
    expect(setup).toMatch(/envs\.json maps env_venv outside its managed runtime directory/i);
    expect(setup).toMatch(/IsPathRooted\(\$registeredText\)/);
  });
  it('rebuilds CineForge when tracked or untracked working-tree source differs from the stamped build',async()=>{
    const run=await readFile(join(process.cwd(),'scripts','run-windows.ps1'),'utf8');
    expect(run).toMatch(/status --porcelain --untracked-files=normal/i);
    expect(run).toMatch(/\$workingTreeDirty/);
  });
  it('pins the portable npm version and preserves bootstrap launcher failures',async()=>{
    const setup=await readFile(join(process.cwd(),'scripts','setup-windows.ps1'),'utf8');
    const setupCmd=await readFile(join(process.cwd(),'setup.cmd'),'utf8');
    const startCmd=await readFile(join(process.cwd(),'start.cmd'),'utf8');
    const verifyCmd=await readFile(join(process.cwd(),'verify.cmd'),'utf8');
    expect(setup).toContain("$NpmVersion = '10.9.9'");
    expect(setup).toMatch(/npm@\$NpmVersion/i);
    expect(setupCmd).toMatch(/set "CINEFORGE_EXIT=%ERRORLEVEL%"/i);
    expect(setupCmd).toMatch(/exit \/b %CINEFORGE_EXIT%/i);
    expect(startCmd).toMatch(/exit \/b %ERRORLEVEL%/i);
    expect(verifyCmd).toMatch(/exit \/b %ERRORLEVEL%/i);
  });
  it('ships a workstation verifier for GPU, pinned WanGP, CUDA, dependencies and deep validation',async()=>{
    const verify=await readFile(join(process.cwd(),'scripts','verify-windows.ps1'),'utf8');
    expect(verify).toMatch(/nvidia-smi\.exe/i);
    expect(verify).toMatch(/WanGP source matches pinned commit/i);
    expect(verify).toMatch(/torch\.cuda\.is_available/i);
    expect(verify).toMatch(/CineForge npm dependencies are installed/i);
    expect(verify).toMatch(/Running deep source validation/i);
    expect(verify).toMatch(/Verification PASSED/i);
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
describe('machine settings structural validation',()=>{
  it('treats non-object primary settings as corruption instead of silently loading defaults',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-settings-shape-')),userdata=join(root,'userdata');
    try{
      const service=new AppSettingsService(userdata);await service.load();
      const trusted=service.get();trusted.director.model='trusted';await service.save(trusted);
      const newer=service.get();newer.director.temperature=0.4;await service.save(newer);
      await writeFile(join(userdata,'machine-settings.v1.json'),'[]','utf8');
      const recovered=new AppSettingsService(userdata);await recovered.load();
      expect(recovered.get().director.model).toBe('trusted');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('machine settings recovery preservation and versioning',()=>{
  it('preserves a rejected primary before restoring a trusted backup',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-settings-recovery-')),userdata=join(root,'userdata');
    try{
      const service=new AppSettingsService(userdata);await service.load();
      const trusted=service.get();trusted.director.model='trusted';await service.save(trusted);
      const newer=service.get();newer.director.temperature=0.4;await service.save(newer);
      await writeFile(join(userdata,'machine-settings.v1.json'),JSON.stringify({schemaVersion:1,comfy:{url:'https://not-loopback.invalid'}}),'utf8');
      const recovered=new AppSettingsService(userdata);await recovered.load();
      expect(recovered.get().director.model).toBe('trusted');
      const preserved=(await readdir(userdata)).find(name=>name.startsWith('machine-settings.v1.rejected-')&&name.endsWith('.json'));
      expect(preserved).toBeTruthy();
      const rejected=JSON.parse(await readFile(join(userdata,preserved!),'utf8'));
      expect(rejected.comfy.url).toBe('https://not-loopback.invalid');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('future machine settings compatibility',()=>{
  it('refuses to replace newer settings with a v1 backup',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-future-settings-')),userdata=join(root,'userdata');
    try{
      const service=new AppSettingsService(userdata);await service.load();
      const current=service.get();current.director.model='v1';await service.save(current);
      await writeFile(join(userdata,'machine-settings.v1.json'),JSON.stringify({schemaVersion:2,futureField:'keep-me'}),'utf8');
      await expect(new AppSettingsService(userdata).load()).rejects.toThrow(/unsupported machine settings schema/i);
      const primary=JSON.parse(await readFile(join(userdata,'machine-settings.v1.json'),'utf8'));
      expect(primary.schemaVersion).toBe(2);expect(primary.futureField).toBe('keep-me');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('WanGP Docker image argument safety',()=>{
  it('rejects option-like Docker image values before docker run can parse them as flags',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-docker-image-')),bootstrap=join(root,'bootstrap.json'),prior=process.env.CINEFORGE_BOOTSTRAP_SETTINGS;
    try{
      await writeFile(bootstrap,JSON.stringify({schemaVersion:1,wangp:{executionMode:'docker',docker:{image:'--privileged'}}}),'utf8');
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS=bootstrap;
      await expect(new AppSettingsService(join(root,'userdata')).load()).rejects.toThrow(/docker image.*not a docker cli option/i);
    }finally{
      if(prior==null)delete process.env.CINEFORGE_BOOTSTRAP_SETTINGS;else process.env.CINEFORGE_BOOTSTRAP_SETTINGS=prior;
      await rm(root,{recursive:true,force:true});
    }
  });
});
describe('WanGP Docker mount argument safety',()=>{
  it('rejects container mount paths that can inject docker volume options',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-docker-mount-')),bootstrap=join(root,'bootstrap.json'),prior=process.env.CINEFORGE_BOOTSTRAP_SETTINGS;
    try{
      await writeFile(bootstrap,JSON.stringify({schemaVersion:1,wangp:{executionMode:'docker',docker:{image:'wan2gp:test',projectMount:'/workspace/project:ro'}}}),'utf8');
      process.env.CINEFORGE_BOOTSTRAP_SETTINGS=bootstrap;
      await expect(new AppSettingsService(join(root,'userdata')).load()).rejects.toThrow(/volume-option delimiters/i);
    }finally{
      if(prior==null)delete process.env.CINEFORGE_BOOTSTRAP_SETTINGS;else process.env.CINEFORGE_BOOTSTRAP_SETTINGS=prior;
      await rm(root,{recursive:true,force:true});
    }
  });
});
describe('machine execution-mode integrity',()=>{
  it('rejects an explicit invalid WanGP execution mode instead of falling back to native',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-machine-mode-'));
    try{
      const service=new AppSettingsService(root),before=await service.load(),next:any=structuredClone(before);
      next.wangp.executionMode='container-ish';
      await expect(service.save(next)).rejects.toThrow(/invalid wangp execution mode/i);
      expect(service.get().wangp.executionMode).toBe(before.wangp.executionMode);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
describe('machine settings string bounds',()=>{
  it('rejects oversized values before save so persisted settings remain reloadable',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-machine-string-bound-'));
    try{
      const service=new AppSettingsService(root),before=await service.load(),next=structuredClone(before);
      next.director.model='x'.repeat(4097);
      await expect(service.save(next)).rejects.toThrow(/machine setting string.*4096-character safety limit/i);
      expect(service.get().director.model).toBe(before.director.model);
      const disk=JSON.parse(await readFile(join(root,'machine-settings.v1.json'),'utf8'));
      expect(disk.director.model).toBe(before.director.model);
    }finally{await rm(root,{recursive:true,force:true});}
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
describe('Local Director output bounds',()=>{
  it('clips model-generated text before it enters renderer/project state',()=>{
    expect(directorText('abcdef','',4)).toBe('abcd');
    expect(directorText(undefined,'fallback',4)).toBe('fall');
  });
});
describe('render admission serialization',()=>{
  it('is busy immediately and serializes overlapping admissions',async()=>{
    const gate=new AdmissionGate(),events:string[]=[];
    let releaseFirst!:()=>void;const firstBlock=new Promise<void>(resolve=>{releaseFirst=resolve;});
    const first=gate.run(async()=>{events.push('first:start');await firstBlock;events.push('first:end');});
    expect(gate.busy).toBe(true);
    const second=gate.run(async()=>{events.push('second:start');events.push('second:end');});
    await new Promise(resolve=>setTimeout(resolve,5));
    expect(events).toEqual(['first:start']);expect(gate.busy).toBe(true);
    releaseFirst();await Promise.all([first,second]);
    expect(events).toEqual(['first:start','first:end','second:start','second:end']);
    expect(gate.busy).toBe(false);
  });
});
describe('main-process workflow routing authority',()=>{
  const shot:Shot={id:'route-shot',sceneId:'scene',index:1,title:'Route',prompt:'p',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false}};
  const profile=(id:string,status:'valid'|'invalid'|'unvalidated'):WorkflowProfile=>({id,runtime:'wangp',purpose:'video',name:id,modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:`/tmp/${id}.json`,workflowFormat:'wangp-settings',bindings:[],enabled:true,validation:{structuralStatus:status}});
  it('refuses explicit and automatic production routes unless validation is valid',()=>{
    const invalid=profile('invalid','invalid'),unvalidated=profile('unvalidated','unvalidated'),valid=profile('valid','valid');
    const explicit=structuredClone(shot);explicit.generation.workflowProfileId='unvalidated';
    expect(()=>routeWorkflow({settings:{workflowProfiles:[unvalidated,valid]}} as unknown as FilmProject,explicit)).toThrow(/Validate it before production use/i);
    expect(routeWorkflow({settings:{workflowProfiles:[invalid,valid]}} as unknown as FilmProject,shot).id).toBe('valid');
    expect(()=>routeWorkflow({settings:{workflowProfiles:[invalid]}} as unknown as FilmProject,shot)).toThrow(/No validated/i);
  });
});
describe('model routing',()=>{
 it('keeps dialogue/audio on LTX 2.5 Fast',()=>{expect(chooseModelForShot(routedShot({dialogue:'Hello.'}))).toBe('ltx-2.5-fast');expect(chooseModelForShot(routedShot({generation:{...routedShot().generation,includeAudio:true}}))).toBe('ltx-2.5-fast');});
 it('routes hero shots to Hunyuan and action shots to Wan',()=>{expect(chooseModelForShot(routedShot({generation:{...routedShot().generation,quality:'hero'}}))).toBe('hunyuan-video-1.5');expect(chooseModelForShot(routedShot({camera:'fast tracking orbit',action:'car chase'}))).toBe('wan-2.2-5b');});
 it('limits auto-routing to models that have validated local production routes',()=>{
   const action=routedShot({camera:'fast tracking orbit',action:'car chase'});
   expect(chooseModelForShot(action,{validatedModels:['ltx-2.5-fast']})).toBe('ltx-2.5-fast');
   expect(chooseModelForShot(action,{validatedModels:['ltx-2.5-fast','wan-2.2-5b']})).toBe('wan-2.2-5b');
   const hero=routedShot({generation:{...routedShot().generation,quality:'hero'}});
   expect(chooseModelForShot(hero,{validatedModels:['ltx-2.5-fast']})).toBe('ltx-2.5-fast');
 });
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
describe('Director continuity dependency context',()=>{
  it('uses explicit incoming continuity dependencies instead of accidental index adjacency',()=>{
    const base=(id:string,index:number):Shot=>({id,sceneId:'scene',index,title:id,prompt:id,camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:index,negativePrompt:'',includeAudio:false}});
    const a=base('a',1),b=base('b',2),c=base('c',3);
    const project={id:'p',story:{title:'',logline:'',script:'',notes:''},scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b','c']}],shots:[a,b,c],assets:[],shotDependencies:[{id:'custom',fromShotId:'a',toShotId:'c',relation:'continuity',strength:'hard',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}],settings:{workflowProfiles:[]}} as unknown as FilmProject;
    expect(continuityPredecessorShots(project,c).map(item=>item.id)).toEqual(['a']);
    const first=continuityReviewInputKey(project,c);
    project.shotDependencies[0].propagate=['character','camera'];
    expect(continuityReviewInputKey(project,c)).not.toBe(first);
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
describe('Comfy history output bounds',()=>{
  it('rejects overlong history file metadata before download or project persistence',()=>{
    expect(()=>collectComfyHistoryOutputRefs({outputs:{node:{images:[{filename:'x'.repeat(2049),subfolder:'',type:'output'}]}}})).toThrow(/2048-character project safety limit/i);
  });
});
describe('Comfy output identity',()=>{
  it('collects filenames only from history.outputs and never from prompt/input metadata',()=>{
    const completedWithoutOutputs={status:{completed:true},prompt:{inputs:{filename:'uploaded-input.png',type:'input'}}};
    expect(collectComfyHistoryOutputRefs(completedWithoutOutputs)).toEqual([]);
    const withOutput={outputs:{'7':{images:[{filename:'result.png',subfolder:'cineforge',type:'output'}],metadata:{filename:'uploaded-input.png',type:'input'}}},prompt:{filename:'uploaded-input.png'}};
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
describe('Comfy file record validation',()=>{
  it('rejects malformed upload records and accepts a concrete filename',()=>{
    expect(()=>validateComfyFileRef({subfolder:'x'},'upload')).toThrow(/filename/i);
    expect(()=>validateComfyFileRef({filename:'x.png',subfolder:4},'upload')).toThrow(/subfolder/i);
    expect(validateComfyFileRef({filename:'x.png',subfolder:'cineforge',type:'input'},'upload')).toEqual({filename:'x.png',subfolder:'cineforge',type:'input'});
  });
  it('rejects output metadata that cannot fit the canonical project schema',()=>{
    expect(()=>validateComfyFileRef({filename:'x'.repeat(2049)},'output')).toThrow(/2048-character project safety limit/i);
    expect(()=>validateComfyFileRef({filename:'ok.png',subfolder:'x'.repeat(4097)},'output')).toThrow(/4096-character project safety limit/i);
    expect(()=>validateComfyFileRef({filename:'ok.png',type:'x'.repeat(4097)},'output')).toThrow(/4096-character project safety limit/i);
  });
});
describe('Comfy prompt identity bounds',()=>{
  it('ignores overlong recovered prompt ids instead of persisting invalid job identity',()=>{
    const id='p'.repeat(513),queue={queue_running:[[1,id,{}, {cineforge:{jobId:'job'}}]],queue_pending:[]};
    expect(cineforgePromptIdentities(queue,{},'job')).toEqual([]);
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
describe('Comfy targeted cancellation confirmation',()=>{
  it('does not trust a targeted cancel acknowledgement until the exact prompt is released',async()=>{
    const client=new ComfyClient('http://127.0.0.1:8188',true);
    let queueCalls=0,historyCalls=0;
    (client as any).request=async()=>new Response(JSON.stringify({cancelled:true}),{status:200,headers:{'content-type':'application/json'}});
    client.queue=async()=>{queueCalls+=1;return{queue_running:[],queue_pending:[]};};
    client.history=async()=>{historyCalls+=1;return{status:{messages:[['execution_interrupted',{prompt_id:'p'}]]}};};
    await client.cancelPrompt('p');
    expect(queueCalls).toBe(1);expect(historyCalls).toBe(1);
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




describe('render production provenance workflow identity',()=>{
  it('binds a take to the workflow profile actually used instead of whichever matching profile auto-routing would choose later',()=>{
    const shot:Shot={id:'s',sceneId:'scene',index:1,title:'S',prompt:'p',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false}};
    const profile=(id:string,path:string):WorkflowProfile=>({id,runtime:'wangp',purpose:'video',name:id,modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:path,workflowFormat:'wangp-settings',bindings:[],enabled:true,validation:{structuralStatus:'valid',sourceSha256:'0'.repeat(64)}});
    const a=profile('a','/tmp/a.json'),b=profile('b','/tmp/b.json');
    const project={shots:[shot],assets:[],shotStates:[],renderJobs:[],renderOutputs:[],settings:{workflowProfiles:[a,b]}} as unknown as FilmProject;
    const aKey=shotProductionInputKey(project,shot,a),bKey=shotProductionInputKey(project,shot,b);
    expect(aKey).not.toBe(bKey);
    const output={id:'out',jobId:'job-a',shotId:'s',path:'/tmp/out.mp4',filename:'out.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z',productionInputKey:aKey} as any;
    project.renderOutputs.push(output);
    project.renderJobs.push({id:'job-a',shotId:'s',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',status:'done',progress:1,message:'',modelFamily:'ltx-2.5-fast',workflowProfileId:'a',outputs:[],spec:{shot:structuredClone(shot),workflowProfile:structuredClone(a),effectivePrompt:'p',productionInputKey:aKey,queuedProjectUpdatedAt:'2026-01-01T00:00:00.000Z',workflowSha256:'0'.repeat(64),assetFingerprints:[],runtimeFingerprint:{backend:'wangp',environmentSha256:'0'.repeat(64)}}});
    expect(currentProductionInputKeyForOutput(project,shot,output)).toBe(aKey);
    project.settings.workflowProfiles=[b,a];
    expect(currentProductionInputKeyForOutput(project,shot,output)).toBe(aKey);
    project.settings.workflowProfiles.find(item=>item.id==='a')!.workflowPath='/tmp/a-v2.json';
    expect(currentProductionInputKeyForOutput(project,shot,output)).not.toBe(aKey);
    project.settings.workflowProfiles.find(item=>item.id==='a')!.workflowPath='/tmp/a.json';
    project.settings.workflowProfiles.find(item=>item.id==='a')!.validation!.sourceSha256='1'.repeat(64);
    expect(currentProductionInputKeyForOutput(project,shot,output)).toBeUndefined();
  });
});

describe('production state core',()=>{
  const rawTwoShotProject=()=>({
    schemaVersion:2,id:'state-project',name:'State Film',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
    story:{title:'State Film',logline:'',script:'',notes:''},
    scenes:[{id:'scene-state',index:1,heading:'INT. ROOM',body:'',shotIds:['shot-a','shot-b']}],
    assets:[{id:'frame-a',kind:'keyframe',name:'Frame A',sourcePath:'frame-a.png',projectPath:'assets/keyframe/frame-a.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}],
    shots:[
      {id:'shot-a',sceneId:'scene-state',index:1,title:'A',prompt:'A',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false},latestRenderId:'out-a'},
      {id:'shot-b',sceneId:'scene-state',index:2,title:'B',prompt:'B',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:2,negativePrompt:'',includeAudio:false}}
    ],
    renderJobs:[],
    renderOutputs:[{id:'out-a',jobId:'orphaned',shotId:'shot-a',path:'/project/renders/out-a.mp4',filename:'out-a.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:01.000Z',technicalQc:{checkedAt:'2026-01-01T00:00:01.000Z',passed:true,issues:[],warnings:[]}}],
    timeline:[],settings:{}
  });

  it('migrates v2 projects to schema v3 and derives deterministic adjacent continuity edges',()=>{
    const loaded=loadPortableProject(rawTwoShotProject(),'/project');
    expect(loaded.project.schemaVersion).toBe(3);
    expect(loaded.migratedFrom).toBe(2);
    expect(loaded.project.shots.every(shot=>shot.previz?.requirement==='none'&&shot.previz.status==='not-needed')).toBe(true);
    expect(loaded.project.shotDependencies).toHaveLength(1);
    expect(loaded.project.shotDependencies[0]).toMatchObject({fromShotId:'shot-a',toShotId:'shot-b',relation:'continuity',strength:'soft'});
    expect(loaded.project.shotDependencies[0].propagate).not.toContain('camera');
  });

  it('propagates only a current observed final state and invalidates its derived downstream start state when superseded',()=>{
    const project=loadPortableProject(rawTwoShotProject(),'/project').project;
    project.shotStates.push({
      id:'state-final-a',shotId:'shot-a',role:'observed-final',source:'generated',status:'current',frameAssetId:'frame-a',sourceRenderOutputId:'out-a',
      characters:[],props:[],environment:{timeOfDay:'NIGHT',lighting:'warm'},camera:{screenDirection:'left-to-right'},actionPhase:'hand on door',dialogueState:'line complete',confidence:.9,createdAt:'2026-01-01T00:00:02.000Z'
    });
    project.shots[0].observedFinalStateId='state-final-a';
    project.shotDependencies[0].propagate=[...DEFAULT_CONTINUITY_FIELDS,'camera'];
    const propagated=propagateObservedFinalState(project,'shot-a','2026-01-01T00:00:03.000Z');
    expect(propagated).toHaveLength(1);
    const next=project.shots.find(shot=>shot.id==='shot-b')!,state=project.shotStates.find(item=>item.id===next.actualStartStateId)!;
    expect(next.startFrameAssetId).toBe('frame-a');
    expect(state.derivedFromStateId).toBe('state-final-a');
    expect(state.status).toBe('current');
    expect(state.environment.lighting).toBe('warm');
    expect(state.camera).toEqual({screenDirection:'left-to-right'});

    invalidateObservedFinalState(project,'shot-a','new canonical take');
    expect(project.shotStates.find(item=>item.id==='state-final-a')?.status).toBe('stale');
    expect(state.status).toBe('stale');
    expect(next.actualStartStateId).toBeUndefined();
    expect(next.startFrameAssetId).toBeUndefined();
    expect(project.shots[0].observedFinalStateId).toBeUndefined();
  });

  it('does not overwrite an explicit human-owned start frame during automatic propagation',()=>{
    const project=loadPortableProject(rawTwoShotProject(),'/project').project;
    project.shotStates.push({
      id:'state-final-a',shotId:'shot-a',role:'observed-final',source:'generated',status:'current',frameAssetId:'frame-a',
      characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'
    });
    project.shots[0].observedFinalStateId='state-final-a';
    project.shots[1].startFrameAssetId='human-frame';
    expect(propagateObservedFinalState(project,'shot-a')).toEqual([]);
    expect(project.shots[1].startFrameAssetId).toBe('human-frame');
    expect(project.shots[1].actualStartStateId).toBeUndefined();
  });

  it('keeps canonical take promotion fail-closed until current technical, visual, semantic and incoming continuity QC all pass',()=>{
    const project=loadPortableProject(rawTwoShotProject(),'/project').project;
    const shot=project.shots.find(item=>item.id==='shot-b')!;
    shot.status='rendered';shot.latestRenderId='out-b';
    const output:RenderOutput={id:'out-b',jobId:'orphaned',shotId:'shot-b',path:'/project/renders/out-b.mp4',filename:'out-b.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:02.000Z',technicalQc:{checkedAt:'2026-01-01T00:00:02.000Z',passed:true,issues:[],warnings:[]}};
    project.renderOutputs.push(output);
    output.productionInputKey=shotProductionInputKey(project,shot);
    expect(canonicalTakeReadiness(project,'shot-b','out-b').ready).toBe(false);
    const createdAt='2026-01-01T00:00:03.000Z';
    project.qcResults.push(
      {id:'q-v',shotId:'shot-b',renderOutputId:'out-b',layer:'visual',status:'pass',issues:[],inputKey:shotQcInputKey(project,'shot-b','out-b','visual'),createdAt},
      {id:'q-s',shotId:'shot-b',renderOutputId:'out-b',layer:'semantic',status:'pass',issues:[],inputKey:shotQcInputKey(project,'shot-b','out-b','semantic'),createdAt}
    );
    expect(canonicalTakeReadiness(project,'shot-b','out-b')).toMatchObject({ready:false});
    project.qcResults.push({id:'q-c',shotId:'shot-b',renderOutputId:'out-b',layer:'continuity',status:'pass',issues:[],inputKey:shotQcInputKey(project,'shot-b','out-b','continuity'),createdAt});
    expect(canonicalTakeReadiness(project,'shot-b','out-b')).toEqual({ready:true,blockers:[]});
    project.qcResults.push({id:'q-s2',shotId:'shot-b',renderOutputId:'out-b',layer:'semantic',status:'fail',issues:[],inputKey:shotQcInputKey(project,'shot-b','out-b','semantic'),createdAt:'2026-01-01T00:00:04.000Z'});
    expect(canonicalTakeReadiness(project,'shot-b','out-b').blockers.join(' ')).toMatch(/semantic QC is fail/i);
    shot.prompt='changed after QC';
    expect(canonicalTakeReadiness(project,'shot-b','out-b').blockers.join(' ')).toMatch(/stale shot.*inputs|stale for current/i);
  });

  it('rejects broken schema-v3 state pointers instead of silently attaching state to the wrong shot',()=>{
    const migrated=loadPortableProject(rawTwoShotProject(),'/project').project as any;
    migrated.shotStates=[{id:'wrong-state',shotId:'shot-b',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'}];
    migrated.shots[0].observedFinalStateId='wrong-state';
    expect(()=>loadPortableProject(migrated,'/project')).toThrow(/observedFinalStateId references an invalid observed-final state/i);
  });

  it('renderer edits stale observed state and its propagated child instead of leaving false continuity truth alive',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-state-invalidation-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Film');
      const current=await service.mutate(project=>{
        project.scenes.push({id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['a','b']});
        const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false};
        project.shots.push(
          {id:'a',sceneId:'scene',index:1,title:'A',prompt:'old',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation},observedFinalStateId:'state-a'},
          {id:'b',sceneId:'scene',index:2,title:'B',prompt:'next',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation,seed:2},actualStartStateId:'state-b'}
        );
        project.shotDependencies.push({id:'edge',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character','prop','location','lighting','action','dialogue'],createdAt:'2026-01-01T00:00:00.000Z'});
        project.shotStates.push(
          {id:'state-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'end',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'},
          {id:'state-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',derivedFromStateId:'state-a',characters:[],props:[],environment:{},camera:{},actionPhase:'end',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'}
        );
      });
      const edited=structuredClone(current);edited.shots.find(shot=>shot.id==='a')!.prompt='changed';
      const saved=await service.saveFromRenderer(edited);
      expect(saved.shots.find(shot=>shot.id==='a')?.observedFinalStateId).toBeUndefined();
      expect(saved.shots.find(shot=>shot.id==='b')?.actualStartStateId).toBeUndefined();
      expect(saved.shotStates.find(state=>state.id==='state-a')?.status).toBe('stale');
      expect(saved.shotStates.find(state=>state.id==='state-b')?.status).toBe('stale');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});


describe('production state main-process authority',()=>{
  async function setupProject(){
    const root=await mkdtemp(join(tmpdir(),'cineforge-production-authority-'));
    const service=new ProjectService();await service.createAt(root,'Authority Film');
    await service.mutate(project=>{
      project.scenes.push({id:'scene-auth',index:1,heading:'INT. LAB',body:'',shotIds:['shot-auth']});
      project.shots.push({
        id:'shot-auth',sceneId:'scene-auth',index:1,title:'Authority Shot',prompt:'subject turns toward camera',camera:'medium',action:'turns',dialogue:'',continuityNotes:'',
        characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',previz:{requirement:'none',status:'not-needed'},
        generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:7,negativePrompt:'',includeAudio:false},
        latestRenderId:'out-auth',latestAttemptRenderId:'out-auth'
      });
      const shot=project.shots.find(item=>item.id==='shot-auth')!;
      project.renderOutputs.push({
        id:'out-auth',jobId:'orphaned',shotId:'shot-auth',path:join(root,'renders','out-auth.mp4'),filename:'out-auth.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z',
        productionInputKey:shotProductionInputKey(project,shot),
        technicalQc:{checkedAt:'2026-01-01T00:00:00.000Z',passed:true,issues:[],warnings:[]}
      });
    });
    return{root,service};
  }
  const qcKey=(service:ProjectService,layer:'visual'|'semantic'|'continuity')=>shotQcInputKey(service.getCurrent()!,'shot-auth','out-auth',layer);

  it('refuses canonical promotion until required QC passes and creates a durable human task for uncertain QC',async()=>{
    const{root,service}=await setupProject();
    try{
      await recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'pass',issues:[],inputKey:qcKey(service,'visual')});
      await expect(promoteCanonicalTake(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth'})).rejects.toThrow(/semantic QC is missing/i);

      const uncertain=await recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'semantic',status:'human-verify',issues:[{code:'ACTION_UNCERTAIN',severity:'major',message:'Turn completion is ambiguous.'}],inputKey:qcKey(service,'semantic')});
      const task=uncertain.humanTasks.find(item=>item.status==='open');
      expect(task).toMatchObject({type:'manual-qc',shotId:'shot-auth'});
      expect(uncertain.qcResults.find(item=>item.layer==='semantic'&&item.status==='human-verify')?.humanOverrideTaskId).toBe(task?.id);
      await expect(promoteCanonicalTake(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth'})).rejects.toThrow(/semantic QC is human-verify/i);
      await expect(resolveHumanTask(service,{projectRoot:root,taskId:task!.id,status:'resolved',resolution:'Premature close.'})).rejects.toThrow(/PASS or FAIL verdict/i);

      await recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'semantic',status:'pass',issues:[],inputKey:qcKey(service,'semantic')});
      expect(service.getCurrent()?.shots.find(item=>item.id==='shot-auth')?.canonicalRenderId).toBeUndefined();
      await expect(resolveHumanTask(service,{projectRoot:root,taskId:task!.id,status:'resolved',resolution:'Human review confirmed semantic QC PASS.'})).resolves.toMatchObject({schemaVersion:3});
      expect(service.getCurrent()?.shots.find(item=>item.id==='shot-auth')?.canonicalRenderId).toBe('out-auth');
      await expect(promoteCanonicalTake(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth'})).resolves.toMatchObject({schemaVersion:3});
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('deduplicates repeated human-verify verdicts for the same QC snapshot into one open task',async()=>{
    const{root,service}=await setupProject();
    try{
      const initial=service.getCurrent()!;
      const inputKey=shotQcInputKey(initial,'shot-auth','out-auth','visual');
      const first=await recordShotQc(service,{
        projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'human-verify',inputKey,
        issues:[{code:'FACE_UNCERTAIN',severity:'major',message:'Face match needs review.'}]
      });
      const firstTask=first.humanTasks.find(item=>item.status==='open')!;
      const second=await recordShotQc(service,{
        projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'human-verify',inputKey,
        issues:[{code:'FACE_STILL_UNCERTAIN',severity:'major',message:'Second evaluator still needs a human decision.'}]
      });
      const open=second.humanTasks.filter(item=>item.status==='open');
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe(firstTask.id);
      const reviewResults=second.qcResults.filter(item=>item.layer==='visual'&&item.status==='human-verify');
      expect(reviewResults).toHaveLength(2);
      expect(new Set(reviewResults.map(item=>item.humanOverrideTaskId))).toEqual(new Set([firstTask.id]));
      expect(open[0].reason).toMatch(/Second evaluator/i);

      const currentKey=shotQcInputKey(service.getCurrent()!,'shot-auth','out-auth','visual');
      await recordShotQc(service,{
        projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'pass',inputKey:currentKey,issues:[]
      });
      await resolveHumanTask(service,{
        projectRoot:root,taskId:firstTask.id,status:'resolved',resolution:'Human review confirmed visual QC PASS.'
      });
      expect(service.getCurrent()?.humanTasks.find(item=>item.id===firstTask.id)?.status).toBe('resolved');
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('automatically dismisses a pending human QC review when its shot provenance becomes stale',async()=>{
    const{root,service}=await setupProject();
    try{
      const uncertain=await recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'human-verify',issues:[{code:'FACE_UNCERTAIN',severity:'major',message:'Face match needs review.'}],inputKey:qcKey(service,'visual')});
      const task=uncertain.humanTasks.find(item=>item.status==='open')!;
      const edited=structuredClone(uncertain);edited.shots.find(item=>item.id==='shot-auth')!.prompt='changed after review request';
      const saved=await service.saveFromRenderer(edited);
      expect(saved.humanTasks.find(item=>item.id===task.id)).toMatchObject({status:'dismissed'});
      expect(saved.humanTasks.find(item=>item.id===task.id)?.resolution).toMatch(/became stale/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('rejects a QC PASS verdict that still contains a major or blocker issue',async()=>{
    const{root,service}=await setupProject();
    try{
      await expect(recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'pass',issues:[{code:'FACE_BROKEN',severity:'blocker',message:'Identity is visibly wrong.'}],inputKey:qcKey(service,'visual')})).rejects.toThrow(/PASS cannot contain major or blocker/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('records an observed final state only from a current render with technical, visual and semantic QC pass',async()=>{
    const{root,service}=await setupProject();
    try{
      await recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'visual',status:'pass',issues:[],inputKey:qcKey(service,'visual')});
      await recordShotQc(service,{projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',layer:'semantic',status:'pass',issues:[],inputKey:qcKey(service,'semantic')});
      const next=await recordObservedFinalState(service,{
        projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',
        characters:[],props:[],environment:{timeOfDay:'NIGHT',lighting:'warm practicals'},camera:{shotSize:'medium',screenDirection:'left-to-right'},
        actionPhase:'turn complete',dialogueState:'silent',confidence:.91
      });
      const shot=next.shots.find(item=>item.id==='shot-auth')!,state=next.shotStates.find(item=>item.id===shot.observedFinalStateId)!;
      expect(state).toMatchObject({role:'observed-final',source:'generated',status:'current',sourceRenderOutputId:'out-auth',actionPhase:'turn complete',confidence:.91});
      await service.mutate(project=>{project.renderOutputs.find(item=>item.id==='out-auth')!.technicalQc!.passed=false;});
      await expect(recordObservedFinalState(service,{
        projectRoot:root,shotId:'shot-auth',renderOutputId:'out-auth',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:''
      })).rejects.toThrow(/passes technical QC/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});


describe('production topology and destructive mutation regression guards',()=>{
  const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false};
  const shot=(id:string,index:number):Shot=>({id,sceneId:'scene-topology',index,title:id,prompt:id,camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation,seed:index}});

  it('does not add a contradictory default continuity edge when an explicit edge already owns the adjacent pair',()=>{
    const a=shot('a',1),b=shot('b',2);
    const project={
      schemaVersion:3,id:'explicit-edge',name:'explicit-edge',rootPath:'/tmp/explicit-edge',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'explicit-edge',logline:'',script:'',notes:''},scenes:[{id:'scene-topology',index:1,heading:'',body:'',shotIds:['a','b']}],
      assets:[],shots:[a,b],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],
      shotDependencies:[{id:'custom-parallel',fromShotId:'a',toShotId:'b',relation:'parallel',strength:'hard',propagate:[],createdAt:'2026-01-01T00:00:00.000Z'}],
      qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    rebuildDefaultSequentialDependencies(project,['scene-topology'],'2026-01-01T00:00:01.000Z');
    expect(project.shotDependencies).toEqual([expect.objectContaining({id:'custom-parallel',relation:'parallel'})]);
  });

  it('rebuilds sequential continuity after reorder and stales a propagated start whose predecessor changed',()=>{
    const a=shot('a',1),b=shot('b',2),c=shot('c',3);
    const project={
      schemaVersion:3,id:'p',name:'p',rootPath:'/tmp/p',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'p',logline:'',script:'',notes:''},scenes:[{id:'scene-topology',index:1,heading:'',body:'',shotIds:['a','b','c']}],
      assets:[],shots:[a,b,c],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    rebuildDefaultSequentialDependencies(project,['scene-topology'],'2026-01-01T00:00:00.000Z');
    project.shotStates.push(
      {id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'},
      {id:'start-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',derivedFromStateId:'final-a',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'}
    );
    a.observedFinalStateId='final-a';b.actualStartStateId='start-b';
    c.index=1;b.index=2;a.index=3;project.scenes[0].shotIds=['c','b','a'];
    rebuildDefaultSequentialDependencies(project,['scene-topology'],'2026-01-01T00:00:03.000Z');
    expect(project.shotDependencies.filter(edge=>edge.relation==='continuity').map(edge=>`${edge.fromShotId}>${edge.toShotId}`).sort()).toEqual(['b>a','c>b']);
    expect(b.actualStartStateId).toBeUndefined();
    expect(project.shotStates.find(state=>state.id==='start-b')?.status).toBe('stale');
  });

  it('removes a middle shot without leaving orphan state pointers and repairs A → C continuity',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-topology-delete-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Topology');
      const current=await service.mutate(project=>{
        project.scenes.push({id:'scene-topology',index:1,heading:'',body:'',shotIds:['a','b','c']});
        project.shots.push(shot('a',1),shot('b',2),shot('c',3));
        rebuildDefaultSequentialDependencies(project,['scene-topology']);
        project.shotStates.push(
          {id:'final-b',shotId:'b',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'},
          {id:'start-c',shotId:'c',role:'actual-start',source:'generated',status:'unreviewed',derivedFromStateId:'final-b',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'}
        );
        project.shots.find(item=>item.id==='b')!.observedFinalStateId='final-b';
        project.shots.find(item=>item.id==='c')!.actualStartStateId='start-c';
      });
      const edited=structuredClone(current);
      edited.shots=edited.shots.filter(item=>item.id!=='b');edited.scenes[0].shotIds=['a','c'];edited.shots.find(item=>item.id==='c')!.index=2;
      const saved=await service.saveFromRenderer(edited);
      expect(saved.shots.find(item=>item.id==='c')?.actualStartStateId).toBeUndefined();
      expect(saved.shotStates.some(state=>state.id==='start-c')).toBe(false);
      expect(saved.shotDependencies.some(edge=>edge.fromShotId==='a'&&edge.toShotId==='c'&&edge.relation==='continuity')).toBe(true);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('treats a renderer-created duplicate as a fresh shot even if the renderer accidentally copied authority IDs',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-duplicate-authority-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Duplicate');
      const current=await service.mutate(project=>{
        project.scenes.push({id:'scene-topology',index:1,heading:'',body:'',shotIds:['a']});
        const a=shot('a',1);a.latestRenderId='out';a.latestAttemptRenderId='out';a.canonicalRenderId='out';a.observedFinalStateId='state-a';project.shots.push(a);
        project.renderOutputs.push({id:'out',jobId:'orphaned',shotId:'a',path:join(root,'renders','out.mp4'),filename:'out.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z'});
        project.shotStates.push({id:'state-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:00.000Z'});
      });
      const edited=structuredClone(current),copy=structuredClone(edited.shots[0]);copy.id='copy';copy.index=2;edited.shots.push(copy);edited.scenes[0].shotIds.push('copy');
      const saved=await service.saveFromRenderer(edited),fresh=saved.shots.find(item=>item.id==='copy')!;
      expect(fresh.latestRenderId).toBeUndefined();expect(fresh.latestAttemptRenderId).toBeUndefined();expect(fresh.canonicalRenderId).toBeUndefined();
      expect(fresh.plannedStartStateId).toBeUndefined();expect(fresh.plannedEndStateId).toBeUndefined();expect(fresh.actualStartStateId).toBeUndefined();expect(fresh.observedFinalStateId).toBeUndefined();
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('turns a renderer start-frame override into human-owned state and never resurrects stale propagated truth',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-human-start-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Human start');
      const current=await service.mutate(project=>{
        project.scenes.push({id:'scene-topology',index:1,heading:'',body:'',shotIds:['a','b']});
        project.assets.push(
          {id:'auto-frame',kind:'keyframe',name:'auto',sourcePath:'auto.png',projectPath:'assets/keyframe/auto.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'},
          {id:'human-frame',kind:'keyframe',name:'human',sourcePath:'human.png',projectPath:'assets/keyframe/human.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}
        );
        project.shots.push(shot('a',1),{...shot('b',2),startFrameAssetId:'auto-frame',actualStartStateId:'start-b',observedFinalStateId:'final-b',status:'rendered'});
        project.shotStates.push(
          {id:'start-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',frameAssetId:'auto-frame',characters:[],props:[],environment:{lighting:'warm'},camera:{},actionPhase:'enter',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'},
          {id:'final-b',shotId:'b',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{lighting:'warm'},camera:{},actionPhase:'exit',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'}
        );
      });
      const edited=structuredClone(current);edited.shots.find(item=>item.id==='b')!.startFrameAssetId='human-frame';
      const saved=await service.saveFromRenderer(edited),b=saved.shots.find(item=>item.id==='b')!;
      const actual=saved.shotStates.find(state=>state.id===b.actualStartStateId)!;
      expect(actual).toMatchObject({role:'actual-start',source:'human',status:'current',frameAssetId:'human-frame'});
      expect(saved.shotStates.find(state=>state.id==='start-b')?.status).toBe('stale');
      expect(saved.shotStates.find(state=>state.id==='final-b')?.status).toBe('stale');
      expect(b.observedFinalStateId).toBeUndefined();
      expect(b.canonicalRenderId).toBeUndefined();
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('cascades render-output deletion through derived continuity state',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-output-state-delete-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Delete output');
      await service.mutate(project=>{
        project.scenes.push({id:'scene-topology',index:1,heading:'',body:'',shotIds:['a','b']});project.shots.push(shot('a',1),shot('b',2));
        project.renderOutputs.push({id:'out-a',jobId:'orphaned',shotId:'a',path:join(root,'renders','out-a.mp4'),filename:'out-a.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z'});
        project.shotStates.push(
          {id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',sourceRenderOutputId:'out-a',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'},
          {id:'start-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',sourceRenderOutputId:'out-a',derivedFromStateId:'final-a',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'}
        );
        project.shots.find(item=>item.id==='a')!.observedFinalStateId='final-a';project.shots.find(item=>item.id==='b')!.actualStartStateId='start-b';
      });
      const saved=await service.deleteRenderOutput('out-a');
      expect(saved.shots.find(item=>item.id==='a')?.observedFinalStateId).toBeUndefined();
      expect(saved.shots.find(item=>item.id==='b')?.actualStartStateId).toBeUndefined();
      expect(saved.shotStates.find(item=>item.id==='final-a')?.status).toBe('stale');
      expect(saved.shotStates.find(item=>item.id==='start-b')?.status).toBe('stale');
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('does not resurrect server canonical/state pointers over an unsaved dirty render-input edit',()=>{
    const localShot=shot('a',1),serverShot=structuredClone(localShot);
    localShot.prompt='edited locally';localShot.canonicalRenderId=undefined;localShot.observedFinalStateId=undefined;
    serverShot.prompt='old server prompt';serverShot.canonicalRenderId='out-a';serverShot.observedFinalStateId='final-a';
    const base={
      schemaVersion:3,id:'sync-project',name:'sync',rootPath:'/tmp/sync',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'sync',logline:'',script:'',notes:''},scenes:[{id:'scene-topology',index:1,heading:'',body:'',shotIds:['a']}],
      assets:[],renderJobs:[],timeline:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    };
    const local={...structuredClone(base),shots:[localShot],renderOutputs:[],shotStates:[]} as FilmProject;
    const server={...structuredClone(base),shots:[serverShot],renderOutputs:[{id:'out-a',jobId:'orphaned',shotId:'a',path:'/tmp/sync/renders/out-a.mp4',filename:'out-a.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:01.000Z'}],shotStates:[{id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'}]} as FilmProject;
    useAppStore.setState({project:local,projectDirty:true});
    useAppStore.getState().syncRuntime(server);
    const merged=useAppStore.getState().project!;
    expect(merged.shots[0].prompt).toBe('edited locally');
    expect(merged.shots[0].canonicalRenderId).toBeUndefined();
    expect(merged.shots[0].observedFinalStateId).toBeUndefined();
    expect(merged.shotStates).toEqual([]);
    expect(merged.renderOutputs.map(output=>output.id)).toEqual(['out-a']);
    useAppStore.setState({project:null,projectDirty:false});
  });

  it('persists a renderer preferred-take change without granting canonical authority',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-preferred-take-'));
    try{
      const service=new ProjectService();await service.createAt(root,'Preferred');
      const current=await service.mutate(project=>{
        project.scenes.push({id:'scene-topology',index:1,heading:'',body:'',shotIds:['a']});
        const a=shot('a',1);a.latestRenderId='out-1';a.canonicalRenderId='out-1';a.status='rendered';project.shots.push(a);
        project.renderOutputs.push(
          {id:'out-1',jobId:'orphaned',shotId:'a',path:join(root,'renders','out-1.mp4'),filename:'out-1.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:01.000Z'},
          {id:'out-2',jobId:'orphaned',shotId:'a',path:join(root,'renders','out-2.mp4'),filename:'out-2.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:02.000Z'}
        );
      });
      const edited=structuredClone(current);edited.shots[0].latestRenderId='out-2';edited.shots[0].canonicalRenderId='out-2';
      const saved=await service.saveFromRenderer(edited);
      expect(saved.shots[0].latestRenderId).toBe('out-2');
      expect(saved.shots[0].canonicalRenderId).toBe('out-1');
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('includes current structured start state in the effective render prompt and signature',()=>{
    const a=shot('a',1),project={
      shots:[a],assets:[],shotStates:[{id:'actual-a',shotId:'a',role:'actual-start',source:'generated',status:'current',characters:[],props:[],environment:{lighting:'blue moonlight'},camera:{screenDirection:'left-to-right'},actionPhase:'mid reach',dialogueState:'silent',createdAt:'2026-01-01T00:00:00.000Z'}],
      settings:{workflowProfiles:[]}
    } as unknown as FilmProject;
    a.actualStartStateId='actual-a';
    expect(buildRenderPrompt(project,a)).toMatch(/Actual start state:.*blue moonlight.*mid reach/);
    const first=shotProjectRenderInputKey(project,a);(project.shotStates[0] as any).actionPhase='reach complete';
    expect(shotProjectRenderInputKey(project,a)).not.toBe(first);
  });

  it('cascades stale upstream continuity truth through A → B → C instead of leaving B final state alive',()=>{
    const a=shot('a',1),b=shot('b',2),cc=shot('c',3);
    const project={
      schemaVersion:3,id:'cascade',name:'cascade',rootPath:'/tmp/cascade',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'cascade',logline:'',script:'',notes:''},scenes:[{id:'scene-topology',index:1,heading:'',body:'',shotIds:['a','b','c']}],
      assets:[],shots:[a,b,cc],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    rebuildDefaultSequentialDependencies(project,['scene-topology']);
    project.shotStates.push(
      {id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'a-end',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'},
      {id:'start-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',derivedFromStateId:'final-a',characters:[],props:[],environment:{},camera:{},actionPhase:'a-end',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'},
      {id:'final-b',shotId:'b',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'b-end',dialogueState:'',createdAt:'2026-01-01T00:00:03.000Z'},
      {id:'start-c',shotId:'c',role:'actual-start',source:'generated',status:'unreviewed',derivedFromStateId:'final-b',characters:[],props:[],environment:{},camera:{},actionPhase:'b-end',dialogueState:'',createdAt:'2026-01-01T00:00:04.000Z'}
    );
    a.observedFinalStateId='final-a';b.actualStartStateId='start-b';b.observedFinalStateId='final-b';cc.actualStartStateId='start-c';
    invalidateObservedFinalState(project,'a','A changed.');
    expect(project.shotStates.find(state=>state.id==='start-b')?.status).toBe('stale');
    expect(project.shotStates.find(state=>state.id==='final-b')?.status).toBe('stale');
    expect(project.shotStates.find(state=>state.id==='start-c')?.status).toBe('stale');
    expect(b.actualStartStateId).toBeUndefined();expect(b.observedFinalStateId).toBeUndefined();expect(cc.actualStartStateId).toBeUndefined();
  });
});


describe('continuity QC topology scoping',()=>{
  const makeShot=(id:string,index:number):Shot=>({
    id,sceneId:'scene-qc',index,title:id,prompt:id,camera:'',action:'',dialogue:'',continuityNotes:'',
    characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',
    generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:index,negativePrompt:'',includeAudio:false}
  });
  const makeProject=():FilmProject=>{
    const shots=[makeShot('a',1),makeShot('b',2),makeShot('c',3)];
    const project={
      schemaVersion:3,id:'qc-topology',name:'QC Topology',rootPath:'/tmp/qc-topology',
      createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'QC Topology',logline:'',script:'',notes:''},
      scenes:[{id:'scene-qc',index:1,heading:'',body:'',shotIds:['a','b','c']}],
      assets:[],shots,renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    rebuildDefaultSequentialDependencies(project,['scene-qc'],'2026-01-01T00:00:00.000Z');
    project.renderOutputs.push({
      id:'out-b',jobId:'orphaned',shotId:'b',path:'/tmp/qc-topology/renders/out-b.mp4',filename:'out-b.mp4',mediaType:'video',
      createdAt:'2026-01-01T00:00:01.000Z',productionInputKey:shotProductionInputKey(project,shots[1]),
      technicalQc:{checkedAt:'2026-01-01T00:00:01.000Z',passed:true,issues:[],warnings:[]}
    });
    return project;
  };

  it('dismisses a pending continuity review when sequential topology changes',()=>{
    const project=makeProject();
    const inputKey=shotQcInputKey(project,'b','out-b','continuity');
    project.qcResults.push({
      id:'qc-human',shotId:'b',renderOutputId:'out-b',layer:'continuity',status:'human-verify',
      issues:[{code:'CHECK',severity:'major',message:'Needs review.'}],inputKey,createdAt:'2026-01-01T00:00:02.000Z',humanOverrideTaskId:'task-human'
    });
    project.humanTasks.push({
      id:'task-human',type:'verify-continuity',status:'open',shotId:'b',title:'Review',reason:'Needs review.',
      relatedAssetIds:[],relatedRenderOutputIds:['out-b'],createdAt:'2026-01-01T00:00:02.000Z'
    });
    project.shots.find(shot=>shot.id==='a')!.index=1;
    project.shots.find(shot=>shot.id==='c')!.index=2;
    project.shots.find(shot=>shot.id==='b')!.index=3;
    project.scenes[0].shotIds=['a','c','b'];
    rebuildDefaultSequentialDependencies(project,['scene-qc'],'2026-01-01T00:00:03.000Z');
    expect(project.shotDependencies.some(edge=>edge.toShotId==='b'&&edge.fromShotId==='c')).toBe(true);
    expect(project.humanTasks.find(task=>task.id==='task-human')).toMatchObject({status:'dismissed'});
  });

  it('does not stale continuity QC merely because a parallel or non-propagating edge changes',()=>{
    const project=makeProject();
    const before=shotQcInputKey(project,'b','out-b','continuity');
    project.shotDependencies.push({
      id:'parallel-b-c',fromShotId:'b',toShotId:'c',relation:'parallel',strength:'soft',
      propagate:['character'],createdAt:'2026-01-01T00:00:02.000Z'
    });
    project.shotDependencies.push({
      id:'metadata-only-a-b',fromShotId:'a',toShotId:'b',relation:'cutaway',strength:'soft',
      propagate:[],createdAt:'2026-01-01T00:00:02.000Z'
    });
    expect(shotQcInputKey(project,'b','out-b','continuity')).toBe(before);
  });
});


describe('continuity state fingerprint completeness',()=>{
  it('changes continuity QC provenance when state confidence changes even if stored fingerprint is stale',()=>{
    const shotA={
      id:'a',sceneId:'scene',index:1,title:'A',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',
      characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',
      generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false},
      observedFinalStateId:'state-a'
    } as Shot;
    const shotB={...structuredClone(shotA),id:'b',index:2,observedFinalStateId:undefined,actualStartStateId:'state-b'} as Shot;
    const project={
      schemaVersion:3,id:'p',name:'p',rootPath:'/tmp/p',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'p',logline:'',script:'',notes:''},scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b']}],
      assets:[],shots:[shotA,shotB],renderJobs:[],renderOutputs:[{id:'out-b',jobId:'x',shotId:'b',path:'/tmp/p/renders/b.mp4',filename:'b.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z'}],
      timeline:[],shotStates:[
        {id:'state-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',confidence:.95,fingerprint:'legacy-stale',createdAt:'2026-01-01T00:00:00.000Z'},
        {id:'state-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',derivedFromStateId:'state-a',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',confidence:.95,fingerprint:'legacy-stale',createdAt:'2026-01-01T00:00:00.000Z'}
      ],
      shotDependencies:[{id:'edge',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}],
      qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    const before=shotQcInputKey(project,'b','out-b','continuity');
    project.shotStates.find(state=>state.id==='state-a')!.confidence=.4;
    expect(shotQcInputKey(project,'b','out-b','continuity')).not.toBe(before);
  });
});


describe('manual continuity frame selection',()=>{
  it('prefers a current observed final frame over the planned end keyframe and falls back explicitly',()=>{
    const shot={
      id:'shot',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',
      characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',endFrameAssetId:'planned',
      observedFinalStateId:'observed',
      generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false}
    } as Shot;
    const project={
      shots:[shot],
      shotStates:[{id:'observed',shotId:'shot',role:'observed-final',source:'generated',status:'current',frameAssetId:'actual',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:00.000Z'}]
    } as unknown as FilmProject;
    expect(continuityFrameForShot(project,shot)).toEqual({assetId:'actual',source:'observed-final'});
    project.shotStates[0].status='stale';
    expect(continuityFrameForShot(project,shot)).toEqual({assetId:'planned',source:'planned-end'});
    shot.endFrameAssetId=undefined;
    expect(continuityFrameForShot(project,shot)).toBeUndefined();
  });
});


describe('human QC reconciliation canonical refresh',()=>{
  it('re-evaluates canonical readiness after a stale review task is auto-dismissed',()=>{
    const shot={
      id:'b',sceneId:'scene',index:1,title:'B',prompt:'B',camera:'',action:'',dialogue:'',continuityNotes:'',
      characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',
      generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false}
    } as Shot;
    const project={
      schemaVersion:3,id:'p',name:'p',rootPath:'/tmp/p',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'p',logline:'',script:'',notes:''},scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b']}],
      assets:[],shots:[{...structuredClone(shot),id:'a',index:0},shot],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],
      shotDependencies:[{id:'edge',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}],
      qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    const output={id:'out-b',jobId:'legacy',shotId:'b',path:'/tmp/p/renders/b.mp4',filename:'b.mp4',mediaType:'video' as const,createdAt:'2026-01-01T00:00:01.000Z',productionInputKey:shotProductionInputKey(project,shot),technicalQc:{checkedAt:'2026-01-01T00:00:01.000Z',passed:true,issues:[],warnings:[]}};
    project.renderOutputs.push(output);
    project.qcResults.push(
      {id:'visual',shotId:'b',renderOutputId:'out-b',layer:'visual',status:'pass',issues:[],inputKey:shotQcInputKey(project,'b','out-b','visual'),createdAt:'2026-01-01T00:00:02.000Z'},
      {id:'semantic',shotId:'b',renderOutputId:'out-b',layer:'semantic',status:'pass',issues:[],inputKey:shotQcInputKey(project,'b','out-b','semantic'),createdAt:'2026-01-01T00:00:02.000Z'}
    );
    const continuityKey=shotQcInputKey(project,'b','out-b','continuity');
    project.qcResults.push({id:'continuity',shotId:'b',renderOutputId:'out-b',layer:'continuity',status:'human-verify',issues:[],inputKey:continuityKey,createdAt:'2026-01-01T00:00:02.000Z',humanOverrideTaskId:'task'});
    project.humanTasks.push({id:'task',type:'verify-continuity',status:'open',shotId:'b',title:'Review',reason:'Review',relatedAssetIds:[],relatedRenderOutputIds:['out-b'],createdAt:'2026-01-01T00:00:02.000Z'});
    expect(canonicalTakeReadiness(project,'b','out-b').ready).toBe(false);
    project.shotDependencies=[];
    expect(reconcileHumanQcTasks(project,['b'])).toEqual(['task']);
    expect(project.humanTasks[0].status).toBe('dismissed');
    expect(project.shots.find(item=>item.id==='b')?.canonicalRenderId).toBe('out-b');
  });
});


describe('QC ordering determinism',()=>{
  it('treats the later appended verdict as latest when timestamps are equal',()=>{
    const project={qcResults:[
      {id:'review',shotId:'s',renderOutputId:'o',layer:'semantic',status:'human-verify',issues:[],inputKey:'k',createdAt:'2026-01-01T00:00:00.000Z'},
      {id:'pass',shotId:'s',renderOutputId:'o',layer:'semantic',status:'pass',issues:[],inputKey:'k',createdAt:'2026-01-01T00:00:00.000Z'}
    ]} as unknown as FilmProject;
    expect(latestShotQcResult(project,'s','o','semantic','k')?.id).toBe('pass');
  });
});


describe('automatic previz advisor',()=>{
  const shot=(patch:Partial<Shot>={}):Shot=>({
    id:'shot-previz',sceneId:'scene',index:1,title:'Previz shot',prompt:'A quiet medium shot',camera:'locked medium',action:'stands still',dialogue:'',continuityNotes:'',
    characterAssetIds:['char-1'],propAssetIds:[],referenceAssetIds:[],status:'ready',
    generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false},
    ...patch
  });
  it('keeps simple coverage out of Blender while escalating spatially hard shots',()=>{
    expect(advisePreviz(shot()).requirement).toBe('none');
    const hard=advisePreviz(shot({
      camera:'360 orbit tracking shot around three performers',
      action:'three characters hand off a prop while walking through a doorway',
      characterAssetIds:['a','b','c'],
      propAssetIds:['p1','p2'],
      continuityNotes:'Precise blocking and screen direction must match.'
    }));
    expect(hard.requirement).toBe('required');
    expect(hard.score).toBeGreaterThanOrEqual(4);
    expect(hard.reasons.length).toBeGreaterThan(1);
  });
});

describe('previz human-task lifecycle',()=>{
  it('marks required previz ready when the human explicitly approves its review task',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-previz-task-'));
    const service=new ProjectService();
    try{
      await service.createAt(root,'Previz Task');
      await service.mutate(project=>{
        project.scenes.push({id:'scene',index:1,heading:'INT. SET',body:'',shotIds:['shot']});
        project.shots.push({
          id:'shot',sceneId:'scene',index:1,title:'Spatial shot',prompt:'orbit',camera:'orbit',action:'walk around table',dialogue:'',continuityNotes:'',
          characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',
          previz:{requirement:'required',status:'pending',reason:'Auto previz advisor',createdAt:'2026-01-01T00:00:00.000Z'},
          generation:{modelFamily:'ltx-2.5-fast',mode:'t2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false}
        });
      });
      const created=await createHumanTask(service,{projectRoot:root,type:'verify-previz',shotId:'shot',title:'3D previz required',reason:'Spatial blocking needs review.'});
      const task=created.humanTasks.find(item=>item.status==='open'&&item.type==='verify-previz')!;
      const resolved=await resolveHumanTask(service,{projectRoot:root,taskId:task.id,status:'resolved',resolution:'Approved viewport blocking and camera path.'});
      expect(resolved.humanTasks.find(item=>item.id===task.id)?.status).toBe('resolved');
      expect(resolved.shots.find(item=>item.id==='shot')?.previz).toMatchObject({requirement:'required',status:'ready'});
      expect(resolved.shots.find(item=>item.id==='shot')?.previz?.reason).toMatch(/Human override: previz approved/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});


describe('autonomous production journal',()=>{
  it('round-trips a recoverable run and filters stale ids against the open project',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-auto-journal-'));
    const service=new ProjectService();
    try{
      await service.createAt(root,'Auto Journal');
      await service.mutate(next=>{
        next.scenes.push({id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['shot']});
        next.shots.push({
          id:'shot',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',
          characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',
          generation:{modelFamily:'ltx-2.5-fast',mode:'t2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false}
        });
      });
      const current=service.getCurrent()!;
      const journal=new AutomationJournal();
      await journal.write(current,{
        schemaVersion:1,projectId:current.id,projectRoot:root,targetShotIds:['shot'],maxAutoRetries:2,buildTimeline:true,
        status:{running:true,paused:false,phase:'waiting-render',projectRoot:root,currentShotId:'shot',message:'waiting',startedAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:01.000Z',completedShotIds:[],retryCounts:{shot:1},blockedHumanTaskIds:[]}
      });
      const restored=await journal.read(service.getCurrent()!);
      expect(restored).toMatchObject({targetShotIds:['shot'],maxAutoRetries:2,buildTimeline:true});
      expect(restored?.status).toMatchObject({running:true,currentShotId:'shot',retryCounts:{shot:1}});
    }finally{await rm(root,{recursive:true,force:true});}
  });
});

describe('renderer autonomous edit lock',()=>{
  it('blocks project edits while AUTO RUN owns production and permits them once paused',()=>{
    const project={
      schemaVersion:3,id:'lock-project',name:'Lock',rootPath:'/tmp/lock',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'Before',logline:'',script:'',notes:''},scenes:[],assets:[],shots:[],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    useAppStore.setState({project,projectDirty:false,automation:{running:true,paused:false,phase:'planning',message:'running',updatedAt:'2026-01-01T00:00:00.000Z',completedShotIds:[],retryCounts:{},blockedHumanTaskIds:[]}});
    useAppStore.getState().updateProject(next=>{next.story.title='Blocked';});
    expect(useAppStore.getState().project?.story.title).toBe('Before');
    expect(useAppStore.getState().projectDirty).toBe(false);
    useAppStore.setState(state=>({automation:{...state.automation!,paused:true,phase:'paused'}}));
    useAppStore.getState().updateProject(next=>{next.story.title='Allowed';});
    expect(useAppStore.getState().project?.story.title).toBe('Allowed');
    expect(useAppStore.getState().projectDirty).toBe(true);
    useAppStore.getState().setProject(null);
    useAppStore.setState({automation:undefined});
  });
});


describe('directional continuity canonical gate',()=>{
  it('lets an upstream shot canonicalize before its successor exists, while requiring incoming continuity on the successor',()=>{
    const makeShot=(id:string,index:number):Shot=>({
      id,sceneId:'scene',index,title:id,prompt:id,camera:'',action:'',dialogue:'',continuityNotes:'',
      characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',
      generation:{modelFamily:'ltx-2.5-fast',mode:'t2v',quality:'balanced',width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:index,negativePrompt:'',includeAudio:false}
    });
    const a=makeShot('a',1),b=makeShot('b',2);
    const project={
      schemaVersion:3,id:'directional-qc',name:'directional',rootPath:'/tmp/directional',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'directional',logline:'',script:'',notes:''},scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b']}],
      assets:[],shots:[a,b],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],
      shotDependencies:[{id:'edge-a-b',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}],
      qcResults:[],humanTasks:[],cutRevisions:[],
      settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    } as FilmProject;
    for(const shot of [a,b]){
      const output:RenderOutput={id:`out-${shot.id}`,jobId:'legacy',shotId:shot.id,path:`/tmp/directional/${shot.id}.mp4`,filename:`${shot.id}.mp4`,mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z',technicalQc:{checkedAt:'2026-01-01T00:00:00.000Z',passed:true,issues:[],warnings:[]}};
      project.renderOutputs.push(output);
      output.productionInputKey=shotProductionInputKey(project,shot);
      for(const layer of ['visual','semantic'] as const)project.qcResults.push({id:`${shot.id}-${layer}`,shotId:shot.id,renderOutputId:output.id,layer,status:'pass',issues:[],inputKey:shotQcInputKey(project,shot.id,output.id,layer),createdAt:'2026-01-01T00:00:01.000Z'});
    }
    expect(canonicalTakeReadiness(project,'a','out-a')).toMatchObject({ready:true});
    const bBefore=canonicalTakeReadiness(project,'b','out-b');
    expect(bBefore.ready).toBe(false);
    expect(bBefore.blockers.join(' ')).toMatch(/continuity QC is missing/i);
    project.qcResults.push({id:'b-continuity',shotId:'b',renderOutputId:'out-b',layer:'continuity',status:'pass',issues:[],inputKey:shotQcInputKey(project,'b','out-b','continuity'),createdAt:'2026-01-01T00:00:02.000Z'});
    expect(canonicalTakeReadiness(project,'b','out-b')).toMatchObject({ready:true});
  });
});


describe('observed-state truth hardening',()=>{
  const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false};
  const shot:Shot={
    id:'shot-observed',sceneId:'scene',index:1,title:'Observed truth',prompt:'',camera:'planned dolly',action:'planned door opening',dialogue:'planned line',continuityNotes:'',
    characterAssetIds:['char-1'],locationAssetId:'loc-1',propAssetIds:[],referenceAssetIds:[],status:'ready',generation
  };
  const project={
    assets:[
      {id:'char-1',kind:'character',name:'Hero',sourcePath:'hero.png',projectPath:'assets/character/hero.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'},
      {id:'loc-1',kind:'location',name:'Room',sourcePath:'room.png',projectPath:'assets/location/room.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}
    ],
    scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['shot-observed']}]
  } as any as FilmProject;

  it('does not promote planned location/action or an invented confidence when the VLM omits them',()=>{
    const draft=observedStateDraftFromVisionResult(project,shot,{environment:{lighting:'warm'},camera:{},characters:[],props:[]});
    expect(draft.environment.locationAssetId).toBeUndefined();
    expect(draft.actionPhase).toBe('');
    expect(draft.confidence).toBe(0);
    expect(draft.environment.lighting).toBe('warm');
  });

  it('records a location/action only when the VLM explicitly returns observed values',()=>{
    const draft=observedStateDraftFromVisionResult(project,shot,{environment:{locationAssetId:'loc-1'},actionPhase:'door visibly open',confidence:.82,characters:[],props:[]});
    expect(draft.environment.locationAssetId).toBe('loc-1');
    expect(draft.actionPhase).toBe('door visibly open');
    expect(draft.confidence).toBe(.82);
    const wrong=observedStateDraftFromVisionResult(project,shot,{environment:{locationAssetId:'unknown-location'},actionPhase:'',confidence:.5,characters:[],props:[]});
    expect(wrong.environment.locationAssetId).toBeUndefined();
  });

  it('does not treat a generic resolved human task as approval of low-confidence observed state',()=>{
    const base={
      shotId:'shot-observed',type:'manual-qc' as const,title:'Observed final state confidence · Observed truth',status:'resolved' as const,
      relatedRenderOutputIds:['out-1']
    };
    expect(isApprovedObservedStateReview({...base,resolution:'Reviewed and resolved explicitly in Studio.'},'shot-observed',base.title,'out-1')).toBe(false);
    expect(isApprovedObservedStateReview({...base,resolution:`${OBSERVED_STATE_APPROVAL_PREFIX} final frame checked`},'shot-observed',base.title,'out-1')).toBe(true);
    expect(isApprovedObservedStateReview({...base,resolution:`${OBSERVED_STATE_APPROVAL_PREFIX} final frame checked`},'shot-observed',base.title,'out-2')).toBe(false);
  });
});

describe('field-scoped continuity frame propagation',()=>{
  const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false};
  const makeProject=(propagate:any[]):FilmProject=>{
    const a:Shot={id:'a',sceneId:'scene',index:1,title:'A',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'rendered',generation:{...generation},observedFinalStateId:'final-a'};
    const b:Shot={id:'b',sceneId:'scene',index:2,title:'B',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation,seed:2}};
    return{
      schemaVersion:3,id:'p',name:'p',rootPath:'/tmp/p',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
      story:{title:'p',logline:'',script:'',notes:''},scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b']}],assets:[],shots:[a,b],renderJobs:[],renderOutputs:[],timeline:[],
      shotStates:[{id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',frameAssetId:'frame-a',characters:[],props:[],environment:{lighting:'warm'},camera:{shotSize:'wide'},actionPhase:'done',dialogueState:'silent',confidence:.9,createdAt:'2026-01-01T00:00:01.000Z'}],
      shotDependencies:[{id:'edge',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate,createdAt:'2026-01-01T00:00:00.000Z'}],
      qcResults:[],humanTasks:[],cutRevisions:[],settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    };
  };

  it('does not attach the upstream final frame for a partial continuity contract',()=>{
    const project=makeProject(['lighting']);
    propagateObservedFinalState(project,'a');
    const target=project.shots.find(shot=>shot.id==='b')!;
    const state=project.shotStates.find(item=>item.id===target.actualStartStateId)!;
    expect(state.environment.lighting).toBe('warm');
    expect(state.frameAssetId).toBeUndefined();
    expect(target.startFrameAssetId).toBeUndefined();
  });

  it('still carries the frame when the dependency explicitly propagates the complete visual-frame contract',()=>{
    const project=makeProject([...DEFAULT_CONTINUITY_FIELDS,'camera']);
    propagateObservedFinalState(project,'a');
    const target=project.shots.find(shot=>shot.id==='b')!;
    const state=project.shotStates.find(item=>item.id===target.actualStartStateId)!;
    expect(state.frameAssetId).toBe('frame-a');
    expect(target.startFrameAssetId).toBe('frame-a');
  });

  it('removes a previously propagated frame when the dependency is narrowed later',()=>{
    const project=makeProject([...DEFAULT_CONTINUITY_FIELDS,'camera']);
    propagateObservedFinalState(project,'a');
    const target=project.shots.find(shot=>shot.id==='b')!;
    const firstStateId=target.actualStartStateId!;
    expect(target.startFrameAssetId).toBe('frame-a');
    project.shotDependencies[0].propagate=['lighting'];
    propagateObservedFinalState(project,'a');
    const nextState=project.shotStates.find(item=>item.id===target.actualStartStateId)!;
    expect(target.actualStartStateId).not.toBe(firstStateId);
    expect(project.shotStates.find(item=>item.id===firstStateId)?.status).toBe('stale');
    expect(nextState.environment.lighting).toBe('warm');
    expect(nextState.frameAssetId).toBeUndefined();
    expect(target.startFrameAssetId).toBeUndefined();
  });
});


describe('next-five production hardening',()=>{
  const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false};
  const shot=(id:string,index:number):Shot=>({
    id,sceneId:'scene',index,title:id,prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',
    characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation,seed:index}
  });
  const projectBase=():FilmProject=>({
    schemaVersion:3,id:'next-five',name:'Next Five',rootPath:'/tmp/next-five',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
    story:{title:'Next Five',logline:'',script:'',notes:''},
    scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['a','b','c']}],
    assets:[],shots:[shot('a',1),shot('b',2),shot('c',3)],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
    settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
  });

  it('never exposes an unreviewed actual-start frame as a generation conditioning frame',()=>{
    const project=projectBase(),target=project.shots[1];
    project.assets.push({id:'frame',kind:'keyframe',name:'Frame',sourcePath:'frame.jpg',projectPath:'assets/keyframe/frame.jpg',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'});
    target.actualStartStateId='start-b';
    project.shotStates.push({id:'start-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',frameAssetId:'frame',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:00.000Z'});
    expect(currentActualStartFrameAssetId(project,target)).toBeUndefined();
    project.shotStates[0].status='current';
    expect(currentActualStartFrameAssetId(project,target)).toBe('frame');
  });

  it('marks deterministic full-frame propagation current but leaves metadata-only propagation unreviewed',()=>{
    const full=projectBase();
    full.assets.push({id:'frame',kind:'keyframe',name:'Frame',sourcePath:'frame.jpg',projectPath:'assets/keyframe/frame.jpg',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'});
    full.shots[0].observedFinalStateId='final-a';
    full.shotStates.push({id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',frameAssetId:'frame',characters:[],props:[],environment:{lighting:'warm'},camera:{shotSize:'wide'},actionPhase:'done',dialogueState:'',createdAt:'2026-01-01T00:00:00.000Z'});
    full.shotDependencies=[{id:'ab',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:[...DEFAULT_CONTINUITY_FIELDS,'camera'],createdAt:'2026-01-01T00:00:00.000Z'}];
    propagateObservedFinalState(full,'a');
    expect(full.shotStates.find(state=>state.id===full.shots[1].actualStartStateId)?.status).toBe('current');

    const metadata=projectBase();
    metadata.shots[0].observedFinalStateId='final-a';
    metadata.shotStates.push({id:'final-a',shotId:'a',role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{lighting:'warm'},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:00.000Z'});
    metadata.shotDependencies=[{id:'ab',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['lighting'],createdAt:'2026-01-01T00:00:00.000Z'}];
    propagateObservedFinalState(metadata,'a');
    expect(metadata.shotStates.find(state=>state.id===metadata.shots[1].actualStartStateId)?.status).toBe('unreviewed');
  });

  it('preserves an existing human-owned timeline instead of rebuilding it at AUTO completion',()=>{
    const project=projectBase();
    project.timeline=[{id:'human-cut',shotId:'a',renderOutputId:'human-output',track:3,order:7,trimInSec:1.25,trimOutSec:2.75,volume:.42,approval:'human-override',approvalReason:'Director cut'}];
    const before=structuredClone(project.timeline);
    expect(buildAutomationTimelineIfEmpty(project)).toBe(false);
    expect(project.timeline).toEqual(before);
  });

  it('uses a supported Wan 2.2 5B landscape default instead of 1280x720',()=>{
    expect(MODEL_DEFAULTS['wan-2.2-5b']).toMatchObject({width:1280,height:704});
  });

  it('topologically schedules dependencies even when storyboard indices point the other way',()=>{
    const project=projectBase();
    project.shots[0].index=3;project.shots[1].index=1;project.shots[2].index=2;
    project.shotDependencies=[
      {id:'ab',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'},
      {id:'bc',fromShotId:'b',toShotId:'c',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}
    ];
    expect(productionShotOrder(project).map(item=>item.id)).toEqual(['a','b','c']);
  });

  it('blocks a partial AUTO RUN only for unresolved hard upstream dependencies',()=>{
    const project=projectBase();
    project.shotDependencies=[{id:'ab',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'hard',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}];
    expect(()=>assertExternalDependenciesReady(project,new Set(['b']))).toThrow(/unresolved upstream dependencies/i);
    expect(()=>assertExternalDependenciesReady(project,new Set(['a','b']))).not.toThrow();
    project.shotDependencies[0].strength='soft';
    expect(()=>assertExternalDependenciesReady(project,new Set(['b']))).not.toThrow();
  });

  it('rejects cyclic dependency graphs during portable-project validation',()=>{
    const project=projectBase() as any;
    project.shotDependencies=[
      {id:'ab',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'},
      {id:'ba',fromShotId:'b',toShotId:'a',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}
    ];
    expect(()=>loadPortableProject(project,'/tmp/next-five')).toThrow(/dependency graph contains a cycle/i);
  });

  it('clears a legacy start-frame link when it came from an unreviewed propagated state',()=>{
    const project=projectBase() as any;
    project.assets=[{id:'frame',kind:'keyframe',name:'Frame',sourcePath:'frame.jpg',projectPath:'assets/keyframe/frame.jpg',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}];
    project.shots[1].startFrameAssetId='frame';
    project.shots[1].actualStartStateId='start-b';
    project.shots[1].latestRenderId=undefined;
    project.shots[1].canonicalRenderId=undefined;
    project.shotStates=[{id:'start-b',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',frameAssetId:'frame',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:00.000Z'}];
    const loaded=loadPortableProject(project,'/tmp/next-five').project;
    expect(loaded.shots.find(item=>item.id==='b')?.startFrameAssetId).toBeUndefined();
    expect(loaded.shots.find(item=>item.id==='b')?.actualStartStateId).toBeUndefined();
    expect(loaded.shotStates.find(item=>item.id==='start-b')?.status).toBe('stale');
  });
});


describe('P1 production policy hardening',()=>{
  const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:false};
  const makeShot=(id:string,index:number):Shot=>({id,sceneId:'scene',index,title:id,prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation,seed:index}});
  const makeProject=():FilmProject=>({
    schemaVersion:3,id:'p1-policy',name:'P1 Policy',rootPath:'/tmp/p1-policy',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
    story:{title:'P1 Policy',logline:'',script:'',notes:''},
    scenes:[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b','c']}],
    assets:[],shots:[makeShot('a',3),makeShot('b',1),makeShot('c',2)],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
    settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
  });

  it('uses hard dependencies as blockers while soft dependencies remain ordering hints',()=>{
    const project=makeProject();
    project.shotDependencies=[
      {id:'soft-ab',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'soft',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'},
      {id:'hard-bc',fromShotId:'b',toShotId:'c',relation:'temporal',strength:'hard',propagate:[],createdAt:'2026-01-01T00:00:00.000Z'}
    ];
    expect(productionShotOrder(project).map(shot=>shot.id)).toEqual(['a','b','c']);
    expect(()=>assertExternalDependenciesReady(project,new Set(['c']))).toThrow(/b → c/i);
    expect(()=>assertExternalDependenciesReady(project,new Set(['b']))).not.toThrow();
  });

  it('requires camera continuity to be explicit rather than part of the default contract',()=>{
    expect(DEFAULT_CONTINUITY_FIELDS).not.toContain('camera');
    expect(DEFAULT_CONTINUITY_FIELDS).toEqual(expect.arrayContaining(['character','wardrobe','prop','location','lighting','action','dialogue']));
  });

  it('creates a separate continuity review requirement for every missing upstream frame',async()=>{
    const project=makeProject(),shot=project.shots.find(item=>item.id==='c')!;
    const e1={id:'a-c',fromShotId:'a',toShotId:'c',relation:'continuity' as const,strength:'soft' as const,propagate:['character' as const],createdAt:'2026-01-01T00:00:00.000Z'};
    const e2={id:'b-c',fromShotId:'b',toShotId:'c',relation:'continuity' as const,strength:'hard' as const,propagate:['prop' as const],createdAt:'2026-01-01T00:00:00.000Z'};
    project.shotDependencies=[e1,e2];
    const result=await evaluateContinuityQc({} as AppMachineSettings,project,shot,[{edge:e1},{edge:e2}],'/tmp/current-first.jpg');
    expect(result.status).toBe('human-verify');
    expect(result.issues.filter(issue=>issue.code==='CONTINUITY_UPSTREAM_FRAME_MISSING')).toHaveLength(2);
    expect(result.issues.map(issue=>issue.message).join(' ')).toMatch(/a/);
    expect(result.issues.map(issue=>issue.message).join(' ')).toMatch(/b/);
  });

  it('allows bounded seed rerolls only for visual QC, not semantic or continuity failures',()=>{
    const issue={code:'QC',severity:'major' as const,message:'Mismatch'};
    expect(qcFailureAutoRetryDecision({layer:'visual',issues:[issue]}).action).toBe('retry');
    expect(qcFailureAutoRetryDecision({layer:'semantic',issues:[issue]}).action).toBe('human');
    expect(qcFailureAutoRetryDecision({layer:'continuity',issues:[issue]}).action).toBe('human');
  });

  it('retries only recognized transient backend failures and stops deterministic repeats',()=>{
    expect(renderFailureAutoRetryDecision({status:'failed',error:'connection reset by local backend',message:'Failed'} as any).action).toBe('retry');
    expect(renderFailureAutoRetryDecision({status:'orphaned',error:'process disappeared after restart',message:'Recovery failed'} as any).action).toBe('retry');
    expect(renderFailureAutoRetryDecision({status:'failed',error:'CUDA out of memory',message:'Failed'} as any).action).toBe('human');
    expect(renderFailureAutoRetryDecision({status:'failed',error:'Invalid node class_type Foo',message:'Failed'} as any).action).toBe('human');
    expect(renderFailureAutoRetryDecision({status:'failed',error:'mysterious deterministic crash',message:'Failed'} as any).action).toBe('human');
  });
});


describe('state provenance next-five hardening',()=>{
  const generation={modelFamily:'ltx-2.5-fast' as const,mode:'i2v' as const,quality:'balanced' as const,width:768,height:432,frames:97,fps:24,steps:8,cfg:1,seed:11,negativePrompt:'',includeAudio:false};
  const shot=(id:string,index:number):Shot=>({
    id,sceneId:'scene',index,title:id,prompt:'base prompt',camera:'',action:'',dialogue:'',continuityNotes:'',
    characterAssetIds:[],propAssetIds:[],referenceAssetIds:[],status:'ready',generation:{...generation,seed:index+10}
  });
  const projectBase=():FilmProject=>({
    schemaVersion:3,id:'state-next-five',name:'State Next Five',rootPath:'/tmp/state-next-five',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',
    story:{title:'State Next Five',logline:'',script:'',notes:''},
    scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['a','b','c']}],
    assets:[],shots:[shot('a',1),shot('b',2),shot('c',3)],renderJobs:[],renderOutputs:[],timeline:[],shotStates:[],shotDependencies:[],qcResults:[],humanTasks:[],cutRevisions:[],
    settings:{costPolicy:{mode:'codex-capcut-only',allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
  });

  it('excludes unreviewed states from render prompts, keyframe prompts and generation signatures',()=>{
    const project=projectBase(),target=project.shots[1];
    target.actualStartStateId='unreviewed-start';
    project.shotStates.push({
      id:'unreviewed-start',shotId:'b',role:'actual-start',source:'generated',status:'unreviewed',
      characters:[],props:[],environment:{notes:'UNTRUSTED_STATE_MARKER'},camera:{},actionPhase:'untrusted action',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'
    });
    const firstSignature=shotProjectRenderInputKey(project,target);
    expect(buildRenderPrompt(project,target)).not.toContain('UNTRUSTED_STATE_MARKER');
    expect(keyframePrompt(project,target,'start')).not.toContain('UNTRUSTED_STATE_MARKER');
    project.shotStates[0].environment.notes='UNTRUSTED_STATE_CHANGED';
    expect(shotProjectRenderInputKey(project,target)).toBe(firstSignature);
    project.shotStates[0].status='current';
    expect(buildRenderPrompt(project,target)).toContain('UNTRUSTED_STATE_CHANGED');
    expect(keyframePrompt(project,target,'start')).toContain('UNTRUSTED_STATE_CHANGED');
    expect(shotProjectRenderInputKey(project,target)).not.toBe(firstSignature);
  });

  it('requires current continuity QC before observed final state can become propagation truth',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-observed-continuity-gate-'));
    const service=new ProjectService();
    try{
      await service.createAt(root,'Continuity gate');
      await service.mutate(project=>{
        project.scenes=[{id:'scene',index:1,heading:'',body:'',shotIds:['a','b']}];
        const a=shot('a',1),b=shot('b',2);project.shots=[a,b];
        project.shotDependencies=[{id:'a-b',fromShotId:'a',toShotId:'b',relation:'continuity',strength:'hard',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'}];
        const output:RenderOutput={id:'out-b',jobId:'orphaned',shotId:'b',path:join(root,'renders','b.mp4'),filename:'b.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:01.000Z',technicalQc:{checkedAt:'2026-01-01T00:00:01.000Z',passed:true,issues:[],warnings:[]}};
        output.productionInputKey=shotProductionInputKey(project,b);project.renderOutputs.push(output);
      });
      for(const layer of ['visual','semantic'] as const){
        const project=service.getCurrent()!,target=project.shots.find(item=>item.id==='b')!;
        await recordShotQc(service,{projectRoot:root,shotId:'b',renderOutputId:'out-b',layer,status:'pass',issues:[],inputKey:shotQcInputKey(project,target.id,'out-b',layer)});
      }
      await expect(recordObservedFinalState(service,{projectRoot:root,shotId:'b',renderOutputId:'out-b',characters:[],props:[],environment:{},camera:{},actionPhase:'done',dialogueState:'unknown',confidence:.9})).rejects.toThrow(/continuity QC PASS/i);
      {
        const project=service.getCurrent()!,target=project.shots.find(item=>item.id==='b')!;
        await recordShotQc(service,{projectRoot:root,shotId:'b',renderOutputId:'out-b',layer:'continuity',status:'pass',issues:[],inputKey:shotQcInputKey(project,target.id,'out-b','continuity')});
      }
      const updated=await recordObservedFinalState(service,{projectRoot:root,shotId:'b',renderOutputId:'out-b',characters:[],props:[],environment:{},camera:{},actionPhase:'done',dialogueState:'unknown',confidence:.9});
      expect(updated.shots.find(item=>item.id==='b')?.observedFinalStateId).toBeTruthy();
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('does not silently choose one predecessor when multiple continuity sources converge',()=>{
    const project=projectBase();
    project.shotDependencies=[
      {id:'a-c',fromShotId:'a',toShotId:'c',relation:'continuity',strength:'hard',propagate:['character'],createdAt:'2026-01-01T00:00:00.000Z'},
      {id:'b-c',fromShotId:'b',toShotId:'c',relation:'continuity',strength:'soft',propagate:['prop'],createdAt:'2026-01-01T00:00:00.000Z'}
    ];
    for(const id of ['a','b']){
      const source=project.shots.find(item=>item.id===id)!;source.observedFinalStateId=`final-${id}`;
      project.shotStates.push({id:`final-${id}`,shotId:id,role:'observed-final',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'done',dialogueState:'',createdAt:'2026-01-01T00:00:01.000Z'});
    }
    expect(requiresHumanContinuityMerge(project,'c')).toBe(true);
    expect(propagateObservedFinalState(project,'a')).toEqual([]);
    expect(propagateObservedFinalState(project,'b')).toEqual([]);
    expect(project.shots.find(item=>item.id==='c')?.actualStartStateId).toBeUndefined();

    project.shots[2].actualStartStateId='generated-c';
    project.shotStates.push({id:'generated-c',shotId:'c',role:'actual-start',source:'generated',status:'current',characters:[],props:[],environment:{},camera:{},actionPhase:'',dialogueState:'',createdAt:'2026-01-01T00:00:02.000Z'});
    propagateObservedFinalState(project,'a');
    expect(project.shotStates.find(item=>item.id==='generated-c')?.status).toBe('stale');
    expect(project.shots[2].actualStartStateId).toBeUndefined();
  });

  it('dismisses stale automation blockers while preserving blockers that still match current provenance',()=>{
    const project=projectBase(),target=project.shots[1];
    const output:RenderOutput={id:'old-output',jobId:'orphaned',shotId:'b',path:'/tmp/state-next-five/old.mp4',filename:'old.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:01.000Z',productionInputKey:'stale-input',technicalQc:{checkedAt:'2026-01-01T00:00:01.000Z',passed:true,issues:[],warnings:[]}};
    project.renderOutputs.push(output);
    const staleTask={id:'task-stale',type:'manual-qc' as const,status:'open' as const,shotId:'b',title:'Semantic QC needs corrective review',reason:'old',relatedAssetIds:[],relatedRenderOutputIds:['old-output'],createdAt:'2026-01-01T00:00:02.000Z'};
    expect(automationTaskDisposition(project,target,staleTask)).toBe('dismissed');
    const workflowTask={...staleTask,id:'task-workflow',type:'route-unsupported' as const,title:'Workflow input mismatch',relatedRenderOutputIds:[]};
    expect(automationTaskDisposition(project,target,workflowTask)).toBe('dismissed');

    target.startFrameAssetId='human-start';
    const keyframeTask={...staleTask,id:'task-frame',type:'verify-keyframe' as const,title:'Start keyframe required',relatedRenderOutputIds:[]};
    expect(automationTaskDisposition(project,target,keyframeTask)).toBe('resolved');
  });

  it('binds low-confidence observed-state approval to the exact extracted draft',()=>{
    const first={characters:[],props:[],environment:{lighting:'warm'},camera:{},actionPhase:'door open',dialogueState:'unknown',confidence:.45};
    const second={...first,actionPhase:'door closed'};
    expect(observedStateDraftFingerprint(first)).not.toBe(observedStateDraftFingerprint(second));
    const firstTitle=observedStateReviewTitle('Shot B',first),secondTitle=observedStateReviewTitle('Shot B',second);
    const task={shotId:'b',type:'manual-qc' as const,title:firstTitle,status:'resolved' as const,relatedRenderOutputIds:['out-b'],resolution:`${OBSERVED_STATE_APPROVAL_PREFIX} human checked draft`};
    expect(isApprovedObservedStateReview(task,'b',firstTitle,'out-b')).toBe(true);
    expect(isApprovedObservedStateReview(task,'b',secondTitle,'out-b')).toBe(false);
  });
});
