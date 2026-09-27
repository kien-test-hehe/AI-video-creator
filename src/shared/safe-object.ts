const FORBIDDEN_OBJECT_KEYS=new Set(['__proto__','prototype','constructor']);

export function assertSafeObjectKey(value:string,label='object key'):string{
  if(FORBIDDEN_OBJECT_KEYS.has(value))throw new Error(`${label} uses forbidden object key: ${value}`);
  return value;
}

export function assertSafeJsonPath(path:string,label='JSON path'):string{
  const text=path.trim();if(!text)throw new Error(`${label} is empty.`);
  const segments:Array<string|number>=[];
  for(const part of text.split('.')){
    if(!part)throw new Error(`${label} contains an empty path segment.`);
    const re=/([^\[\]]+)|\[(\d+)\]/g;let match:RegExpExecArray|null,lastIndex=0;
    while((match=re.exec(part))){
      if(match.index!==lastIndex)throw new Error(`${label} contains invalid path syntax: ${path}`);
      const segment=match[2]!=null?Number(match[2]):match[1];
      if(typeof segment==='string')assertSafeObjectKey(segment,label);
      segments.push(segment);lastIndex=re.lastIndex;
    }
    if(lastIndex!==part.length)throw new Error(`${label} contains invalid path syntax: ${path}`);
  }
  if(!segments.length)throw new Error(`${label} is empty.`);
  return text;
}

export function parseSafeJsonPath(path:string,label='JSON path'):Array<string|number>{
  const safe=assertSafeJsonPath(path,label),result:Array<string|number>=[];
  for(const part of safe.split('.')){
    const re=/([^\[\]]+)|\[(\d+)\]/g;let match:RegExpExecArray|null;
    while((match=re.exec(part)))result.push(match[2]!=null?Number(match[2]):match[1]);
  }
  return result;
}
