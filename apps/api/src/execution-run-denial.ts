import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {ExecutionEvidenceReferenceSchema,ExecutionRunDenialArchiveSchema,ExecutionRunBoundDenialArchiveSchema,ExecutionRunAuthorizationRecoverySchema,ExecutionRunAuthorizationCorrectionSchema,ExecutionRunPaymentDenialAuditSchema,type ExecutionEvidenceReference} from '@bondbuddy/contracts';
import {transaction} from './data.js';

/** Supplied by the trusted local control entry, never by a public request. */
export type ExecutionDenialScope={directory:string;accountId:string;region:string;roleId?:string;configurationSha256?:string;paymentAuditSha256?:string;paymentContractSha256?:string;recoveryReviewSha256?:string;correctionEvidenceSha256?:string};
const fail=():never=>{throw Error('EXECUTION_RUN_DENIAL_UNPROVEN');};
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const canonical=(v:any)=>JSON.stringify(sorted(v));

/** Exact bytes, not parse-and-reserialize hashing; no symlink parent or file. */
async function evidence(scope:ExecutionDenialScope|undefined,ref:ExecutionEvidenceReference){
 if(!scope||!isAbsolute(scope.directory)||!Value.Check(ExecutionEvidenceReferenceSchema,ref)||ref.evidence_ref!==join(scope.directory,ref.evidence_sha256+'.json'))fail();
 const directory=scope!.directory;
 const parent=await lstat(directory);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700||await realpath(directory)!==directory)fail();
 const file=await open(ref.evidence_ref,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await file.stat();
  if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.nlink!==1||before.size<1||before.size>131072)fail();
  const bytes=await file.readFile(),after=await file.stat();
  if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||digest(bytes)!==ref.evidence_sha256)fail();
  const path=await lstat(ref.evidence_ref);
  if(path.isSymbolicLink()||path.ino!==after.ino||path.dev!==after.dev)fail();
  return bytes;
 }finally{await file.close();}
}

export async function finalizeExecutionRunDenial(pool:Pool,scope:ExecutionDenialScope|undefined,id:string,revision:number,input:{evidence:ExecutionEvidenceReference;payment_audit:ExecutionEvidenceReference;launch_parameters:Record<string,any>}){
 return transaction(pool,async client=>{
  const policy=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];
  const op=(await client.query('SELECT * FROM bb_execution_cloud_operations WHERE operation_id=$1 FOR UPDATE',[id])).rows[0];
  const bytes=await evidence(scope,input.evidence);let raw:any;try{raw=JSON.parse(bytes.toString('utf8'));}catch{fail();}
  const legacy=Value.Check(ExecutionRunDenialArchiveSchema,raw),bound=Value.Check(ExecutionRunBoundDenialArchiveSchema,raw);
  const p=input.launch_parameters;
  if(!op||(!legacy&&!bound)||op.action!=='run'||op.instance_id||!op.dispatched_at||op.run_acceptance||op.cloud_observation||
     op.account_id!==scope!.accountId||op.region!==scope!.region||op.request?.account_id!==op.account_id||op.request?.region!==op.region||op.request?.epoch!==op.epoch||
     op.request?.instance_id!==null||op.request?.instance_count!==1||digest(canonical(op.request))!==op.request_sha256.trim()||
     op.client_token!==digest(canonical(op.operation_id))||raw.operation_id!==id||raw.client_token_sha256!==digest(op.client_token)||
     !p||p.InstanceCount!==1||p.DryRun!==undefined||p.ClientToken!==op.client_token||
     p.TagSpecification?.length!==1||p.TagSpecification[0].ResourceType!=='instance'||p.TagSpecification[0].Tags?.filter((t:any)=>t.Key==='bondbuddy-create-op').length!==1||p.TagSpecification[0].Tags?.find((t:any)=>t.Key==='bondbuddy-create-op')?.Value!==id||
     digest(canonical(p))!==op.request.launch_manifest_sha256||bound&&(raw.account_id!==op.account_id||raw.region!==op.region||raw.launch_manifest_sha256!==op.request.launch_manifest_sha256))fail();
  if(!scope?.paymentAuditSha256||input.payment_audit?.evidence_sha256!==scope.paymentAuditSha256)fail();
  const auditBytes=await evidence(scope,input.payment_audit);let audit:any;try{audit=JSON.parse(auditBytes.toString('utf8'));}catch{fail();}
  if(!Value.Check(ExecutionRunPaymentDenialAuditSchema,audit)||audit.provider_request_id!==raw.request_id||
     audit.account_id!==op.account_id||audit.region!==op.region||!scope!.roleId||audit.cloud_audit.actor_role_id!==scope!.roleId||
     audit.cloud_audit.error_message_sha256!=='a5a18865ce9c1a95ae855ce4812ab77c6775bb7e21722a1830c908ca6640c20d'||
     !scope!.paymentContractSha256||audit.official_prerequisite.source_html_sha256!==scope!.paymentContractSha256||
     audit.operation_id!==id||audit.original_rejection_archive_sha256!==input.evidence.evidence_sha256||
     audit.client_token_sha256!==raw.client_token_sha256||audit.launch_manifest_sha256!==op.request.launch_manifest_sha256||
     !Number.isFinite(Date.parse(audit.cloud_audit.event_time_utc))||Math.abs(Date.parse(audit.cloud_audit.event_time_utc)-new Date(op.dispatched_at).getTime())>30000)fail();
  const denial={...input.evidence,code:raw.code,provider_request_id:raw.request_id,operation_id:id,account_id:op.account_id,region:op.region,
    client_token_sha256:raw.client_token_sha256,launch_manifest_sha256:op.request.launch_manifest_sha256,archive_binding:legacy?'legacy_operation_token':'bound_v1',payment_audit:input.payment_audit};
  // Replaying the identical original CAS after a concurrent winner is idempotent.
  if(op.authorization_denial){if(op.state!=='rejected'||Number(op.revision)!==revision+1||canonical(op.authorization_denial)!==canonical(denial))fail();return op;}
  if(op.state!=='unknown'||Number(op.revision)!==revision||op.provider_request_id)fail();
  if(policy.launch_blocked_by_operation_id&&policy.launch_blocked_by_operation_id!==id)fail();
  const result=(await client.query("UPDATE bb_execution_cloud_operations SET state='rejected',revision=revision+1,authorization_denial=$2,completed_at=clock_timestamp(),retry_after=NULL WHERE operation_id=$1 RETURNING *",[id,denial])).rows[0];
  // This is not an acceptance ACK. Its RequestId lives only in denial evidence.
  await client.query('UPDATE bb_execution_capacity_policy SET launch_blocked_by_operation_id=$1,revision=revision+1 WHERE singleton',[id]);
  return result;
 });
}

