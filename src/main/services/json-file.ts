import { readFile, stat } from 'node:fs/promises';

export const MAX_WORKFLOW_JSON_BYTES=64*1024*1024;

export async function readJsonFileLimited<T=unknown>(
  path:string,
  label='JSON file',
  maxBytes=MAX_WORKFLOW_JSON_BYTES
):Promise<T>{
  const info=await stat(path);
  if(!info.isFile())throw new Error(`${label} is not a regular file: ${path}`);
  if(info.size>maxBytes)throw new Error(`${label} is too large (${info.size} bytes; limit ${maxBytes} bytes).`);
  const raw=await readFile(path,'utf8');
  try{return JSON.parse(raw) as T;}
  catch(error){throw new Error(`${label} is not valid JSON: ${error instanceof Error?error.message:String(error)}`);}
}
