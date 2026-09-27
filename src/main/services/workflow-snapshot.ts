import { copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WorkflowProfile } from '../../shared/types';
import { assertExistingPathInside, assertSafeWritePath, ensureSafeDirectory } from './path-safety';
import { sha256File } from './runtime-fingerprint';

export async function stageWorkflowProfileSnapshot(
  projectRoot:string,
  profile:WorkflowProfile,
  expectedSha256:string,
  snapshotRoot:string
):Promise<WorkflowProfile>{
  const source=await assertExistingPathInside(join(projectRoot,'workflows'),profile.workflowPath,`workflow path for ${profile.name}`);
  snapshotRoot=await ensureSafeDirectory(join(projectRoot,'cache'),snapshotRoot,'immutable workflow snapshot directory');
  const safeName=basename(source).replace(/[^a-zA-Z0-9._-]+/g,'_')||'workflow.json';
  const target=await assertSafeWritePath(snapshotRoot,join(snapshotRoot,safeName),'immutable workflow snapshot');
  await copyFile(source,target);
  const actual=await sha256File(target);
  if(actual!==expectedSha256)throw new Error(`Workflow changed while staging immutable snapshot: ${profile.name}. Queue/validate again.`);
  return{...structuredClone(profile),workflowPath:target};
}
