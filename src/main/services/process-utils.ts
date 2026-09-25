import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

export async function processCommandLine(pid:number):Promise<string|undefined>{
  if(!isProcessAlive(pid))return undefined;
  try{
    if(process.platform==='win32'){
      const script=`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){$p.CommandLine}`;
      const{stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:8000,maxBuffer:1024*1024});
      return stdout.trim()||undefined;
    }
    if(process.platform==='linux'){
      const raw=await readFile(`/proc/${pid}/cmdline`);
      return raw.toString('utf8').replace(/\0/g,' ').trim()||undefined;
    }
    const{stdout}=await execFileAsync('ps',['-p',String(pid),'-o','command='],{timeout:5000,maxBuffer:1024*1024});
    return stdout.trim()||undefined;
  }catch{return undefined;}
}

export async function isExpectedProcess(pid:number,markers:string[]):Promise<boolean>{
  const command=await processCommandLine(pid);if(!command)return false;
  const lower=command.toLowerCase();return markers.every(marker=>lower.includes(marker.toLowerCase()));
}
