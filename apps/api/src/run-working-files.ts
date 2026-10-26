import type {Pool,PoolClient} from 'pg';
import {digest,Problem,transaction,type PrivateBlobs} from './data.js';
import type {Lease} from './queue.js';
import {assertRunExecution} from './run-execution.js';
import {assertModelCallExecution} from './model-call-execution.js';
import {validateRunFileReference,extractRunFileReferences,type RunFileReference} from './run-file-reference.js';

export type RunWorkingFileSource={kind:'provider';attemptId:string;resultSchemaVersion:string}
 | {kind:'local_correction'|'local_project_file'|'local_qa'|'local_integrity'|'local_integrity_browser'};
type WriteInput={pool:Pool;blobs:PrivateBlobs;lease:Lease;projectId:string;source:RunWorkingFileSource;
 name:string;key:string;bytes:Buffer;mediaType:string};
type Scope={owner:string;projectId:string;runId:string;jobId:string;executionVersion:number;inputRevision:number;inputHash:string};
const failure=()=>new Problem(409,'INPUT_REVISION_CONFLICT','Working file does not match its retained execution source');
const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const providerSchemas=['codex-file-word-v1','codex-m4-document-v1','codex-review-file-v1','review-revision-cli-v1'];
const localSchemas={local_correction:'codex-review-file-v1',local_project_file:'project-file-output-v1',
 local_qa:'project-qa-result-v1',local_integrity:'integrity-output-v1',local_integrity_browser:'official-browser-v1'} as const;
const schema=(source:RunWorkingFileSource)=>source.kind==='provider'?source.resultSchemaVersion:localSchemas[source.kind];
const workLock=(db:PoolClient,runId:string)=>db.query("SELECT pg_advisory_xact_lock(hashtext('run_work_files'),hashtext($1::text))",[runId]);
const fileLock=(db:PoolClient,key:string)=>db.query("SELECT pg_advisory_xact_lock(hashtext('run_file_object'),hashtext($1::text))",[key]);

async function scope(db:PoolClient,s:Scope,source:RunWorkingFileSource,hidden=false){
 const row=(await db.query(`SELECT r.*,j.state job_state,j.lease_token,j.lease_until,p.deleted_at,u.status user_status,u.closed_at
  FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
  JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id JOIN bb_users u ON u.id=r.owner_user_id
  WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND j.id=$4`,[s.owner,s.projectId,s.runId,s.jobId])).rows[0];
 if(!row||!hidden&&(row.deleted_at||row.closed_at||row.user_status==='closed'))throw failure();
 await assertRunExecution(db,row,s);
 let prompt:string|undefined;
 if(source.kind==='provider'){
  if(!providerSchemas.includes(source.resultSchemaVersion))throw failure();
  prompt=(await assertModelCallExecution(db,{...s,attemptId:source.attemptId})).promptSnapshotRef;
  if(!hidden&&(await db.query(`SELECT 1 FROM bb_log_content_tombstones t WHERE
    (t.content_kind='prompt_snapshot' AND t.content_id=$1) OR (t.content_kind='provider_result' AND EXISTS
      (SELECT 1 FROM bb_provider_result_refs p WHERE p.id=t.content_id AND p.attempt_id=$2))`,[prompt,source.attemptId])).rowCount)throw failure();
 }
 const manifest=(await db.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4',
  [s.owner,s.projectId,s.inputRevision,s.inputHash])).rows[0]?.manifest;
 if(!manifest)throw failure();
 return {row,manifest,prompt};
}

// Acquire relational scope before content locks. Later lifecycle receipts refer
// only to the physical object; they cannot acquire a late run/project FK lock.
async function lockScope(db:PoolClient,s:Scope){
 await db.query('SELECT id FROM bb_users WHERE id=$1 FOR KEY SHARE',[s.owner]);
 await db.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR KEY SHARE',[s.owner,s.projectId]);
 await db.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR KEY SHARE',[s.owner,s.runId]);
 await db.query('SELECT id FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 FOR KEY SHARE',[s.owner,s.jobId]);
}

