import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

export async function killProcessTree(pid:number):Promise<void>{
  if(!Number.isInteger(pid)||pid<=0)return;
  if(process.platform==='win32'){
    try{await execFileAsync('taskkill',['/PID',String(pid),'/T','/F'],{timeout:10_000});}
    catch(error){if(isProcessAlive(pid))throw error;}
    await new Promise(resolve=>setTimeout(resolve,250));
    if(isProcessAlive(pid))throw new Error(`Process ${pid} is still alive after taskkill.`);
    return;
  }
  try{process.kill(-pid,'SIGTERM');}catch{try{process.kill(pid,'SIGTERM');}catch{}}
  await new Promise(resolve=>setTimeout(resolve,1500));
  if(!isProcessAlive(pid))return;
  try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}
  await new Promise(resolve=>setTimeout(resolve,250));
  if(isProcessAlive(pid))throw new Error(`Process ${pid} is still alive after SIGKILL.`);
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


export async function findExpectedProcessPids(markers:string[]):Promise<number[]>{
  const wanted=markers.map(marker=>marker.toLowerCase()).filter(Boolean);
  if(!wanted.length)return[];
  try{
    if(process.platform==='win32'){
      const escaped=wanted.map(marker=>marker.replace(/'/g,"''"));
      const predicate=escaped.map(marker=>`$c.Contains('${marker}')`).join(' -and ');
      const script=`Get-CimInstance Win32_Process | ForEach-Object { if($_.ProcessId -ne $PID -and $_.CommandLine){ $c=$_.CommandLine.ToLowerInvariant(); if(${predicate}){ $_.ProcessId } } }`;
      const{stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:10_000,maxBuffer:2*1024*1024});
      return stdout.split(/\r?\n/).map(value=>Number(value.trim())).filter(pid=>Number.isInteger(pid)&&pid>0&&pid!==process.pid);
    }
    const{stdout}=await execFileAsync('ps',['-eo','pid=,command='],{timeout:8000,maxBuffer:8*1024*1024});
    const matches:number[]=[];
    for(const line of stdout.split(/\r?\n/)){
      const match=line.match(/^\s*(\d+)\s+(.*)$/);if(!match)continue;
      const pid=Number(match[1]),command=match[2].toLowerCase();
      if(pid!==process.pid&&wanted.every(marker=>command.includes(marker)))matches.push(pid);
    }
    return matches;
  }catch{return[];}
}
