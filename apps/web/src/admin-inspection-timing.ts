import type {AdminInspectionRow as Row} from '@bondbuddy/contracts';

const terminalStates=new Set(['succeeded','test_completed','failed','rejected','cancelled']);
const timestamp=(value:unknown)=>{const n=Date.parse(String(value??''));return Number.isFinite(n)?n:null;};
const difference=(end:number|null,start:number|null)=>end!==null&&start!==null&&end>=start?end-start:null;
export interface ExecutionTiming {
 totalMs:number|null;
 initialWaitMs:number|null;
 processingMs:number|null;
 startedAt:string|null;
 endedAt:string|null;
 open:boolean;
}

/** Wall-clock durations for this exact run; updated_at is never a completion timestamp. */
export function executionTiming(run:Row,events:Row[],capturedAt:string):ExecutionTiming {
 const created=timestamp(run.created_at),captured=timestamp(capturedAt),open=!terminalStates.has(String(run.state));
 const changes=events.filter(e=>e.run_id===run.id&&e.type==='run.state_changed').sort((a,b)=>Number(a.seq)-Number(b.seq));
 let finalEvent:Row|undefined;
 if(!open&&changes.at(-1)?.state===run.state){
  let index=changes.length-1;
  while(index>0&&changes[index-1].state===run.state)index--;
  finalEvent=changes[index];
 }
 const validTime=(value:unknown)=>{const n=timestamp(value);return n!==null&&captured!==null&&created!==null&&n>=created&&n<=captured?n:null;};
 const ended=validTime(finalEvent?.occurred_at),endpoint=open?captured:ended;
 // Without the initial state event, a visible running event may be a later resume.
 const firstRunning=Number(changes[0]?.seq)===1?changes.find(e=>e.state==='running'):undefined;
 const startCandidate=validTime(firstRunning?.occurred_at);
 const started=startCandidate!==null&&(endpoint===null||startCandidate<=endpoint)?startCandidate:null;
 return {totalMs:difference(endpoint,created),initialWaitMs:difference(started,created),processingMs:difference(endpoint,started),startedAt:started===null?null:new Date(started).toISOString(),endedAt:ended===null?null:new Date(ended).toISOString(),open};
}

export function duration(ms:number|null):string {
 if(ms===null||!Number.isFinite(ms)||ms<0)return '未知';
 if(ms<1000)return `${Math.floor(ms)} 毫秒`;
 let seconds=Math.floor(ms/1000);const parts:string[]=[];
 for(const [size,unit] of [[86400,'天'],[3600,'小时'],[60,'分'],[1,'秒']] as const){const n=Math.floor(seconds/size);if(n)parts.push(`${n} ${unit}`);seconds%=size;}
 return parts.join(' ');
}

export function durationStats(values:number[]){
 const sorted=values.filter(n=>Number.isFinite(n)&&n>=0).sort((a,b)=>a-b);
 const percentile=(p:number)=>sorted.length?sorted[Math.ceil(p*sorted.length)-1]:null;
 return {count:sorted.length,mean:sorted.length?sorted.reduce((a,b)=>a+b,0)/sorted.length:null,p50:percentile(.5),p95:percentile(.95),max:sorted.at(-1)??null};
}
