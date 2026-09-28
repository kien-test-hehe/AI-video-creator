import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export const MAX_WORKFLOW_JSON_BYTES=64*1024*1024;
export class FileSafetyLimitError extends Error{constructor(message:string){super(message);this.name='FileSafetyLimitError';}}

export async function readFileBufferLimited(
  path:string,
  label='file',
  maxBytes=MAX_WORKFLOW_JSON_BYTES
):Promise<Buffer>{
  const info=await stat(path);
  if(!info.isFile())throw new Error(`${label} is not a regular file: ${path}`);
  if(info.size>maxBytes)throw new FileSafetyLimitError(`${label} is too large (${info.size} bytes; limit ${maxBytes} bytes).`);

  const chunks:Buffer[]=[];let total=0;
  for await(const chunk of createReadStream(path,{highWaterMark:64*1024})){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    total+=bytes.length;
    if(total>maxBytes)throw new FileSafetyLimitError(`${label} grew beyond the ${maxBytes}-byte safety limit while being read.`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks,total);
}

export async function readJsonFileLimited<T=unknown>(
  path:string,
  label='JSON file',
  maxBytes=MAX_WORKFLOW_JSON_BYTES
):Promise<T>{
  const raw=(await readFileBufferLimited(path,label,maxBytes)).toString('utf8');
  try{return JSON.parse(raw) as T;}
  catch(error){throw new Error(`${label} is not valid JSON: ${error instanceof Error?error.message:String(error)}`);}
}
