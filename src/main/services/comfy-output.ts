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
  const stack:unknown[]=[value];let visited=0;
  while(stack.length){
    if(++visited>200_000)throw new Error('ComfyUI output graph exceeds the traversal safety limit.');
    const current=stack.pop();
    if(Array.isArray(current)){for(let i=current.length-1;i>=0;i--)stack.push(current[i]);continue;}
    if(!current||typeof current!=='object')continue;
    const obj=current as Record<string,unknown>;
    if(typeof obj.filename==='string'){
      const type=typeof obj.type==='string'?obj.type:'output';
      if(type!=='input')out.push({filename:obj.filename,subfolder:typeof obj.subfolder==='string'?obj.subfolder:undefined,type});
    }
    for(const child of Object.values(obj))stack.push(child);
  }
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
