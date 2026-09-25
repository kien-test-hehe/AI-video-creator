import { access, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

export async function assertExistingPathInside(root: string, candidate: string, label = 'path'): Promise<string> {
  const lexical = assertPathInside(root, candidate, label);
  const [realRoot, realCandidate] = await Promise.all([realpath(resolve(root)), realpath(lexical)]);
  if (!isPathInside(realRoot, realCandidate)) throw new Error(`Blocked symlink escape for ${label}: ${candidate}`);
  return realCandidate;
}

export async function assertExistingRelativeProjectPath(root: string, relativePath: string, scope: string, label: string): Promise<string> {
  const lexical = assertRelativeProjectPath(root, relativePath, scope, label);
  return assertExistingPathInside(resolve(root, scope), lexical, label);
}

export async function assertSafeWritePath(root: string, candidate: string, label = 'write path'): Promise<string> {
  const lexical = assertPathInside(root, candidate, label);
  const realRoot = await realpath(resolve(root));
  let ancestor = dirname(lexical);
  while (true) {
    try {
      await access(ancestor);
      const realAncestor = await realpath(ancestor);
      if (!isPathInside(realRoot, realAncestor)) throw new Error(`Blocked symlink escape for ${label}: ${candidate}`);
      return lexical;
    } catch (error: any) {
      if (error?.message?.startsWith('Blocked symlink escape')) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`Unable to resolve a safe parent for ${label}: ${candidate}`);
      ancestor = parent;
    }
  }
}

export function assertSafeRelativePath(value: string, label = 'relative path'): string {
  if (!value || isAbsolute(value)) throw new Error(`Invalid ${label}: expected a relative path.`);
  const normalized = value.replace(/\\/g,'/');
  if (normalized.split('/').some(part => part === '..')) throw new Error(`Invalid ${label}: parent traversal is not allowed.`);
  return normalized.replace(/^\.\//,'').replace(/^\/+|\/+$/g,'');
}
