import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function assertTrustedIpcSender(event:IpcMainInvokeEvent,trustedRendererUrl:string):void{
  const frame=event.senderFrame;
  if(!frame)throw new Error('Blocked IPC call without a sender frame.');
  if(!isTrustedRendererNavigation(frame.url,trustedRendererUrl))throw new Error(`Blocked IPC sender: ${frame.url}`);
}

export function isTrustedRendererNavigation(url:string,trustedRendererUrl:string):boolean{
  let actual:URL,expected:URL;
  try{actual=new URL(url);expected=new URL(trustedRendererUrl);}catch{return false;}
  if(expected.protocol==='http:'||expected.protocol==='https:')return actual.origin===expected.origin;
  if(expected.protocol!=='file:'||actual.protocol!=='file:')return false;
  try{return resolve(fileURLToPath(actual))===resolve(fileURLToPath(expected));}catch{return false;}
}

export function lockDownWebContents(contents:WebContents,trustedRendererUrl:string):void{
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  contents.on('will-navigate',(event,url)=>{if(!isTrustedRendererNavigation(url,trustedRendererUrl))event.preventDefault();});
}