/** Explicit control-side review only; no tick/quote path invokes this method. */
export async function resumeExecutionRunAuthorization(pool:Pool,scope:ExecutionDenialScope|undefined,id:string,revision:number,ref:ExecutionEvidenceReference){
 return transaction(pool,async client=>{
  const p=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];
  const op=(await client.query('SELECT * FROM bb_execution_cloud_operations WHERE operation_id=$1 FOR UPDATE',[id])).rows[0];
  if(!scope?.recoveryReviewSha256||ref.evidence_sha256!==scope.recoveryReviewSha256)fail();
  const bytes=await evidence(scope,ref);let review:any;try{review=JSON.parse(bytes.toString('utf8'));}catch{fail();}
  if(!Value.Check(ExecutionRunAuthorizationRecoverySchema,review)||!op?.authorization_denial||op.state!=='rejected'||review.operation_id!==id||
     review.account_id!==scope!.accountId||review.region!==scope!.region||review.account_id!==op.account_id||review.region!==op.region||review.denial_evidence_sha256!==op.authorization_denial.evidence_sha256)fail();
  if(!scope?.correctionEvidenceSha256||review.correction_evidence.evidence_sha256!==scope.correctionEvidenceSha256)fail();
  const correctionBytes=await evidence(scope,review.correction_evidence);let correction:any;try{correction=JSON.parse(correctionBytes.toString('utf8'));}catch{fail();}
  if(!Value.Check(ExecutionRunAuthorizationCorrectionSchema,correction)||correction.account_id!==op.account_id||correction.region!==op.region||
     !scope?.roleId||correction.role_id!==scope!.roleId||!scope.configurationSha256||correction.configuration_sha256!==scope.configurationSha256||
     digest(canonical(correction.policy_document))!==correction.policy_document_sha256||
     canonical(correction.policy_document)!==canonical({version:'2.0',statement:[{effect:'allow',action:['finance:trade'],resource:['qcs::cvm:::*']}]})||
     correction.previous_policy_ids.includes(correction.policy_id)||!correction.previous_policy_ids.every((id:number)=>correction.attached_policy_ids.includes(id))||
     correction.attached_policy_ids.length!==correction.previous_policy_ids.length+1||!correction.attached_policy_ids.includes(correction.policy_id))fail();
  const stored={...ref,operation_id:id,correction_evidence:review.correction_evidence};
  if(p.launch_blocked_by_operation_id===null&&Number(p.revision)===revision+1&&canonical(p.launch_recovery_review)===canonical(stored))return p;
  if(Number(p.revision)!==revision||p.launch_blocked_by_operation_id!==id)fail();
  return (await client.query('UPDATE bb_execution_capacity_policy SET launch_blocked_by_operation_id=NULL,launch_recovery_review=$1,revision=revision+1 WHERE singleton RETURNING *',[stored])).rows[0];
 });
}
