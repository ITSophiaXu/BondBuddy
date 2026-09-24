import { Pool, type PoolClient } from 'pg';
import { date, missing, Problem, run, runDto, transaction, uid, type PrivateBlobs, digest } from './data.js';

const terminal = new Set(['succeeded','failed','cancelled','rejected']);
export type Lease = { jobId:string; runId:string; owner:string; token:string; checkpoint:Record<string,unknown>; attempts:number };

async function event(client:PoolClient, r:any, state:string, stage:string|null, reason:string, errorCode?:string, type='run.state_changed') {
  const seq=r.event_cursor+1, id=uid(), trace=r.id;
  const payload={reason,...(errorCode?{error_code:errorCode}:{})};
  await client.query('UPDATE bb_runs SET state=$2,stage=$3,event_cursor=$4,updated_at=now() WHERE id=$1',[r.id,state,stage,seq]);
  await client.query('INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,r.owner_user_id,r.id,seq,trace,type,state,stage,payload]);
  await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),r.owner_user_id,'run',r.id,type,{run_id:r.id,event_id:id,seq,state,stage,reason,...(errorCode?{error_code:errorCode}:{})}]);
  r.state=state;r.stage=stage;r.event_cursor=seq;
}

export async function enqueue(client:PoolClient, r:any) {
  await client.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,$4,$5,'queued','queued')",[uid(),r.owner_user_id,r.id,r.task_kind,'default']);
  await event(client,{...r,event_cursor:0},'queued','queued','submitted');
}

export async function claim(pool:Pool, leaseSeconds=30):Promise<Lease|null> {
  return transaction(pool,async client=>{
    // Lock order is run then job in every transition, including cancellation.
    const q=await client.query("SELECT r.* FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND r.state NOT IN ('cancelled','failed','succeeded','rejected') ORDER BY j.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1");
    const r=q.rows[0];if(!r)return null;
    const j=(await client.query('SELECT * FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[r.id])).rows[0];
    if(j.state==='running' && new Date(j.lease_until).getTime()>=Date.now())return null;
    const pending=await client.query("SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1 AND status IN ('pending_reconcile','completed','failed') LIMIT 1",[j.id]);
    if(pending.rowCount){
      await client.query("UPDATE bb_jobs SET state='paused',stage='provider_reconcile',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[j.id]);
      await event(client,r,'paused','provider_reconcile','unknown_provider_call');
      return null;
    }
    const token=uid();
    await client.query("UPDATE bb_jobs SET state='running',stage=COALESCE(stage,'claimed'),lease_token=$2,lease_until=now()+($3::integer * interval '1 second'),attempts=attempts+1,updated_at=now() WHERE id=$1",[j.id,token,leaseSeconds]);
    await event(client,r,'running',j.stage ?? 'claimed',j.state==='running'?'lease_recovered':'claimed');
    return {jobId:j.id,runId:r.id,owner:r.owner_user_id,token,checkpoint:j.checkpoint,attempts:j.attempts+1};
  });
}

async function lockedLease(client:PoolClient, lease:Lease) {
  const r=await run(client,lease.owner,lease.runId,true);
  const j=(await client.query('SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 FOR UPDATE',[lease.jobId,lease.owner,lease.runId])).rows[0];
  if(!j || j.lease_token!==lease.token || j.state!=='running' || new Date(j.lease_until).getTime()<=Date.now() || terminal.has(r.state)) throw new Problem(409,'ALREADY_TERMINAL','Lease is no longer active');
  return {r,j};
}

export async function renew(pool:Pool, lease:Lease, leaseSeconds=30) {
  await transaction(pool,async client=>{await lockedLease(client,lease);await client.query("UPDATE bb_jobs SET lease_until=now()+($2::integer * interval '1 second'),updated_at=now() WHERE id=$1",[lease.jobId,leaseSeconds]);});
}

export async function checkpoint(pool:Pool, lease:Lease, stage:string, value:Record<string,unknown>) {
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    await client.query('UPDATE bb_jobs SET checkpoint=$2,stage=$3,updated_at=now() WHERE id=$1',[lease.jobId,value,stage]);
    await event(client,r,'running',stage,'checkpoint_saved',undefined,'run.progress');
  });
}

// Persist intent before any supplier request. An unknown attempt is never silently resent.
export async function recordPotentialCall(pool:Pool, lease:Lease, logicalCallId:string, attemptNo:number) {
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    await client.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,$4,$5,'pending_reconcile')",[uid(),lease.owner,lease.jobId,logicalCallId,attemptNo]);
    await event(client,r,'running','provider_call','provider_call_may_be_sent');
  });
}

export async function resolvePotentialCall(pool:Pool, lease:Lease, logicalCallId:string, attemptNo:number, status:'confirmed_not_sent'|'completed'|'failed', providerRequestId?:string) {
  if(status!=='confirmed_not_sent')throw new Problem(409,'CAPABILITY_NOT_READY','Completed or failed supplier calls need a durable result before reconciliation');
  await transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    const q=await client.query("UPDATE bb_model_call_attempts SET status=$5,provider_request_id=$6,updated_at=now() WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4 AND status='pending_reconcile' RETURNING id",[lease.owner,lease.jobId,logicalCallId,attemptNo,status,providerRequestId??null]);
    if(!q.rowCount)throw missing();
    await event(client,r,'running','provider_call','provider_call_reconciled');
  });
}

