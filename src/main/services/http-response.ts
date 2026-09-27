export async function readResponseBufferLimited(response:Response,label:string,maxBytes:number):Promise<Uint8Array>{
  const declared=Number(response.headers.get('content-length')||0);
  if(Number.isFinite(declared)&&declared>maxBytes)throw new Error(`${label} response is too large (${declared} bytes; limit ${maxBytes}).`);
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{
    while(true){
      const{done,value}=await reader.read();if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){await reader.cancel().catch(()=>undefined);throw new Error(`${label} response exceeded the ${maxBytes}-byte safety limit.`);}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const out=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
  return out;
}

export async function readResponseTextLimited(response:Response,label:string,maxBytes:number):Promise<string>{
  return new TextDecoder().decode(await readResponseBufferLimited(response,label,maxBytes));
}

export async function readResponseJsonLimited<T=unknown>(response:Response,label:string,maxBytes:number):Promise<T>{
  const text=await readResponseTextLimited(response,label,maxBytes);
  try{return JSON.parse(text) as T;}
  catch(error){throw new Error(`${label} returned invalid JSON: ${error instanceof Error?error.message:String(error)}`);}
}