function reference(s:Scope,source:RunWorkingFileSource,manifest:any,name:string,key:string,sha256:string,byteSize:number,mediaType:string):RunFileReference{
 const base={owner:s.owner,projectId:s.projectId,runId:s.runId,inputHash:s.inputHash};
 if(source.kind==='provider'||source.kind==='local_correction'||source.kind==='local_project_file'){
  if(source.kind==='local_correction'&&manifest.review?.file_delivery?.version!=='review-correction-v2')throw failure();
  if(source.kind==='local_project_file'&&manifest.version!=='project-file-operation-v1')throw failure();
  const ref=validateRunFileReference({scope:source.kind==='provider'?{...base,source:'provider',attemptId:source.attemptId,
    ...(source.resultSchemaVersion==='codex-review-file-v1'?{reviewCorrection:manifest.review?.file_delivery?.version==='review-correction-v2'}:{})}
    :{...base,source:source.kind},resultSchemaVersion:schema(source),name,value:{key,sha256,byte_size:byteSize}});
  if(ref.mediaType!==mediaType)throw failure();return ref;
 }
 const prefix=`owners/${s.owner}/projects/${s.projectId}/runs/${s.runId}/`;
 let expected='',media=DOCX,max=100*1024*1024;
 if(source.kind==='local_qa'&&name==='document.docx'&&manifest.version==='project-qa-v1')expected=`${prefix}qa/${sha256}/${name}`;
 if(source.kind==='local_integrity'&&['company.docx','person.docx'].includes(name)&&manifest.version==='integrity-round-v1')expected=`${prefix}integrity/${sha256}/${name}`;
 if(source.kind==='local_integrity_browser'&&manifest.version==='integrity-round-v1'){
  if(name==='capture.png'){expected=`${prefix}integrity/browser/${sha256}.png`;media='image/png';max=15000000;}
  if(name==='capture.txt'){expected=`${prefix}integrity/browser/${sha256}.txt`;media='text/plain; charset=utf-8';max=500000;}
 }
 if(!expected||expected!==key||mediaType!==media||!Number.isSafeInteger(byteSize)
  ||byteSize<(source.kind==='local_integrity_browser'&&name==='capture.txt'?0:1)||byteSize>max||!/^[a-f0-9]{64}$/.test(sha256))throw failure();
 return {name,key,sha256,byteSize,mediaType};
}

async function register(db:PoolClient,s:Scope,source:RunWorkingFileSource,ref:RunFileReference,createdAt?:Date,discoveredResultId?:string){
 await db.query(`INSERT INTO bb_run_working_objects(object_key,owner_user_id,project_id,run_id,filename,sha256,byte_size,media_type,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now())) ON CONFLICT DO NOTHING`,
 [ref.key,s.owner,s.projectId,s.runId,ref.name,ref.sha256,ref.byteSize,ref.mediaType,createdAt??null]);
 const old=(await db.query('SELECT * FROM bb_run_working_objects WHERE object_key=$1',[ref.key])).rows[0];
 if(!old||old.owner_user_id!==s.owner||old.project_id!==s.projectId||old.run_id!==s.runId||old.filename!==ref.name
  ||old.sha256.trim()!==ref.sha256||Number(old.byte_size)!==ref.byteSize||old.media_type!==ref.mediaType)throw failure();
 await db.query('INSERT INTO bb_run_working_object_state(object_key) VALUES($1) ON CONFLICT DO NOTHING',[ref.key]);
 const state=(await db.query('SELECT * FROM bb_run_working_object_state WHERE object_key=$1 FOR UPDATE',[ref.key])).rows[0];
 if(state.purge_started_at){if(discoveredResultId)return false;throw failure();}
 await db.query(`INSERT INTO bb_run_working_sources(object_key,owner_user_id,project_id,run_id,job_id,execution_version,input_revision,input_hash,
  source_kind,attempt_id,result_schema_version,discovered_result_id,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now())) ON CONFLICT DO NOTHING`,
 [ref.key,s.owner,s.projectId,s.runId,s.jobId,s.executionVersion,s.inputRevision,s.inputHash,source.kind,
  source.kind==='provider'?source.attemptId:null,schema(source),discoveredResultId??null,createdAt??null]);
 return true;
}

/** Commit the exact address before Blob IO, including writes never selected by a final result.
 * Physical objects may have several exact source claims (notably correction files). */
