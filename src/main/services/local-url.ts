const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertLocalUrl(value: string, localOnly = true): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) ComfyUI URLs are supported.');
  if (localOnly && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Local-only mode blocks non-loopback host: ${url.hostname}`);
  }
  return url;
}
