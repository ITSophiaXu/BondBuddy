import {Client, type Pool, type PoolClient} from 'pg';
import type {ModelCallAdmission} from './model-call-budget.js';

// Both the ordinary heartbeat and the independent confirmation fence the same
// immutable entitlement. A confirmed UPDATE is not sufficient if its job/node
// has since lost ownership. Readiness controls new admission; graceful drain
// may lower readiness while an active session still owns its existing job.
// Holders themselves deliberately have no TTL.
const renewSql=`UPDATE bb_model_capacity_holders h SET renewed_at=clock_timestamp()
 WHERE h.token=$1 AND h.host_id=$2 AND h.parent_pid=$3
 AND (h.execution_node_id IS NULL OR EXISTS(
   SELECT 1 FROM bb_execution_nodes n JOIN bb_execution_node_sessions s
     ON s.node_id=n.id AND s.epoch=n.epoch AND s.session_id=h.execution_session_id
   WHERE n.id=h.execution_node_id AND n.epoch=h.execution_node_epoch
     AND n.state IN ('ready','draining') AND s.state='active'))
 AND ($4::text IS NULL OR $4='job' AND h.admission_job_id=$5 AND EXISTS(
   SELECT 1 FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
   WHERE j.id=h.admission_job_id AND j.state='running' AND r.state='running'
     AND j.lease_token=$6 AND j.lease_until>clock_timestamp() AND j.billing_cancel_requested_at IS NULL
     AND (h.execution_node_id IS NULL OR j.execution_node_id=h.execution_node_id
       AND j.execution_node_epoch=h.execution_node_epoch AND j.execution_session_id=h.execution_session_id))
 OR $4='assistant' AND h.admission_message_id=$5 AND EXISTS(
   SELECT 1 FROM bb_review_messages m WHERE m.id=h.admission_message_id AND m.reply_status='running'
     AND m.lease_token::text=$6 AND m.lease_until>clock_timestamp()
     AND (h.execution_node_id IS NULL OR m.execution_node_id=h.execution_node_id
       AND m.execution_node_epoch=h.execution_node_epoch AND m.execution_session_id=h.execution_session_id)))
 RETURNING pg_backend_pid() backend_pid`;

function uncertainty(error:unknown) {
 const e=error as {code?:string;message?:string};
 return e?.message==='Query read timeout'||e?.message==='Connection terminated due to connection timeout'
   ||e?.message==='Connection terminated unexpectedly'||/^08[A-Z0-9]{3}$/.test(e?.code??'')
   ||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOTFOUND','57P01','57P02','57P03'].includes(e?.code??'');
}
const backendPid=(client:unknown)=>Number((client as {processID?:number})?.processID)||null;

/** A fresh transport gets ONE five-second confirmation window, including connect.
 * Destroy the uncertain pooled transport before checking: delayed replies must
 * never be consumed by another command. No holder deletion or new model send. */
export async function renewModelCapacity(input:{sessions:Pool;token:string;host:string;admission?:ModelCallAdmission;
 signal:AbortSignal;scope:string;lastConfirmed:number;eventLoopLagMs:number}) {
 const {sessions,token,host,admission,signal}=input;
 const args=[token,host,process.pid,admission?.kind??null,admission?.id??null,admission?.token??null];
 const started=Date.now();let client:PoolClient|undefined,pid:number|null=null,initial:unknown;
 const transportError=()=>{};
 try {
   signal.throwIfAborted();client=await sessions.connect();client.on('error',transportError);pid=backendPid(client);
   signal.throwIfAborted();
   const result=await client.query(renewSql,args);
   signal.throwIfAborted();
   if(!result.rowCount)throw Error('Model capacity holder lost');
   client.removeListener('error',transportError);client.release();client=undefined;return;
 }catch(error){
   client?.release(true);client=undefined;
   if(signal.aborted||!uncertainty(error))throw error;
   initial=error;
 }
 const queryMs=Date.now()-started,checkStarted=Date.now();
 const fresh=new Client({...sessions.options,application_name:'bondbuddy_model_budget_confirm',
   connectionTimeoutMillis:5000,query_timeout:4500,statement_timeout:4500});
 // Transport failures are reported through the operation, never uncaught events.
 fresh.on('error',()=>{});
 let result='unconfirmed',confirmationPid:number|null=null;
 const abort=()=>{void fresh.end().catch(()=>{});};
 const timer=setTimeout(abort,5000);timer.unref();signal.addEventListener('abort',abort,{once:true});
 try {
   signal.throwIfAborted();await fresh.connect();confirmationPid=backendPid(fresh);signal.throwIfAborted();
   const checked=await fresh.query(renewSql,args);signal.throwIfAborted();
   if(Date.now()-checkStarted>=5000)throw Error('Capacity confirmation deadline exceeded');
   if(!checked.rowCount){result='ownership_lost';throw Error('Model capacity holder lost');}
   result='confirmed';
 }catch(error){
   // Preserve the original timeout class when confirmation is unavailable, but
   // distinguish a definitive loss from an uncertain transport in diagnostics.
   if(result==='ownership_lost'||signal.aborted)throw error;
   throw initial;
 }finally{
   clearTimeout(timer);signal.removeEventListener('abort',abort);await fresh.end().catch(()=>{});
   const e=initial as {code?:string;message?:string};
   const evidence={kind:'model_capacity_confirmation',scope:input.scope,backend_pid:pid,confirmation_backend_pid:confirmationPid,
     request_ms:queryMs,confirmation_ms:Date.now()-checkStarted,last_confirmed_age_ms:Date.now()-input.lastConfirmed,
     last_confirmed_at:new Date(input.lastConfirmed).toISOString(),event_loop_lag_ms:input.eventLoopLagMs,failure_class:e.message==='Query read timeout'?'pg_query_timeout':
       e.message==='Connection terminated due to connection timeout'?'pg_connect_timeout':'pg_transport_error',result};
   try{process.stderr.write(JSON.stringify(evidence)+'\n');}catch{/* evidence cannot change ownership */}
 }
}
