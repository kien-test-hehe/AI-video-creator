const LOOPBACK_HOSTS = new Set(['localhost','127.0.0.1','::1','[::1]']);

export function assertLocalUrl(value:string,localOnly=true):URL{
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol))throw new Error('Only HTTP(S) local service URLs are supported.');
  if(localOnly&&!LOOPBACK_HOSTS.has(url.hostname))throw new Error(`Loopback-only policy blocks host: ${url.hostname}`);
  return url;
}
