const LOOPBACK_HOSTS = new Set(['localhost','127.0.0.1','::1','[::1]']);

export function assertLocalUrl(value:string,localOnly=true):URL{
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol))throw new Error('Only HTTP(S) local service URLs are supported.');
  if(localOnly&&!LOOPBACK_HOSTS.has(url.hostname))throw new Error(`Local-only loopback policy blocks host: ${url.hostname}`);
  return url;
}

export function fetchLocalUrl(value:string|URL,init:RequestInit={},localOnly=true):Promise<Response>{
  const url=assertLocalUrl(value instanceof URL?value.toString():value,localOnly);
  return fetch(url,{...init,redirect:'error'});
}
