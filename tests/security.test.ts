import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPortableProject } from '../src/main/services/project-schema';
import { assertExistingPathInside, assertExistingProjectMediaPath, assertSafeWritePath, ensureSafeDirectory } from '../src/main/services/path-safety';
import { analyzeWanGpBindings } from '../src/main/services/wangp-engine';
import { profileCompatibilityErrors } from '../src/main/services/profile-validation';
import { isTrustedRendererNavigation, resolveTrustedRendererUrl } from '../src/main/services/ipc-security';
import type { WorkflowProfile } from '../src/shared/types';
import { stageWorkflowProfileSnapshot } from '../src/main/services/workflow-snapshot';
import { sha256File } from '../src/main/services/runtime-fingerprint';
import { JobJournal } from '../src/main/services/job-journal';
import { randomBytes } from 'node:crypto';
import { AppSettingsService } from '../src/main/services/app-settings-service';

describe('machine settings trust boundary',()=>{
  it('rejects symlinked machine settings and journal signing keys',async()=>{
    if(process.platform==='win32')return;
    const root=await mkdtemp(join(tmpdir(),'cineforge-settings-symlink-')),outside=await mkdtemp(join(tmpdir(),'cineforge-settings-outside-'));
    try{
      const settingsTarget=join(outside,'settings.json'),keyTarget=join(outside,'key.txt');
      await writeFile(settingsTarget,JSON.stringify({schemaVersion:1}),'utf8');
      await writeFile(keyTarget,'a'.repeat(64),'utf8');
      await symlink(keyTarget,join(root,'journal-hmac.key'));
      await expect(new AppSettingsService(root).load()).rejects.toThrow(/symbolic link/i);
      await rm(join(root,'journal-hmac.key'),{force:true});
      await writeFile(join(root,'journal-hmac.key'),'b'.repeat(64),'utf8');
      await symlink(settingsTarget,join(root,'machine-settings.v1.json'));
      await expect(new AppSettingsService(root).load()).rejects.toThrow(/symbolic link/i);
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});

describe('portable project trust boundary',()=>{
  it('migrates v1 but discards executable paths and external endpoint settings',()=>{
    const root='/safe/project';
    const loaded=loadPortableProject({
      schemaVersion:1,id:'p1',name:'Legacy',rootPath:'/attacker',
      story:{title:'Legacy',logline:'',script:'',notes:''},scenes:[],assets:[],shots:[],renderJobs:[],renderOutputs:[],timeline:[],
      settings:{
        ffmpegPath:'/tmp/evil',comfyUrl:'https://attacker.invalid',localOnly:false,
        director:{baseUrl:'https://attacker.invalid/v1',model:'evil'},
        wangp:{pythonPath:'/tmp/evil-python',rootPath:'/tmp/evil'},
        costPolicy:{allowCapcutAiCredits:false},capcut:{enabled:true,pro:true},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]
      }
    },root);
    expect(loaded.project.schemaVersion).toBe(2);
    expect(loaded.project.rootPath).toBe(root);
    expect((loaded.project.settings as any).ffmpegPath).toBeUndefined();
    expect((loaded.project.settings as any).comfyUrl).toBeUndefined();
    expect((loaded.project.settings as any).director).toBeUndefined();
    expect((loaded.project.settings as any).wangp).toBeUndefined();
    expect(loaded.migrationNotes.join(' ')).toMatch(/discarded executable paths/i);
  });

  it('preserves dedicated generic visual references while filtering unknown ids',()=>{
    const root='/safe/project';
    const loaded=loadPortableProject({
      schemaVersion:2,id:'p2',name:'Refs',rootPath:'/attacker',
      story:{title:'Refs',logline:'',script:'',notes:''},
      scenes:[{id:'scene',index:1,heading:'INT. ROOM - DAY',body:'',shotIds:['shot']}],
      assets:[
        {id:'ref1',kind:'reference',name:'Look',sourcePath:'look.png',projectPath:'assets/reference/look.png',tags:[],notes:'palette',createdAt:'2026-01-01T00:00:00.000Z'},
        {id:'prop1',kind:'prop',name:'Cup',sourcePath:'cup.png',projectPath:'assets/prop/cup.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}
      ],
      shots:[{id:'shot',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:['prop1'],referenceAssetIds:['ref1','missing'],status:'draft',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}}],
      renderJobs:[],renderOutputs:[],timeline:[],
      settings:{costPolicy:{allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    },root);
    expect(loaded.project.shots[0].referenceAssetIds).toEqual(['ref1']);
    expect(loaded.project.shots[0].propAssetIds).toEqual(['prop1']);
  });

  it('migrates legacy reference-in-prop data and filters role-kind mismatches',()=>{
    const root='/safe/project';
    const loaded=loadPortableProject({
      schemaVersion:2,id:'p3',name:'Roles',rootPath:'/attacker',
      story:{title:'Roles',logline:'',script:'',notes:''},
      scenes:[{id:'scene',index:1,heading:'EXT. STREET - DAY',body:'',shotIds:['shot']}],
      assets:[
        {id:'char',kind:'character',name:'Hero',sourcePath:'char.png',projectPath:'assets/character/char.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'},
        {id:'loc',kind:'location',name:'Street',sourcePath:'loc.png',projectPath:'assets/location/loc.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'},
        {id:'look',kind:'reference',name:'Look',sourcePath:'look.png',projectPath:'assets/reference/look.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'},
        {id:'coat',kind:'wardrobe',name:'Coat',sourcePath:'coat.png',projectPath:'assets/wardrobe/coat.png',tags:[],notes:'',createdAt:'2026-01-01T00:00:00.000Z'}
      ],
      shots:[{id:'shot',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:['loc','char'],locationAssetId:'char',propAssetIds:['look','coat'],status:'draft',generation:{modelFamily:'ltx-2.5-fast',mode:'i2v',quality:'balanced',width:1280,height:704,frames:121,fps:24,steps:8,cfg:1,seed:1,negativePrompt:'',includeAudio:true}}],
      renderJobs:[],renderOutputs:[],timeline:[],
      settings:{costPolicy:{allowCapcutAiCredits:false},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    },root);
    const shot=loaded.project.shots[0];
    expect(shot.characterAssetIds).toEqual(['char']);
    expect(shot.locationAssetId).toBeUndefined();
    expect(shot.propAssetIds).toEqual(['coat']);
    expect(shot.referenceAssetIds).toEqual(['look']);
  });

  it('never coerces truthy strings into trusted boolean project state',()=>{
    const loaded=loadPortableProject({
      schemaVersion:2,id:'bools',name:'Booleans',story:{title:'B',logline:'',script:'',notes:''},
      scenes:[{id:'scene',index:1,heading:'INT. ROOM',body:'',shotIds:['shot']}],assets:[],
      shots:[{id:'shot',sceneId:'scene',index:1,title:'Shot',prompt:'',camera:'',action:'',dialogue:'',continuityNotes:'',characterAssetIds:[],propAssetIds:[],status:'rendered',generation:{modelFamily:'hunyuan-video-1.5',mode:'i2v',quality:'hero',width:832,height:480,frames:97,fps:24,steps:30,cfg:6,seed:1,negativePrompt:'',includeAudio:'true'},latestRenderId:'out'}],
      renderJobs:[{id:'job',shotId:'shot',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',status:'done',progress:1,message:'done',modelFamily:'hunyuan-video-1.5',outputs:[]}],
      renderOutputs:[{id:'out',jobId:'job',shotId:'shot',path:'/safe/project/renders/out.mp4',filename:'out.mp4',mediaType:'video',createdAt:'2026-01-01T00:00:00.000Z',technicalQc:{checkedAt:'2026-01-01T00:00:00.000Z',passed:'true',issues:[],warnings:[]}}],
      timeline:[],
      settings:{costPolicy:{allowCapcutAiCredits:'true'},capcut:{enabled:true,pro:false},defaultFps:24,outputContainer:'mp4',workflowProfiles:[{id:'wf',runtime:'wangp',purpose:'video',name:'WF',modelFamily:'hunyuan-video-1.5',mode:'i2v',workflowPath:'/safe/project/workflows/wf.json',workflowFormat:'wangp-settings',bindings:[{key:'prompt',jsonPath:'prompt',required:'true'}],enabled:'true'}]}
    },'/safe/project').project;
    expect(loaded.settings.costPolicy.allowCapcutAiCredits).toBe(false);
    const profile=loaded.settings.workflowProfiles.find(item=>item.id==='wf')!;
    expect(profile.enabled).toBe(false);expect(profile.bindings[0].required).toBe(false);
    expect(loaded.shots[0].generation.includeAudio).toBe(false);
    expect(loaded.renderOutputs[0].technicalQc?.passed).toBe(false);
  });

  it('rejects oversized or invalid semantic references at schema level',()=>{
    expect(()=>loadPortableProject({
      schemaVersion:2,id:'p',name:'x',story:{},scenes:[],assets:[],shots:[{id:'s',sceneId:'missing',generation:{}}],renderJobs:[],renderOutputs:[],timeline:[],
      settings:{costPolicy:{},capcut:{},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    },'/tmp/p')).toThrow(/unknown scene/i);
  });
});

describe('safe write target containment',()=>{
  it('rejects an existing symlink target even when its parent directory is safe',async()=>{
    if(process.platform==='win32')return;
    const root=await mkdtemp(join(tmpdir(),'cineforge-write-target-')),outside=await mkdtemp(join(tmpdir(),'cineforge-write-outside-'));
    try{
      const dir=join(root,'.cineforge');await mkdir(dir,{recursive:true});
      const external=join(outside,'context.json');await writeFile(external,'outside','utf8');
      const link=join(dir,'machine-context.json');await symlink(external,link);
      await expect(assertSafeWritePath(dir,link,'machine context')).rejects.toThrow(/symbolic-link target|symlink escape/i);
      expect(await readFile(external,'utf8')).toBe('outside');
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});

describe('managed directory containment',()=>{
  it('refuses a nested managed directory that resolves through a symlink outside its root',async()=>{
    if(process.platform==='win32')return;
    const root=await mkdtemp(join(tmpdir(),'cineforge-safe-dir-')),outside=await mkdtemp(join(tmpdir(),'cineforge-safe-dir-outside-'));
    try{
      const cache=join(root,'cache');await mkdir(cache,{recursive:true});
      await symlink(outside,join(cache,'job'),'dir');
      await expect(ensureSafeDirectory(cache,join(cache,'job','nested'),'render cache directory')).rejects.toThrow(/symlink escape|outside/i);
      await expect(import('node:fs/promises').then(fs=>fs.stat(join(outside,'nested')))).rejects.toThrow();
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});

describe('canonical filesystem containment',()=>{
  it('blocks a symlink that lexically lives inside the project but resolves outside',async()=>{
    if(process.platform==='win32')return; // Windows hosted runners require privileges that are not guaranteed.
    const root=await mkdtemp(join(tmpdir(),'cineforge-security-'));
    const inside=join(root,'assets');await mkdir(inside);
    const outside=await mkdtemp(join(tmpdir(),'cineforge-outside-'));
    const secret=join(outside,'secret.txt');await writeFile(secret,'secret');
    const link=join(inside,'linked.txt');await symlink(secret,link);
    await expect(assertExistingPathInside(inside,link,'asset')).rejects.toThrow(/symlink escape/i);
  });
});


describe('signed journal filesystem boundary',()=>{
  it('refuses to write through a symlinked .cineforge directory',async()=>{
    if(process.platform==='win32')return;
    const root=await mkdtemp(join(tmpdir(),'cineforge-journal-project-')),outside=await mkdtemp(join(tmpdir(),'cineforge-journal-outside-'));
    try{
      await symlink(outside,join(root,'.cineforge'),'dir');
      const journal=new JobJournal(randomBytes(32)),now=new Date().toISOString();
      await expect(journal.write(root,{id:'job-1',shotId:'shot-1',createdAt:now,updatedAt:now,status:'queued',progress:0,message:'Waiting',modelFamily:'ltx-2.5-fast',outputs:[]})).rejects.toThrow(/outside|symlink/i);
      await expect(import('node:fs/promises').then(fs=>fs.stat(join(outside,'jobs','job-1.json')))).rejects.toThrow();
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});

describe('signed journal file boundary',()=>{
  it('refuses to treat a symlinked journal file as a missing/invalid record',async()=>{
    if(process.platform==='win32')return;
    const root=await mkdtemp(join(tmpdir(),'cineforge-journal-file-project-')),outside=await mkdtemp(join(tmpdir(),'cineforge-journal-file-outside-'));
    try{
      const jobs=join(root,'.cineforge','jobs');await mkdir(jobs,{recursive:true});
      const external=join(outside,'job-1.json');await writeFile(external,'{}','utf8');
      await symlink(external,join(jobs,'job-1.json'));
      const journal=new JobJournal(randomBytes(32));
      await expect(journal.readAll(root,['job-1'])).rejects.toThrow(/symlink escape|outside/i);
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});

describe('signed journal recovery directory boundary',()=>{
  it('refuses to read signed journals through a symlinked jobs directory',async()=>{
    if(process.platform==='win32')return;
    const root=await mkdtemp(join(tmpdir(),'cineforge-journal-read-project-')),outside=await mkdtemp(join(tmpdir(),'cineforge-journal-read-outside-'));
    try{
      await mkdir(join(root,'.cineforge'),{recursive:true});await symlink(outside,join(root,'.cineforge','jobs'),'dir');
      const journal=new JobJournal(randomBytes(32));
      await expect(journal.readAll(root,['job-1'])).rejects.toThrow(/outside|symlink/i);
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});

describe('project media protocol scope',()=>{
  it('serves only files below assets/ or renders/ and blocks project internals',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-media-'));
    try{
      await mkdir(join(root,'assets'),{recursive:true});await mkdir(join(root,'renders'),{recursive:true});await mkdir(join(root,'.cineforge'),{recursive:true});
      await writeFile(join(root,'assets','a.png'),'a');await writeFile(join(root,'renders','r.mp4'),'r');await writeFile(join(root,'.cineforge','jobs.json'),'secret');await writeFile(join(root,'cineforge.project.json'),'{}');
      await expect(assertExistingProjectMediaPath(root,'assets/a.png')).resolves.toContain('a.png');
      await expect(assertExistingProjectMediaPath(root,'renders/r.mp4')).resolves.toContain('r.mp4');
      await expect(assertExistingProjectMediaPath(root,'.cineforge/jobs.json')).rejects.toThrow(/non-media/i);
      await expect(assertExistingProjectMediaPath(root,'cineforge.project.json')).rejects.toThrow(/non-media/i);
      await expect(assertExistingProjectMediaPath(root,'assets/../cineforge.project.json')).rejects.toThrow();
    }finally{await import('node:fs/promises').then(fs=>fs.rm(root,{recursive:true,force:true}));}
  });
});

describe('immutable workflow staging',()=>{
  it('copies the exact hashed workflow into project cache and rejects changed source bytes',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-workflow-snapshot-'));
    try{
      await mkdir(join(root,'workflows'),{recursive:true});const source=join(root,'workflows','wf.json');await writeFile(source,'{"prompt":"a"}','utf8');
      const expected=await sha256File(source),profile={id:'p',runtime:'wangp',purpose:'video',name:'WF',modelFamily:'ltx-2.5-fast',mode:'i2v',workflowPath:source,workflowFormat:'wangp-settings',bindings:[],enabled:true} as WorkflowProfile;
      const staged=await stageWorkflowProfileSnapshot(root,profile,expected,join(root,'cache','wf'));
      expect(staged.workflowPath).toContain(join('cache','wf'));expect(await sha256File(staged.workflowPath)).toBe(expected);
      await writeFile(source,'{"prompt":"changed"}','utf8');
      await expect(stageWorkflowProfileSnapshot(root,profile,expected,join(root,'cache','wf2'))).rejects.toThrow(/changed while staging/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});

describe('packaged renderer trust source',()=>{
  it('ignores environment renderer URLs in packaged builds and restricts dev URLs to loopback',()=>{
    const bundled='file:///app/out/renderer/index.html';
    expect(resolveTrustedRendererUrl(true,'https://attacker.invalid/app',bundled)).toBe(bundled);
    expect(resolveTrustedRendererUrl(false,'http://127.0.0.1:5173/',bundled)).toBe('http://127.0.0.1:5173/');
    expect(()=>resolveTrustedRendererUrl(false,'https://attacker.invalid/app',bundled)).toThrow(/loopback/i);
  });
});

describe('renderer content security policy',()=>{
  it('does not let renderer code connect directly to arbitrary loopback AI services',async()=>{
    const html=await readFile(join(process.cwd(),'src','renderer','index.html'),'utf8');
    const csp=html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1]||'';
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/127\.0\.0\.1|localhost|ws:\/\//i);
  });
});

describe('renderer navigation trust',()=>{
  it('accepts only the exact packaged renderer file in production mode',()=>{
    const expected='file:///C:/Program%20Files/CineForge/resources/app.asar/out/renderer/index.html';
    expect(isTrustedRendererNavigation(expected,expected)).toBe(true);
    expect(isTrustedRendererNavigation('file:///C:/Users/Public/out/renderer/index.html',expected)).toBe(false);
    expect(isTrustedRendererNavigation('https://example.com/',expected)).toBe(false);
  });

  it('allows only the configured dev-server origin in development mode',()=>{
    const expected='http://127.0.0.1:5173/';
    expect(isTrustedRendererNavigation('http://127.0.0.1:5173/src',expected)).toBe(true);
    expect(isTrustedRendererNavigation('http://localhost:5173/',expected)).toBe(false);
    expect(isTrustedRendererNavigation('http://127.0.0.1:9999/',expected)).toBe(false);
  });
});

describe('WanGP binding inference',()=>{
  it('does not guess when a key is ambiguous',()=>{
    const result=analyzeWanGpBindings({preview:{seed:1},generation:{seed:2},prompt:'hello'});
    expect(result.bindings.find(b=>b.key==='seed')).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/seed: ambiguous/i);
    expect(result.bindings.find(b=>b.key==='prompt')?.jsonPath).toBe('prompt');
  });
});

describe('profile compatibility',()=>{
  const profile:WorkflowProfile={id:'p',runtime:'wangp',purpose:'video',name:'Wan',modelFamily:'wan-2.2-5b',mode:'i2v',workflowPath:'/x',workflowFormat:'wangp-settings',bindings:[],enabled:true};
  it('rejects forced profiles for the wrong model family or mode',()=>{
    expect(profileCompatibilityErrors(profile,{generation:{modelFamily:'ltx-2.5-fast',mode:'i2v'}}).join(' ')).toMatch(/does not match shot model/i);
    expect(profileCompatibilityErrors(profile,{generation:{modelFamily:'wan-2.2-5b',mode:'t2v'}}).join(' ')).toMatch(/does not match shot mode/i);
  });
});
