import type {AdminInspectionRow as Row} from '@bondbuddy/contracts';

export const statusGroups=[
 {key:'succeeded',label:'成功',states:['succeeded']},
 {key:'paused',label:'暂停',states:['paused']},
 {key:'failed',label:'失败',states:['failed']},
 {key:'in_progress',label:'进行中',states:['preparing','queued','running','validating','delivering','settlement_pending']},
 {key:'awaiting_input',label:'等待补充',states:['awaiting_input']},
 {key:'cancelled',label:'已取消',states:['cancelled']},
 {key:'rejected',label:'被拒绝',states:['rejected']},
 {key:'test_completed',label:'测试完成',states:['test_completed']},
 {key:'unknown_state',label:'未知状态',states:[]}
] as const;
export type StatusGroupKey=typeof statusGroups[number]['key'];
export type StatusCounts=Record<StatusGroupKey,number>;
export interface StatusSummary {total:number;counts:StatusCounts}
const stateGroups=new Map<string,StatusGroupKey>(statusGroups.flatMap(group=>group.states.map(state=>[state,group.key] as [string,StatusGroupKey])));

export function statusGroup(state:unknown):StatusGroupKey {
 return typeof state==='string'?stateGroups.get(state)??'unknown_state':'unknown_state';
}

/** Attention and stale depend on task evidence and remain the caller's responsibility. */
export function matchesStatusFilter(state:unknown,filter:string):boolean {
 if(!filter)return true;
 if(filter==='in_progress'||filter==='unknown_state')return statusGroup(state)===filter;
 return state===filter;
}

function emptySummary():StatusSummary {
 return {total:0,counts:Object.fromEntries(statusGroups.map(group=>[group.key,0])) as StatusCounts};
}

/** Count the current state once per supplied execution, never historical errors or attempts. */
export function summarizeStatus(runs:Row[],kindOf:(run:Row)=>string):{total:StatusSummary;types:Array<StatusSummary&{kind:string}>} {
 const total=emptySummary(),types=new Map<string,StatusSummary&{kind:string}>();
 for(const run of runs){
  const kind=kindOf(run),group=statusGroup(run.state);
  let type=types.get(kind);
  if(!type){type={kind,...emptySummary()};types.set(kind,type);}
  total.total++;total.counts[group]++;
  type.total++;type.counts[group]++;
 }
 return {total,types:[...types.values()]};
}

/** Keep an already narrower state predicate when opening a nonzero summary count. */
export function drillStatusFilter(current:string,target:string):string {
 if(!target||current==='stale')return current;
 if(current==='attention'&&target==='in_progress')return 'stale';
 if(current&&!['in_progress','unknown_state','attention'].includes(current)&&matchesStatusFilter(current,target))return current;
 return target;
}