// Trusted provider adapter calls this only after checking the actual supplier request.
// It cannot be invoked through the public API or by a client-supplied claim.
export async function reconcilePausedCall(pool:Pool, owner:string, runId:string, logicalCallId:string, attemptNo:number, status:'confirmed_not_sent'|'completed'|'failed', providerRequestId?:string) {
  if(status!=='confirmed_not_sent')throw new Problem(409,'CAPABILITY_NOT_READY','Completed or failed supplier calls need a durable result before reconciliation');
  await transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j || r.state!=='paused' || j.state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not awaiting reconciliation');
    const q=await client.query("UPDATE bb_model_call_attempts SET status=$5,provider_request_id=$6,updated_at=now() WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4 AND status='pending_reconcile' RETURNING id",[owner,j.id,logicalCallId,attemptNo,status,providerRequestId??null]);
    if(!q.rowCount)throw missing();
    await event(client,r,'paused','provider_reconcile','provider_call_reconciled');
  });
}

export async function action(pool:Pool,owner:string,runId:string,kind:'cancel'|'resume') {
  return transaction(pool,async client=>{
    const r=await run(client,owner,runId,true);
    const j=(await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
    if(!j)throw missing();
    if(terminal.has(r.state))throw new Problem(409,'ALREADY_TERMINAL','Run already finished');
    if(kind==='resume'){
      if(r.state!=='paused')throw new Problem(409,'INPUT_REVISION_CONFLICT','Run is not paused');
      const p=await client.query("SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1 AND status IN ('pending_reconcile','completed','failed') LIMIT 1",[j.id]);
      if(p.rowCount)throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[j.id,kind==='cancel'?'cancelled':'queued',kind==='cancel'?'cancelled':'queued']);
    await event(client,r,kind==='cancel'?'cancelled':'queued',kind==='cancel'?'cancelled':'queued',kind==='cancel'?'user_cancelled':'user_resumed');
    return runDto({...r,updated_at:new Date()});
  });
}

export async function finish(pool:Pool,lease:Lease,outcome:'failed'|'succeeded',options:{errorCode?:string;artifactId?:string;artifactVersion?:number;blobs?:PrivateBlobs}={}) {
  // Verify bytes before the terminal transaction; re-check immutable metadata inside it.
  let artifact:any;
  if(outcome==='succeeded'){
    if(!options.artifactId || !options.artifactVersion || !options.blobs)throw new Problem(422,'DELIVERY_FAILED','Verified Word artifact required');
    const q=await pool.query("SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=$3 AND version=$4 AND media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND quality_status='passed' AND delivery_status='available'",[lease.owner,lease.runId,options.artifactId,options.artifactVersion]);
    artifact=q.rows[0];if(!artifact)throw new Problem(422,'DELIVERY_FAILED','Passed Word artifact unavailable');
    const bytes=await options.blobs.get(artifact.object_key);
    if(digest(bytes)!==artifact.sha256.trim())throw new Problem(422,'DELIVERY_FAILED','Word artifact hash mismatch');
  }
  return transaction(pool,async client=>{
    const {r}=await lockedLease(client,lease);
    const pending=await client.query("SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1 AND status IN ('pending_reconcile','completed','failed') LIMIT 1",[lease.jobId]);
    if(pending.rowCount)throw new Problem(409,'CAPABILITY_NOT_READY','Provider call needs reconciliation');
    if(outcome==='succeeded'){
      const q=await client.query("SELECT 1 FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 AND id=$3 AND version=$4 AND object_key=$5 AND sha256=$6 AND quality_status='passed' AND delivery_status='available' FOR UPDATE",[lease.owner,lease.runId,artifact.id,artifact.version,artifact.object_key,artifact.sha256]);
      if(!q.rowCount)throw new Problem(422,'DELIVERY_FAILED','Word artifact changed');
      await client.query('UPDATE bb_runs SET artifact_id=$2,artifact_version=$3 WHERE id=$1',[r.id,artifact.id,artifact.version]);
    }
    await client.query('UPDATE bb_jobs SET state=$2,stage=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',[lease.jobId,outcome]);
    await event(client,r,outcome,outcome,outcome==='failed'?'processor_failed':'word_delivered',options.errorCode);
    return runDto({...r,artifact_id:artifact?.id??null,updated_at:new Date()});
  });
}

export async function jobSnapshot(pool:Pool,owner:string,runId:string) {
  const q=await pool.query('SELECT j.id,j.state,j.stage,j.checkpoint,j.attempts,j.lease_until FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE r.owner_user_id=$1 AND r.id=$2',[owner,runId]);
  if(!q.rows[0])throw missing();return {...q.rows[0],lease_until:q.rows[0].lease_until?date(q.rows[0].lease_until):null};
}
