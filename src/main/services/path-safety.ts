import { isAbsolute, relative, resolve, sep } from 'node:path';

export function isPathInside(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const targetAbs = resolve(candidate);
  const rel = relative(rootAbs, targetAbs);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function assertPathInside(root: string, candidate: string, label = 'path'): string {
  const target = resolve(candidate);
  if (!isPathInside(root, target)) throw new Error(`Blocked ${label} outside the allowed project directory: ${candidate}`);
  return target;
}

export function assertRelativeProjectPath(root: string, relativePath: string, scope: string, label: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error(`Invalid ${label}: expected a project-relative path.`);
  const scopedRoot = resolve(root, scope);
  return assertPathInside(scopedRoot, resolve(root, relativePath), label);
}
