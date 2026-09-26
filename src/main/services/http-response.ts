export async function readResponseTextLimited(response:Response,label:string,maxBytes:number):Promise<string>{
  const declared=Number(response.headers.get('content-length')||0);
  if(Number.isFinite(declared)&&declared>maxBytes)throw new Error(`${label} response is too large (${declared} bytes; limit ${maxBytes}).`);
  if(!response.body)return'';
  const reader=response.body.getReader(),decoder=new TextDecoder();let total=0,text='';
  try{
    while(true){
      const{done,value}=await reader.read();if(done)break;
      total+=value.byteLength;if(total>maxBytes){await reader.cancel().catch(()=>undefined);throw new Error(`${label} response exceeded the ${maxBytes}-byte safety limit.`);}
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();return text;
  }finally{reader.releaseLock();}
}

export async function readResponseJsonLimited<T=unknown>(response:Response,label:string,maxBytes:number):Promise<T>{
  const text=await readResponseTextLimited(response,label,maxBytes);
  try{return JSON.parse(text) as T;}
  catch(error){throw new Error(`${label} returned invalid JSON: ${error instanceof Error?error.message:String(error)}`);}
}
