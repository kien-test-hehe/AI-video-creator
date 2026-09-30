import type { QcIssue, QcLayer, RenderJob } from './types';

export interface AutoRetryDecision {
  action:'retry'|'human';
  reason:string;
}

const PERMANENT_RENDER_FAILURES:RegExp[]=[
  /out of memory|cuda\s*(?:error\s*)?(?:out of memory|oom)|allocation failed/i,
  /invalid (?:node|workflow|binding)|unknown node|node .* not found|class[_ -]?type|missing node/i,
  /unsupported (?:dimension|resolution|width|height)|invalid (?:dimension|resolution|width|height)|must be (?:a )?multiple of/i,
  /missing (?:model|checkpoint|weight|file)|model .* not found|checkpoint .* not found|no such file/i,
  /workflow .* changed|immutable .* changed|asset .* changed|validation failed|binding .* invalid/i,
  /permission denied|access denied|no space left|disk .* full/i,
  /completed without producing a video|no downloadable output files/i
];

const TRANSIENT_RENDER_FAILURES:RegExp[]=[
  /timed? out|timeout/i,
  /temporar(?:y|ily)|try again/i,
  /connection (?:reset|refused|closed)|econnreset|econnrefused|socket hang up/i,
  /(?:http\s*)?(?:429|502|503|504)\b|service unavailable|backend unavailable/i
];

export function renderFailureAutoRetryDecision(job:Pick<RenderJob,'status'|'error'|'message'>):AutoRetryDecision{
  const detail=`${job.error??''} ${job.message??''}`.trim();
  if(PERMANENT_RENDER_FAILURES.some(pattern=>pattern.test(detail))){
    return{action:'human',reason:'The render failure looks deterministic or resource/configuration-bound; repeating the same immutable job is unlikely to help.'};
  }
  if(TRANSIENT_RENDER_FAILURES.some(pattern=>pattern.test(detail))){
    return{action:'retry',reason:'The render failure looks transient, so one bounded retry of the immutable snapshot is reasonable.'};
  }
  if(job.status==='orphaned'){
    return{action:'retry',reason:'The job became orphaned during runtime/recovery rather than failing a known deterministic validation path.'};
  }
  return{action:'human',reason:'The render failure is not recognized as transient, so CineForge will not spend GPU time repeating it blindly.'};
}

export function qcFailureAutoRetryDecision(failure:{layer:Exclude<QcLayer,'technical'>;issues:QcIssue[]}):AutoRetryDecision{
  if(failure.layer==='visual'){
    return{action:'retry',reason:'Visual-integrity defects are often stochastic, so a bounded seed reroll is allowed.'};
  }
  if(failure.layer==='semantic'){
    return{action:'human',reason:'Semantic failures usually require correcting prompt/reference/asset intent rather than changing only the random seed.'};
  }
  return{action:'human',reason:'Continuity failures require correcting incoming state, references, staging or camera intent rather than changing only the random seed.'};
}

export function qcFailureSummary(failure:{layer:Exclude<QcLayer,'technical'>;issues:QcIssue[]}):string{
  const detail=failure.issues
    .filter(issue=>issue.severity==='major'||issue.severity==='blocker'||issue.severity==='warning')
    .slice(0,8)
    .map(issue=>`${issue.code}: ${issue.message}`)
    .join(' | ');
  return detail||`${failure.layer} QC failed without a structured issue description.`;
}
