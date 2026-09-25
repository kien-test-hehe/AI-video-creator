/** Project media is served by a read-only Electron protocol handler. */
export function projectMediaUrl(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `cineforge-media://project/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}
