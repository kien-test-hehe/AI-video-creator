import type { RenderJob, Shot } from './types';

const TERMINAL=new Set(['done','failed','cancelled','orphaned']);

export interface RecoverySelection{job:RenderJob;signed:boolean;persistTerminal:boolean}

export function selectRecoveryJob(projectJob:RenderJob,signedJournal:RenderJob|undefined,preferSigned=false):RecoverySelection{
  if(!signedJournal)return{job:projectJob,signed:false,persistTerminal:false};
  const projectTerminal=TERMINAL.has(projectJob.status);
  const journalTerminal=TERMINAL.has(signedJournal.status);
  if(preferSigned)return{job:signedJournal,signed:true,persistTerminal:journalTerminal&&(projectJob.status!==signedJournal.status||projectJob.updatedAt!==signedJournal.updatedAt)};
  const projectTime=Date.parse(projectJob.updatedAt)||0,journalTime=Date.parse(signedJournal.updatedAt)||0;
  if(projectTerminal&&projectTime>=journalTime)return{job:projectJob,signed:false,persistTerminal:false};
  if(journalTerminal)return{job:signedJournal,signed:true,persistTerminal:projectJob.status!==signedJournal.status||projectJob.updatedAt!==signedJournal.updatedAt};
  return{job:signedJournal,signed:true,persistTerminal:false};
}


export type JobSettlementOutcome='cancelled'|'orphaned'|'failed';

export function shotStatusAfterJobSettlement(
  currentStatus:Shot['status'],
  hasPreferredTake:boolean,
  jobStillCurrent:boolean,
  queuedShotStatus:Shot['status']|undefined,
  outcome:JobSettlementOutcome
):Shot['status']{
  if(hasPreferredTake)return'rendered';
  if(jobStillCurrent){
    if(outcome==='failed')return'failed';
    return queuedShotStatus==='draft'?'draft':'ready';
  }
  return currentStatus==='queued'||currentStatus==='rendering'?'ready':currentStatus;
}
