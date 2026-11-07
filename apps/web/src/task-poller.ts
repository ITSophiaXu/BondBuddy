/** One visible-page refresh at a time; terminal queues have no recurring timer. */
export class TaskPoller {
  private timer?:ReturnType<typeof setTimeout>;
  private inFlight?:AbortController;
  private enabled=false;
  private disposed=false;
  private failures=0;
  private force=false;
  constructor(private options:{
    active:()=>boolean;live:()=>boolean;blocked:()=>boolean;
    refresh:(signal:AbortSignal,force:boolean)=>Promise<void>;
    failed?:(stopped:boolean)=>void;interval?:number;
  },private visibility:Pick<Document,'hidden'|'addEventListener'|'removeEventListener'>=document){
    visibility.addEventListener('visibilitychange',this.visibilityChanged);
  }
  private visibilityChanged=()=>{
    clearTimeout(this.timer);
    if(this.visibility.hidden){this.inFlight?.abort();return;}
    if(this.enabled){this.force=true;this.failures=0;void this.tick();}
  };
  start(){
    if(this.disposed)return;
    this.enabled=true;this.failures=0;this.schedule();
  }
  pause(){this.enabled=false;clearTimeout(this.timer);this.inFlight?.abort();}
  dispose(){this.disposed=true;this.pause();this.visibility.removeEventListener('visibilitychange',this.visibilityChanged);}
  private schedule(){
    clearTimeout(this.timer);
    if(!this.enabled||this.disposed||this.inFlight||!this.options.live()||this.visibility.hidden||this.failures>=5)return;
    if(!this.force&&!this.options.active())return;
    this.timer=setTimeout(()=>void this.tick(),this.force&&!this.options.blocked()?0:(this.options.interval??10_000)*2**this.failures);
  }
  private async tick(){
    if(!this.enabled||this.disposed||this.inFlight||!this.options.live()||this.visibility.hidden)return;
    if(this.options.blocked()){this.schedule();return;}
    if(!this.force&&!this.options.active())return;
    const controller=new AbortController(),force=this.force;this.force=false;this.inFlight=controller;
    try{
      await this.options.refresh(AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]),force);
      if(!controller.signal.aborted)this.failures=0;
    }catch{
      if(!controller.signal.aborted){this.failures++;this.options.failed?.(this.failures>=5);}
    }finally{
      this.inFlight=undefined;this.schedule();
    }
  }
}
