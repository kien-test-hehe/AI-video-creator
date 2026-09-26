import type { RenderJob } from './types';

const TERMINAL=new Set(['done','failed','cancelled','orphaned']);

export interface RecoverySelection{job:RenderJob;signed:boolean;persistTerminal:boolean}

export function selectRecoveryJob(projectJob:RenderJob,signedJournal:RenderJob|undefined):RecoverySelection{
  if(!signedJournal)return{job:projectJob,signed:false,persistTerminal:false};
  const projectTerminal=TERMINAL.has(projectJob.status);
  const journalTerminal=TERMINAL.has(signedJournal.status);
  const projectTime=Date.parse(projectJob.updatedAt)||0,journalTime=Date.parse(signedJournal.updatedAt)||0;
  if(projectTerminal&&projectTime>=journalTime)return{job:projectJob,signed:false,persistTerminal:false};
  if(journalTerminal)return{job:signedJournal,signed:true,persistTerminal:projectJob.status!==signedJournal.status||projectJob.updatedAt!==signedJournal.updatedAt};
  return{job:signedJournal,signed:true,persistTerminal:false};
}
