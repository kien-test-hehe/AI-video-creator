import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

export async function killProcessTree(pid:number):Promise<void>{
  if(!Number.isInteger(pid)||pid<=0)return;
  if(process.platform==='win32'){
    await execFileAsync('taskkill',['/PID',String(pid),'/T','/F'],{timeout:10_000}).catch(()=>undefined);
    return;
  }
  try{process.kill(-pid,'SIGTERM');}catch{try{process.kill(pid,'SIGTERM');}catch{}}
  await new Promise(resolve=>setTimeout(resolve,1500));
  try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}
}

export function isProcessAlive(pid:number):boolean{
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch{return false;}
}
