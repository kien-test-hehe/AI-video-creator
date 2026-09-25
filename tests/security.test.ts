import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPortableProject } from '../src/main/services/project-schema';
import { assertExistingPathInside } from '../src/main/services/path-safety';
import { analyzeWanGpBindings } from '../src/main/services/wangp-engine';
import { profileCompatibilityErrors } from '../src/main/services/profile-validation';
import { isTrustedRendererNavigation } from '../src/main/services/ipc-security';
import type { WorkflowProfile } from '../src/shared/types';

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

  it('rejects oversized or invalid semantic references at schema level',()=>{
    expect(()=>loadPortableProject({
      schemaVersion:2,id:'p',name:'x',story:{},scenes:[],assets:[],shots:[{id:'s',sceneId:'missing',generation:{}}],renderJobs:[],renderOutputs:[],timeline:[],
      settings:{costPolicy:{},capcut:{},defaultFps:24,outputContainer:'mp4',workflowProfiles:[]}
    },'/tmp/p')).toThrow(/unknown scene/i);
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
