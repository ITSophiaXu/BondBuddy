import type {Pool} from 'pg';
import {recordPerformanceObservations,type PerformanceTraceScope} from './performance-trace.js';
export type CommittedPerformanceDispatch={scope:PerformanceTraceScope;batchCreatedAt:string|Date;operation:string};
/** Call only after transaction() has resolved: rolled-back admissions and idle polling emit nothing. */
export function recordCommittedPerformanceDispatch(pool:Pool,admitted:CommittedPerformanceDispatch|null,startedAt:Date,endedAt:Date):void {
 if(!admitted)return;
 try{
  const attributes={stage:'dispatch',operation:admitted.operation};
  recordPerformanceObservations(pool,{...admitted.scope,serviceRole:'batch_dispatcher'},[
   {stepKey:'batch.dispatch_transaction',interval:{startedAt,endedAt,clockSource:'wall_clock_observation'},
    attributes:{...attributes,measurement_source:'transaction_call_through_commit'}},
   {stepKey:'batch.item_wait',interval:{startedAt:admitted.batchCreatedAt,endedAt,clockSource:'wall_clock_observation'},
    attributes:{...attributes,measurement_source:'batch_created_to_admission',wait_reason:'total_elapsed_including_pauses'}}
  ]);
 }catch{}
}
