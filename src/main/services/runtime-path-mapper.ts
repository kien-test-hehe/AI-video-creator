import { isAbsolute, relative, resolve } from 'node:path';
import type { AppMachineSettings, FilmProject } from '../../shared/types';
import { isPathInside } from './path-safety';

export function mapHostPathToWanGpRuntime(project: FilmProject, machine: AppMachineSettings, value: string): string {
  if (machine.wangp.executionMode === 'native' || !isAbsolute(value)) return value;
  const projectRoot = resolve(project.rootPath);
  const wangpRoot = resolve(machine.wangp.rootPath);
  const candidate = resolve(value);

  if (isPathInside(projectRoot,candidate)) {
    return joinContainer(machine.wangp.docker.projectMount, relative(projectRoot,candidate));
  }
  if (machine.wangp.rootPath && isPathInside(wangpRoot,candidate)) {
    return joinContainer(machine.wangp.docker.wangpMount, relative(wangpRoot,candidate));
  }
  throw new Error(`Docker WanGP cannot access host path outside the project/WanGP mounts: ${value}. Copy the file into the project or WanGP directory, or use native mode.`);
}

export function mapJsonHostPathsForWanGp<T>(project: FilmProject, machine: AppMachineSettings, value: T): T {
  if (machine.wangp.executionMode === 'native') return structuredClone(value);
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current as Record<string,unknown>).map(([k,v])=>[k,visit(v)]));
    if (typeof current === 'string' && isAbsolute(current)) return mapHostPathToWanGpRuntime(project,machine,current);
    return current;
  };
  return visit(value) as T;
}

function joinContainer(root:string,rel:string):string{
  const normalizedRoot=root.replace(/\\/g,'/').replace(/\/+$/,'');
  const normalizedRel=rel.replace(/\\/g,'/').replace(/^\/+/, '');
  return normalizedRel ? `${normalizedRoot}/${normalizedRel}` : normalizedRoot;
}
