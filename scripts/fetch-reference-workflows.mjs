#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'resources', 'workflows', 'reference');
const force = process.argv.includes('--force');

const sources = [
  {
    id: 'ltx-2.5-single-stage-distilled',
    family: 'ltx-2.5-fast',
    role: 'video',
    recommendedFor: 'RTX 5060 Ti 16 GB: first choice for previews and most I2V/T2V shots',
    url: 'https://raw.githubusercontent.com/Lightricks/ComfyUI-LTXVideo/master/example_workflows/2.5/LTX-2.5_T2V_I2V_Single_Stage_Distilled.json'
  },
  {
    id: 'ltx-2.5-two-stage-distilled',
    family: 'ltx-2.5-fast',
    role: 'video',
    recommendedFor: 'Higher-quality LTX render when system RAM/offload headroom is available',
    url: 'https://raw.githubusercontent.com/Lightricks/ComfyUI-LTXVideo/master/example_workflows/2.5/LTX-2.5_T2V_I2V_Two_Stage_Distilled.json'
  },
  {
    id: 'hunyuan-video-1.5-720p-i2v',
    family: 'hunyuan-video-1.5',
    role: 'video',
    recommendedFor: 'Hero/image-to-video shots',
    url: 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_hunyuan_video_1.5_720p_i2v.json'
  },
  {
    id: 'hunyuan-video-1.5-720p-t2v',
    family: 'hunyuan-video-1.5',
    role: 'video',
    recommendedFor: 'Hero text-to-video shots',
    url: 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_hunyuan_video_1.5_720p_t2v.json'
  },
  {
    id: 'wan-2.2-5b-ti2v',
    family: 'wan-2.2-5b',
    role: 'video',
    recommendedFor: 'Motion/action TI2V on 16 GB VRAM',
    url: 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/video_wan2_2_5B_ti2v.json'
  }
];

await mkdir(outDir, { recursive: true });
const manifest = {
  generatedAt: new Date().toISOString(),
  note: 'These files are setup-time references. CineForge runtime does not fetch cloud resources.',
  files: []
};

async function exists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

for (const source of sources) {
  const filename = `${source.id}.json`;
  const path = join(outDir, filename);
  if (!force && await exists(path)) {
    const bytes = await readFile(path);
    manifest.files.push({ ...source, filename, sha256: createHash('sha256').update(bytes).digest('hex'), reused: true });
    console.log(`reuse ${filename}`);
    continue;
  }

  console.log(`fetch ${source.url}`);
  const response = await fetch(source.url, {
    redirect: 'follow',
    headers: { 'user-agent': 'CineForge-Local workflow bootstrap' },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`Failed ${source.id}: HTTP ${response.status} ${response.statusText}`);
  const text = await response.text();
  // Fail early if an upstream URL starts returning HTML or an error page.
  try { JSON.parse(text); } catch (error) { throw new Error(`${source.id} did not return valid JSON: ${error.message}`); }
  await writeFile(path, text, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  manifest.files.push({ ...source, filename, sha256, reused: false });
  console.log(`saved ${filename}  sha256=${sha256.slice(0, 16)}…`);
}

await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\nReference workflows: ${outDir}`);
console.log('Load them in ComfyUI, install any missing nodes/models, then export API format before production use.');
