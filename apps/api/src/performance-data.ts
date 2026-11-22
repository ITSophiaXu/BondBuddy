import type {PoolClient} from 'pg';
import type {AdminPerformanceRunResponse,AdminPerformanceSummaryResponse,PerformanceCoverage,PerformanceSpan,PerformanceSession} from '@bondbuddy/contracts';
import {Problem,missing} from './data.js';
import {sanitizePerformanceAttributes} from './performance-trace.js';
import {PERFORMANCE_FILTERS,type PerformanceFilters} from '@bondbuddy/contracts';
export {PERFORMANCE_FILTERS,type PerformanceFilters} from '@bondbuddy/contracts';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const code=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const bad=()=>new Problem(422,'VALIDATION_FAILED','Invalid performance query');
const iso=(v:unknown)=>v===null||v===undefined?null:new Date(v as string).toISOString();
const n=(v:unknown)=>Number(v??0);
export function parsePerformanceFilters(q:unknown):PerformanceFilters{
 if(q===null||typeof q!=='object'||Array.isArray(q))throw bad();const out:PerformanceFilters={};
 for(const [key,value] of Object.entries(q)){
  if(!(PERFORMANCE_FILTERS as readonly string[]).includes(key)||typeof value!=='string'||!value)throw bad();
  if(key==='from'||key==='to'){if(!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw bad();out[key]=new Date(value).toISOString();}
  else {if(!code(value))throw bad();out[key as keyof PerformanceFilters]=value;}
 }
 if(out.from&&out.to&&out.from>out.to)throw bad();return out;
}
type Page={limit:number;after:{started_at:string;span_id:string}|null;snapshot_at:string|null;membership_snapshot:string|null};
function validSnapshot(value:unknown):value is string {
 if(typeof value!=='string'||value.length>8192||!/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(value))return false;
 try{
  const [min,max,list]=value.split(':'),lo=BigInt(min!),hi=BigInt(max!);
  if(lo<1n||hi<lo||hi>18446744073709551615n)return false;
  let last=lo-1n;
  for(const part of list?list.split(','):[]){const xid=BigInt(part);if(xid<lo||xid>=hi||xid<=last)return false;last=xid;}
  return true;
 }catch{return false;}
}
export function parsePerformancePage(runId:string,q:unknown):Page{
 if(!id(runId)||q===null||typeof q!=='object'||Array.isArray(q))throw bad();
 const query=q as Record<string,unknown>;if(Object.keys(query).some(k=>!['limit','cursor'].includes(k)))throw bad();
 const limit=query.limit===undefined?200:Number(query.limit);if(!Number.isInteger(limit)||limit<1||limit>500)throw bad();
 if(query.cursor===undefined)return {limit,after:null,snapshot_at:null,membership_snapshot:null};
 if(typeof query.cursor!=='string'||query.cursor.length>16384||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw bad();
 try{const c=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));
  if(!validSnapshot(c.membership_snapshot)||c.run_id!==runId||!id(c.span_id)||typeof c.started_at!=='string'||typeof c.snapshot_at!=='string'||!Number.isFinite(Date.parse(c.started_at))||!Number.isFinite(Date.parse(c.snapshot_at)))throw bad();
  return {limit,after:{started_at:new Date(c.started_at).toISOString(),span_id:c.span_id},snapshot_at:new Date(c.snapshot_at).toISOString(),membership_snapshot:c.membership_snapshot};
 }catch{throw bad();}
}
function sqlScope(filters:PerformanceFilters){
 const args:unknown[]=[],run:string[]=[],span:string[]=[];
 const put=(list:string[],column:string,value:string)=>{args.push(value);list.push(column+'=$'+args.length);};
 for(const [k,v] of Object.entries(filters)){
  if(k==='from'||k==='to'){args.push(v);run.push('r.created_at'+(k==='from'?'>=':'<=')+'$'+args.length+'::timestamptz');}
  else if(['owner_user_id','project_id','task_kind','channel'].includes(k))put(run,'r.'+k,v);
  else if(k==='run_state')put(run,'r.state',v);
  else if(k==='span_status')put(span,'p.status',v);
  else if(k==='stage'||k==='step_key')put(span,'p.'+k,v);
  else if(k==='release_sha')put(span,'s.release_sha',v);
  else put(span,"p.attributes->>'"+k+"'",v);
 }
 return {args,run:run.join(' AND ')||'true',span:span.join(' AND ')||'true'};
}
async function coverage(c:PoolClient,runWhere:string,spanWhere:string,args:unknown[]):Promise<PerformanceCoverage>{
 const raw=(await c.query(`WITH cohort AS (SELECT r.id,r.owner_user_id FROM bb_runs r WHERE ${runWhere}),
 sessions AS (SELECT s.* FROM bb_performance_sessions s JOIN cohort c ON c.id=s.run_id AND c.owner_user_id=s.owner_user_id),
 spans AS (SELECT p.* FROM bb_performance_spans p JOIN sessions s ON s.session_id=p.session_id WHERE ${spanWhere})
 SELECT (SELECT count(*) FROM cohort) run_count,(SELECT count(DISTINCT run_id) FROM sessions) instrumented_run_count,
 (SELECT count(*) FROM sessions) session_count,(SELECT count(*) FROM sessions WHERE purged_at IS NOT NULL) purged_session_count,
 (SELECT coalesce(sum(purged_span_count),0) FROM sessions) purged_span_count,(SELECT count(*) FROM sessions WHERE complete) complete_session_count,
 (SELECT count(*) FROM spans) span_count,(SELECT count(*) FROM spans WHERE ended_at IS NULL OR attributes->>'timing_complete'='false' OR attributes->>'tool_timing_complete'='false') unfinished_span_count,
 (SELECT coalesce(sum(dropped),0) FROM sessions) dropped_spans,(SELECT coalesce(sum(invalid_attributes),0) FROM sessions) invalid_attributes,
 (SELECT coalesce(sum(flush_errors),0) FROM sessions) flush_errors`,args)).rows[0];
 const value=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,n(v)])) as unknown as PerformanceCoverage;
 value.uninstrumented_run_count=value.run_count-value.instrumented_run_count;
 value.complete=value.purged_session_count===0&&value.uninstrumented_run_count===0&&value.session_count>0&&value.session_count===value.complete_session_count&&value.unfinished_span_count===0&&value.dropped_spans===0&&value.invalid_attributes===0&&value.flush_errors===0;
 return value;
}
const spanDto=(r:any):PerformanceSpan=>({
 span_id:r.span_id,parent_span_id:r.parent_span_id,session_id:r.session_id,run_execution_id:r.run_execution_id,trace_id:r.trace_id,run_id:r.run_id,job_id:r.job_id,
 stage:r.stage,step_key:r.step_key,step_version:r.step_version,status:r.status,started_at:iso(r.started_at)!,ended_at:iso(r.ended_at),duration_ms:r.duration_ms===null?null:n(r.duration_ms),last_activity_at:iso(r.last_activity_at)!,clock_source:r.clock_source,
 attributes:sanitizePerformanceAttributes(r.attributes??{}).attributes,span_links:Array.isArray(r.span_links)?r.span_links.filter(id).slice(0,16):[],
});
const sessionDto=(r:any):PerformanceSession=>({
 session_id:r.session_id,run_execution_id:r.run_execution_id,service_role:r.service_role,worker_instance_id:r.worker_instance_id,release_sha:r.release_sha,
 started_at:iso(r.started_at)!,ended_at:iso(r.ended_at),last_flush_at:iso(r.last_flush_at),closed:r.closed,
 generated:n(r.generated),acknowledged:n(r.acknowledged),dropped:n(r.dropped),invalid_attributes:n(r.invalid_attributes),flush_errors:n(r.flush_errors),last_sequence:n(r.last_sequence),complete:r.complete,purged_at:iso(r.purged_at),purged_span_count:n(r.purged_span_count),purge_reason:r.purge_reason,purge_policy_version:r.purge_policy_version,
});
export async function readPerformanceRun(c:PoolClient,runId:string,page:Page,auditId:string):Promise<AdminPerformanceRunResponse>{
 const r=(await c.query(`SELECT r.id,r.owner_user_id,r.created_at,r.state,now() captured_at,pg_current_snapshot()::text membership_snapshot,
 CASE WHEN EXISTS(SELECT 1 FROM bb_run_events e WHERE e.run_id=r.id AND e.seq=1 AND e.type='run.state_changed')
 THEN (SELECT min(e.occurred_at) FROM bb_run_events e WHERE e.run_id=r.id AND e.type='run.state_changed' AND e.state='running') END started_at,
 CASE WHEN r.state IN ('succeeded','failed','cancelled','rejected','test_completed') THEN
 (SELECT min(e.occurred_at) FROM bb_run_events e WHERE e.run_id=r.id AND e.type='run.state_changed' AND e.state=r.state
 AND e.seq>coalesce((SELECT max(x.seq) FROM bb_run_events x WHERE x.run_id=r.id AND x.type='run.state_changed' AND x.state<>r.state),0)) END ended_at
 FROM bb_runs r WHERE r.id=$1`,[runId])).rows[0];if(!r)throw missing();
 const captured=iso(r.captured_at)!,snapshot=page.snapshot_at??captured,membership=page.membership_snapshot??r.membership_snapshot;
 if(!validSnapshot(membership))throw new Problem(422,'VALIDATION_FAILED','Performance snapshot is too large; retry when transaction concurrency is lower');
 const args:unknown[]=[runId,snapshot,membership],after=page.after?' AND (p.started_at,p.span_id)>($4::timestamptz,$5::text)':'';
 if(page.after)args.push(page.after.started_at,page.after.span_id);args.push(page.limit+1);
 const rows=(await c.query(`SELECT p.* FROM bb_performance_spans p WHERE p.run_id=$1 AND p.owner_user_id=(SELECT owner_user_id FROM bb_runs WHERE id=$1) AND p.recorded_at<=$2::timestamptz AND pg_visible_in_snapshot(p.recorded_xid,$3::pg_snapshot)${after} ORDER BY p.started_at,p.span_id LIMIT $${args.length}`,args)).rows;
 const total=n((await c.query('SELECT count(*) n FROM bb_performance_spans WHERE run_id=$1 AND owner_user_id=(SELECT owner_user_id FROM bb_runs WHERE id=$1) AND recorded_at<=$2::timestamptz AND pg_visible_in_snapshot(recorded_xid,$3::pg_snapshot)',[runId,snapshot,membership])).rows[0].n);
 const sessions=(await c.query('SELECT * FROM bb_performance_sessions WHERE run_id=$1 AND owner_user_id=(SELECT owner_user_id FROM bb_runs WHERE id=$1) ORDER BY started_at,session_id',[runId])).rows.map(sessionDto);
 const items=rows.slice(0,page.limit).map(spanDto),last=items.at(-1);
 return {schema_version:1,captured_at:captured,snapshot_at:snapshot,audit_id:auditId,run_id:runId,trace_id:runId,
  run:{created_at:iso(r.created_at)!,state:r.state,started_at:iso(r.started_at),ended_at:iso(r.ended_at)},
  items,next_cursor:rows.length>page.limit&&last?Buffer.from(JSON.stringify({run_id:runId,started_at:last.started_at,span_id:last.span_id,snapshot_at:snapshot,membership_snapshot:membership})).toString('base64url'):null,total,
  coverage:await coverage(c,'r.id=$1','p.recorded_at<=$2::timestamptz AND pg_visible_in_snapshot(p.recorded_xid,$3::pg_snapshot)',[runId,snapshot,membership]),sessions};
}
export async function readPerformanceSummary(c:PoolClient,filters:PerformanceFilters,auditId:string):Promise<AdminPerformanceSummaryResponse>{
 const scope=sqlScope(filters);
 const rows=(await c.query(`WITH samples AS (
 SELECT r.task_kind,r.state run_state,p.*,s.release_sha,p.attributes->>'model_provider' model_provider,p.attributes->>'model_id' model_id,
 CASE WHEN p.ended_at IS NOT NULL AND p.attributes->>'timing_complete' IS DISTINCT FROM 'false' THEN p.duration_ms END measured
 FROM bb_runs r JOIN bb_performance_spans p ON p.run_id=r.id AND p.owner_user_id=r.owner_user_id
 JOIN bb_performance_sessions s ON s.session_id=p.session_id WHERE ${scope.run} AND ${scope.span})
 SELECT task_kind,stage,step_key,step_version,status span_status,model_provider,model_id,release_sha,run_state,
 count(*) span_count,count(DISTINCT run_id) run_count,count(*) FILTER(WHERE ended_at IS NOT NULL) completed_count,count(measured) timed_count,
 count(*) FILTER(WHERE ended_at IS NULL) running_count,count(*) FILTER(WHERE status='failed') failed_count,count(*) FILTER(WHERE measured IS NULL) missing_duration_count,
 avg(measured) mean_ms,percentile_cont(0.5) WITHIN GROUP(ORDER BY measured) p50_ms,percentile_cont(0.9) WITHIN GROUP(ORDER BY measured) p90_ms,
 percentile_cont(0.95) WITHIN GROUP(ORDER BY measured) p95_ms,max(measured) max_ms
 FROM samples GROUP BY task_kind,stage,step_key,step_version,status,model_provider,model_id,release_sha,run_state
 ORDER BY task_kind,step_key,stage NULLS FIRST,model_provider NULLS FIRST,model_id NULLS FIRST,release_sha NULLS FIRST,run_state,status LIMIT 5001`,scope.args)).rows;
 if(rows.length>5000)throw new Problem(422,'VALIDATION_FAILED','Performance grouping exceeds 5000 rows; narrow the filter');
 const countKeys=['span_count','run_count','completed_count','timed_count','running_count','failed_count','missing_duration_count'];
 return {schema_version:1,captured_at:iso((await c.query('SELECT now() captured_at')).rows[0].captured_at)!,audit_id:auditId,
  scope:{from:filters.from??null,to:filters.to??null,filters,full_filtered_scope:true},
  coverage:await coverage(c,scope.run,scope.span,scope.args),
  items:rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,countKeys.includes(k)?n(v):v])) as any)};
}