export async function writeRunWorkingFile(input:WriteInput):Promise<void>{
 const {pool,blobs,lease,projectId,source}=input,bytes=Buffer.from(input.bytes);
 const s:Scope={owner:lease.owner,projectId,runId:lease.runId,jobId:lease.jobId,
  executionVersion:lease.executionVersion,inputRevision:lease.inputRevision,inputHash:lease.inputHash};
 const sha256=digest(bytes);let ref!:RunFileReference;
 await transaction(pool,async db=>{
  await lockScope(db,s);const checked=await scope(db,s,source);
  if(source.kind!=='provider'&&(checked.row.job_state!=='running'||checked.row.lease_token!==lease.token
    ||!checked.row.lease_until||new Date(checked.row.lease_until).getTime()<=Date.now()))throw failure();
  ref=reference(s,source,checked.manifest,input.name,input.key,sha256,bytes.length,input.mediaType);
  await workLock(db,s.runId);await fileLock(db,ref.key);await scope(db,s,source);await register(db,s,source,ref);
 });
 await transaction(pool,async db=>{
  await workLock(db,s.runId);await fileLock(db,ref.key);const checked=await scope(db,s,source);
  if(source.kind!=='provider'&&(checked.row.job_state!=='running'||checked.row.lease_token!==lease.token
    ||!checked.row.lease_until||new Date(checked.row.lease_until).getTime()<=Date.now()))throw failure();
  const state=(await db.query('SELECT * FROM bb_run_working_object_state WHERE object_key=$1 FOR UPDATE',[ref.key])).rows[0];
  if(!state||state.purge_started_at)throw failure();
  await blobs.put(ref.key,bytes,ref.mediaType);
  const stored=await blobs.getIfExistsBounded(ref.key,ref.byteSize);
  if(!stored||stored.length!==ref.byteSize||digest(stored)!==ref.sha256)throw failure();
  if(!state.stored_at)await db.query('UPDATE bb_run_working_object_state SET stored_at=now() WHERE object_key=$1',[ref.key]);
 });
}

export type WorkingFileRetentionPolicy={contentRetentionDays:number;deletedProjectPurgeDays?:number;policyVersion?:string;
 batchSize?:number;now?:()=>Date;ownerScope?:string[];runId?:string;afterBlobDelete?:(key:string)=>Promise<void>};

