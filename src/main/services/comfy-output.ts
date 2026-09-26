import { extname } from 'node:path';
import type { RenderOutput } from '../../shared/types';
import type { ComfyFileRef } from './comfy-client';

export function inferMediaType(filename: string): RenderOutput['mediaType'] {
  const ext = extname(filename).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext)) return 'video';
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.wav', '.mp3', '.flac', '.m4a', '.ogg'].includes(ext)) return 'audio';
  return 'unknown';
}

export function collectComfyFileRefs(value: unknown, out: ComfyFileRef[] = []): ComfyFileRef[] {
  if (Array.isArray(value)) {
    for (const item of value) collectComfyFileRefs(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const obj = value as Record<string, unknown>;
  if (typeof obj.filename === 'string') {
    out.push({ filename: obj.filename, subfolder: typeof obj.subfolder === 'string' ? obj.subfolder : undefined, type: typeof obj.type === 'string' ? obj.type : 'output' });
  }
  for (const child of Object.values(obj)) collectComfyFileRefs(child, out);
  return out;
}

export function uniqueComfyFileRefs(refs: ComfyFileRef[]): ComfyFileRef[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.type}|${ref.subfolder}|${ref.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export function collectComfyHistoryOutputRefs(history:unknown):ComfyFileRef[]{
  const outputs=history&&typeof history==='object'&&!Array.isArray(history)?(history as Record<string,unknown>).outputs:undefined;
  return uniqueComfyFileRefs(collectComfyFileRefs(outputs));
}
