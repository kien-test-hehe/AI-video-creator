export class AdmissionGate{
  private tail:Promise<void>=Promise.resolve();
  private count=0;

  get busy():boolean{return this.count>0;}

  async run<T>(operation:()=>Promise<T>):Promise<T>{
    this.count+=1;
    const previous=this.tail;let release!:()=>void;
    this.tail=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try{return await operation();}
    finally{this.count=Math.max(0,this.count-1);release();}
  }
}
