import assert from 'node:assert/strict';
import { parseScreenplay } from '../src/main/services/script-parser.ts';
import { applyBindings, uiWorkflowToApi, type ApiWorkflow } from '../src/main/services/workflow-engine.ts';
import { assertLocalUrl } from '../src/main/services/local-url.ts';
import { assertPathInside, assertRelativeProjectPath } from '../src/main/services/path-safety.ts';
import { chooseModelForShot } from '../src/shared/routing.ts';

const scenes = parseScreenplay('INT. GARAGE - NIGHT\nA car waits.\nEXT. ROAD - DAWN\nIt launches.');
assert.equal(scenes.length, 2);
assert.equal(scenes[0].location, 'GARAGE');

const api: ApiWorkflow = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'old' } } };
const bound = applyBindings(api, [{ key: 'prompt', selector: { nodeId: '1' }, input: 'text', required: true }], {
  prompt: 'new', negativePrompt: '', width: 768, height: 432, frames: 97, fps: 24, seed: 1, filenamePrefix: 'test'
});
assert.equal(bound['1'].inputs.text, 'new');
assert.equal(api['1'].inputs.text, 'old');

const converted = uiWorkflowToApi({ nodes: [
  { id: 1, type: 'PrimitiveNode', mode: 0, inputs: [], widgets_values: [7] },
  { id: 2, type: 'Consumer', mode: 0, inputs: [{ name: 'value', link: 3 }], widgets_values: [] }
], links: [[3, 1, 0, 2, 0, 'INT']] }, {
  PrimitiveNode: { input: { required: { value: ['INT', {}] } } },
  Consumer: { input: { required: { value: ['INT', { forceInput: true }] } } }
});
assert.deepEqual(converted.workflow['2'].inputs.value, ['1', 0]);
assert.equal(converted.requiresApiExport, false);
const unsafeSubgraph = uiWorkflowToApi({ nodes: [{
  id: 10, type: '792f0fd8-129e-48eb-9904-8d1aa82154d1', mode: 0,
  inputs: [{ name: 'image', link: 7 }], outputs: [{ name: 'latent', links: [8] }], widgets_values: []
}], links: [] }, {});
assert.equal(unsafeSubgraph.requiresApiExport, true);
assert.throws(() => assertLocalUrl('https://example.com'));

const baseGeneration = {
  modelFamily: 'ltx-2.5-fast' as const,
  mode: 'i2v' as const,
  width: 1280, height: 720, frames: 121, fps: 24,
  steps: 8, cfg: 1, seed: 42,
  quality: 'balanced' as const,
  includeAudio: false,
  negativePrompt: ''
};
assert.equal(chooseModelForShot({ dialogue: 'Hello', camera: 'locked', action: '', generation: baseGeneration }), 'ltx-2.5-fast');
assert.equal(chooseModelForShot({ dialogue: '', camera: 'locked', action: '', generation: { ...baseGeneration, quality: 'hero' } }), 'hunyuan-video-1.5');
assert.equal(chooseModelForShot({ dialogue: '', camera: 'fast orbit', action: 'car chase', generation: baseGeneration }), 'wan-2.2-5b');
assert.equal(chooseModelForShot({ dialogue: 'still long', camera: 'locked', action: '', generation: { ...baseGeneration, frames: 265 } }), 'ltx-2.5-fast');

const root = '/tmp/cineforge-project';
assert.equal(assertPathInside(root, `${root}/assets/a.png`), `${root}/assets/a.png`);
assert.throws(() => assertPathInside(root, '/tmp/outside/a.png'));
assert.throws(() => assertRelativeProjectPath(root, '../outside/a.png', 'assets', 'asset'));

const continuityWorkflow: ApiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'old.png' } }
};
const continuityBound = applyBindings(continuityWorkflow, [
  { key: 'characterImage1', selector: { nodeId: '1' }, input: 'image', required: true }
], {
  prompt: 'shot', negativePrompt: '', width: 1280, height: 720, frames: 121, fps: 24, seed: 1,
  characterImage1: 'cineforge/character.png', filenamePrefix: 'test'
});
assert.equal(continuityBound['1'].inputs.image, 'cineforge/character.png');
assert.equal(continuityWorkflow['1'].inputs.image, 'old.png');
console.log('core smoke: OK');

const { suggestWanGpBindings } = await import('../src/main/services/wangp-engine.ts');
const wanBindings = suggestWanGpBindings({ prompt: 'old', generation: { seed: 1, num_frames: 81 }, inputs: { start_image: 'a.png' } });
assert.equal(wanBindings.find(b => b.key === 'prompt')?.jsonPath, 'prompt');
assert.equal(wanBindings.find(b => b.key === 'frames')?.jsonPath, 'generation.num_frames');
assert.equal(wanBindings.find(b => b.key === 'startImage')?.jsonPath, 'inputs.start_image');
console.log('WanGP binding smoke: OK');

const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
const { join: joinPath } = await import('node:path');
const { tmpdir } = await import('node:os');
const { compileWanGpProfile } = await import('../src/main/services/wangp-engine.ts');
const tempRoot = await mkdtemp(joinPath(tmpdir(), 'cineforge-smoke-'));
try {
  await mkdir(joinPath(tempRoot, 'workflows'), { recursive: true });
  const settingsPath = joinPath(tempRoot, 'workflows', 'wan.json');
  await writeFile(settingsPath, JSON.stringify({ prompt: 'old', generation: { seed: 1 } }), 'utf8');
  const compiledWan = await compileWanGpProfile({
    id: 'p', runtime: 'wangp', purpose: 'video', name: 'smoke', modelFamily: 'ltx-2.5-fast', mode: 'i2v',
    workflowPath: settingsPath, workflowFormat: 'wangp-settings', enabled: true,
    bindings: [{ key: 'prompt', jsonPath: 'prompt', required: true }, { key: 'seed', jsonPath: 'generation.seed', transform: 'integer', required: true }]
  }, { prompt: 'new prompt', negativePrompt: '', width: 768, height: 432, frames: 121, fps: 24, seed: 99, filenamePrefix: 'smoke' });
  assert.equal(compiledWan.prompt, 'new prompt');
  assert.equal((compiledWan.generation as any).seed, 99);
  console.log('WanGP compile smoke: OK');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