/** Same terminal/account/project windows as provider content; active/paused work is retained. */
export async function purgeRunWorkingFiles(pool:Pool,blobs:PrivateBlobs,policy:WorkingFileRetentionPolicy){
 if(!Number.isInteger(policy.contentRetentionDays)||policy.contentRetentionDays<1
  ||policy.deletedProjectPurgeDays!==undefined&&(!Number.isInteger(policy.deletedProjectPurgeDays)||policy.deletedProjectPurgeDays<0))throw failure();
 const now=policy.now?.()??new Date(),cutoff=new Date(+now-policy.contentRetentionDays*86400000),
  deletedCutoff=policy.deletedProjectPurgeDays===undefined?null:new Date(+now-policy.deletedProjectPurgeDays*86400000);
 const args=[cutoff,deletedCutoff,policy.ownerScope??null,policy.runId??null];
 const dueSql=`SELECT o.object_key,o.run_id,o.owner_user_id,s.purge_started_at,CASE WHEN u.status='closed' OR p.deleted_at<$2 THEN 'user_deleted' ELSE 'retention_expired' END reason
  FROM bb_run_working_objects o JOIN bb_run_working_object_state s ON s.object_key=o.object_key
  JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
  JOIN bb_projects p ON p.owner_user_id=o.owner_user_id AND p.id=o.project_id JOIN bb_users u ON u.id=o.owner_user_id
  WHERE s.purged_at IS NULL AND ($3::text[] IS NULL OR o.owner_user_id=ANY($3)) AND ($4::text IS NULL OR o.run_id=$4)
   AND (s.purge_started_at IS NOT NULL OR u.status='closed' OR p.deleted_at<$2 OR (r.state IN ('succeeded','test_completed','failed','cancelled','rejected')
    AND o.created_at<$1 AND NOT EXISTS(SELECT 1 FROM bb_run_working_sources c WHERE c.object_key=o.object_key AND c.created_at>=$1)))`;
 const due=(await pool.query(`${dueSql} ORDER BY o.created_at,o.object_key LIMIT $5`,[...args,Math.min(500,policy.batchSize??100)])).rows;
 let purged=0,failed=0;
 const inventories=new Map<string,Promise<string[]>>();
 for(const item of due){try{
  // A legacy shared correction key may be referenced by a newer result under
  // another prompt/attempt. Discover every known result before deciding age;
  // this runs outside W/F so each source can take P -> R -> W -> F normally.
  // A committed marker is already final and must remain retryable after its
  // parent bytes have disappeared. Account/project deletion needs no age pin.
  let inventoried:string[]|undefined;
  if(!item.purge_started_at&&item.reason==='retention_expired'){
   let inventory=inventories.get(item.run_id);
   if(!inventory){inventory=inventoryWorkingFilesForRun(pool,blobs,item.owner_user_id,item.run_id);inventories.set(item.run_id,inventory);}
   inventoried=await inventory;
  }
  // A durable purge marker precedes deletion. It permanently rejects late writes,
  // even when the delete or its completion receipt fails and must be retried.
  const marked=await transaction(pool,async db=>{
   await db.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR NO KEY UPDATE',[item.owner_user_id,item.run_id]);
   // Result registration takes this same run row lock. Recheck its ID set
   // under the lock and retry discovery if the set changed in the meantime.
   if(inventoried){
    const current=await runResults(db,item.owner_user_id,item.run_id);
    if(current.length!==inventoried.length||current.some((row,index)=>row.id!==inventoried[index]))throw failure();
   }
   await workLock(db,item.run_id);await fileLock(db,item.object_key);
   const current=(await db.query(`${dueSql} AND o.object_key=$5`,[...args,item.object_key])).rows[0];if(!current)return false;
   await db.query(`UPDATE bb_run_working_object_state SET purge_started_at=COALESCE(purge_started_at,now()),
    purge_reason=COALESCE(purge_reason,$2),policy_version=COALESCE(policy_version,$3) WHERE object_key=$1`,
   [item.object_key,current.reason,policy.policyVersion??'log_retention_v1']);return true;
  });
  if(!marked)continue;
  const deleted=await transaction(pool,async db=>{
   await workLock(db,item.run_id);await fileLock(db,item.object_key);
   const state=(await db.query('SELECT * FROM bb_run_working_object_state WHERE object_key=$1 FOR UPDATE',[item.object_key])).rows[0];
   if(state.purged_at)return false;
   await blobs.delete(item.object_key);await policy.afterBlobDelete?.(item.object_key);
   await db.query('UPDATE bb_run_working_object_state SET purged_at=now() WHERE object_key=$1',[item.object_key]);return true;
  });
  if(deleted)purged++;
 }catch{failed++;}}
 const pending=(await pool.query(`${dueSql} LIMIT 1`,args)).rowCount!==0;
 return {due:due.length,purged,failed,pending};
}

/** Before a known collector JSON/prompt disappears, inventory its exact remaining
 * legacy references. Missing/corrupt provenance is an error, never zero children. */
export async function inventoryWorkingFilesForContent(pool:Pool,blobs:PrivateBlobs,content:{kind:string;id:string}){
 const refs=(await pool.query(`SELECT p.*,b.execution_version,b.input_revision,b.input_hash FROM bb_provider_result_refs p
  LEFT JOIN bb_model_call_execution_bindings b ON b.attempt_id=p.attempt_id
  WHERE ${content.kind==='prompt_snapshot'?'p.prompt_snapshot_ref':'p.id'}=$1 ORDER BY p.id`,[content.id])).rows;
 // A collector may have written registered files but failed before creating any
 // result ref. Its prompt must still wait for those exact orphan files to purge.
 const registered=(await pool.query(`SELECT DISTINCT s.run_id FROM bb_run_working_sources s
  JOIN bb_model_call_execution_bindings b ON b.attempt_id=s.attempt_id AND b.run_id=s.run_id AND b.job_id=s.job_id
  WHERE s.source_kind='provider' AND ${content.kind==='prompt_snapshot'?'b.prompt_snapshot_ref=$1':
    'EXISTS(SELECT 1 FROM bb_provider_result_refs p WHERE p.id=$1 AND p.attempt_id=s.attempt_id)'}`,[content.id])).rows;
 const runs=new Set<string>(registered.map(row=>row.run_id));
 await inventoryResults(pool,blobs,refs);
 for(const result of refs)if(providerSchemas.includes(result.result_schema_version))runs.add(result.run_id);
 return [...runs];
}

