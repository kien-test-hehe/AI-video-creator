export const WORKFLOW_PROFILE_LIMIT=512;
export const WORKFLOW_BINDING_LIMIT=256;
export const WORKFLOW_PROFILE_NOTES_LIMIT=20_000;
export const WORKFLOW_BINDING_NODE_ID_LIMIT=128;
export const WORKFLOW_BINDING_CLASS_TYPE_LIMIT=256;
export const WORKFLOW_BINDING_TITLE_LIMIT=256;
export const WORKFLOW_BINDING_INPUT_LIMIT=256;
export const WORKFLOW_BINDING_JSON_PATH_LIMIT=1024;

export function buildWorkflowImportNotes(baseNotes:string,warnings:string[]):string{
  const suffix='\n\n[Additional import warnings truncated to fit the project notes safety limit.]';
  const full=[baseNotes,warnings.length?`Import warnings:\n- ${warnings.join('\n- ')}`:''].filter(Boolean).join('\n\n');
  if(full.length<=WORKFLOW_PROFILE_NOTES_LIMIT)return full;
  const keep=Math.max(0,WORKFLOW_PROFILE_NOTES_LIMIT-suffix.length);
  return `${full.slice(0,keep)}${suffix}`;
}