async function runResults(db:Pick<Pool,'query'>,owner:string,runId:string){
 return (await db.query(`SELECT p.*,b.execution_version,b.input_revision,b.input_hash FROM bb_provider_result_refs p
  LEFT JOIN bb_model_call_execution_bindings b ON b.attempt_id=p.attempt_id
  WHERE p.owner_user_id=$1 AND p.run_id=$2 AND p.result_schema_version=ANY($3::text[]) ORDER BY p.id`,
 [owner,runId,providerSchemas])).rows;
}

async function inventoryWorkingFilesForRun(pool:Pool,blobs:PrivateBlobs,owner:string,runId:string){
 const refs=await runResults(pool,owner,runId);
 await inventoryResults(pool,blobs,refs);
 return refs.map(result=>result.id as string);
}

async function inventoryResults(pool:Pool,blobs:PrivateBlobs,refs:any[]){
 for(const result of refs){
  if(!providerSchemas.includes(result.result_schema_version))continue;
  if(!result.execution_version||!result.input_revision||!result.input_hash)throw failure();
  const s:Scope={owner:result.owner_user_id,projectId:result.project_id,runId:result.run_id,jobId:result.job_id,
   executionVersion:result.execution_version,inputRevision:result.input_revision,inputHash:result.input_hash.trim()};
  const source:RunWorkingFileSource={kind:'provider',attemptId:result.attempt_id,resultSchemaVersion:result.result_schema_version};
  await transaction(pool,async db=>{
   await lockScope(db,s);const checked=await scope(db,s,source,true);
   await db.query("SELECT pg_advisory_xact_lock(hashtext('prompt_snapshot'),hashtext($1::text))",[result.prompt_snapshot_ref]);
   await db.query("SELECT pg_advisory_xact_lock(hashtext('provider_result'),hashtext($1::text))",[result.id]);
   if((await db.query("SELECT 1 FROM bb_log_content_tombstones WHERE content_kind='provider_result' AND content_id=$1",[result.id])).rowCount)return;
   const bytes=await blobs.getIfExistsBounded(result.result_ref,Number(result.byte_size));
   if(!bytes||bytes.length!==Number(result.byte_size)||digest(bytes)!==result.result_sha256.trim())throw failure();
   let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure();}
   const files=extractRunFileReferences({scope:{owner:s.owner,projectId:s.projectId,runId:s.runId,inputHash:s.inputHash,source:'provider',
    attemptId:source.attemptId,...(source.resultSchemaVersion==='codex-review-file-v1'?{reviewCorrection:checked.manifest.review?.file_delivery?.version==='review-correction-v2'}:{})},
    resultSchemaVersion:source.resultSchemaVersion,value});
   await workLock(db,s.runId);
   for(const ref of files.sort((a,b)=>a.key.localeCompare(b.key))){
    await fileLock(db,ref.key);
    if(!await register(db,s,source,ref,result.created_at,result.id))continue;
    // This records a bounded observation made now, never historical pre-write
    // intent. Missing/corrupt legacy bytes remain unavailable but the address
    // and every exact result claim still survive for eventual cleanup.
    const state=(await db.query('SELECT stored_at FROM bb_run_working_object_state WHERE object_key=$1',[ref.key])).rows[0];
    if(!state.stored_at){
     let raw:Buffer|null=null;try{raw=await blobs.getIfExistsBounded(ref.key,ref.byteSize);}catch{}
     if(raw&&raw.length===ref.byteSize&&digest(raw)===ref.sha256)
      await db.query('UPDATE bb_run_working_object_state SET stored_at=now() WHERE object_key=$1',[ref.key]);
    }
   }
  });
 }
}
