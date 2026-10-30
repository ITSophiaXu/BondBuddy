import type {Pool,PoolClient} from 'pg';
import {int64} from '@bondbuddy/contracts';
import {auditCreditClient,auditCredits,type CreditAudit} from './billing-audit.js';
import {requireBillingPermission} from './billing-permissions.js';
import {inputManifestHash,canonicalInputManifest} from './production-rule-pin.js';
import {missing,Problem,transaction,uid} from './data.js';

export type BillingWalletScope={kind:'wallet';owner:string};
export type BillingChannelScope={kind:'channel';provider:'wechat'|'alipay';merchantId:string};
export type BillingSafetyScope=BillingWalletScope|BillingChannelScope;
export type ChannelSafetyVerification={status:'verified';evidenceIds:string[];differences:Record<string,unknown>[]}
  |{status:'unknown';reason:string};
/** Trusted implementation only. It must authenticate channel evidence and compare
 * current committed state in c; a timeout, missing evidence or partial coverage
 * returns unknown. A plain {consistent:true} is deliberately not accepted. */
export type ChannelSafetyVerifier=(c:PoolClient,scope:BillingChannelScope)=>Promise<ChannelSafetyVerification>;
export type BillingSafetyResult={status:'healthy'|'isolated'|'already_isolated'|'unverified';scope:BillingSafetyScope;incidentId?:string};
type Verification={status:'verified';differences:Record<string,unknown>[];evidence:Record<string,unknown>}
  |{status:'unknown';reason:string;evidence:Record<string,unknown>};
type PrivilegedInput={requestId:string;actor:string;reason:string};
export type BillingResumeResult={status:'resumed'|'still_isolated'|'unverified';incidentId:string;eventId:string};
export type BillingProjectionRepairResult={status:'repaired'|'rejected';incidentId:string;eventId:string;auditHash:string;reason?:string};

const validText=(value:unknown,max=200):value is string=>typeof value==='string'&&value.length<=max&&value.trim().length>0&&!value.includes('\0');
const invalid=()=>new Problem(422,'VALIDATION_FAILED','Original billing safety request, scope, actor and reason are required');
function checkScope(scope:BillingSafetyScope){
  if(!scope||(scope.kind==='wallet'?!validText(scope.owner):scope.kind!=='channel'||!['wechat','alipay'].includes(scope.provider)||!validText(scope.merchantId)))throw invalid();
}
export function billingSafetyScopeKey(scope:BillingSafetyScope){checkScope(scope);return scope.kind==='wallet'?`wallet:${scope.owner}`:`channel:${scope.provider}:${scope.merchantId}`;}
function checkPrivileged(input:PrivilegedInput){if(!validText(input.requestId,128)||!validText(input.actor)||!validText(input.reason,2000))throw invalid();}
async function lockScope(c:PoolClient,scope:BillingSafetyScope,shared:boolean){
  await c.query(`SELECT ${shared?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock'}(hashtextextended($1,0))`,[`billing-safety:${billingSafetyScopeKey(scope)}`]);
}
async function activeBlock(c:PoolClient,scope:BillingSafetyScope){return(await c.query('SELECT incident_id FROM bb_billing_safety_blocks WHERE scope_key=$1 AND resume_event_id IS NULL',[billingSafetyScopeKey(scope)])).rows[0] as {incident_id:string}|undefined;}
/** Call first in a write transaction, before the original credit-account lock.
 * Do not call for balance/order reads or when querying an existing channel order. */
export async function assertWalletWritable(c:PoolClient,owner:string){return assertWritable(c,{kind:'wallet',owner});}
export async function assertChannelWritable(c:PoolClient,provider:string,merchantId:string){return assertWritable(c,{kind:'channel',provider:provider as BillingChannelScope['provider'],merchantId});}
/** Cancelling renewal or closing an unpaid checkout must remain possible while
 * isolated. This helper locks against repair without granting a money write. */
export async function lockWalletSafetyForControl(c:PoolClient,owner:string){await lockScope(c,{kind:'wallet',owner},true);}
/** The original intent must already be committed. work contains only the external
 * create/charge/recoverSameRequest; apply its receipt after this function returns.
 * Opening another same-scope money transaction inside work can deadlock against
 * a queued isolation writer, so the transaction client is deliberately hidden. */
export async function withBillingDispatch<T>(pool:Pool,owner:string,provider:string,merchantId:string,work:()=>Promise<T>):Promise<T>{
  return transaction(pool,async c=>{
    await assertChannelWritable(c,provider,merchantId);await assertWalletWritable(c,owner);return work();
  });
}
async function assertWritable(c:PoolClient,scope:BillingSafetyScope){
  await lockScope(c,scope,true);
  if(await activeBlock(c,scope))throw new Problem(409,'BILLING_NOT_READY',scope.kind==='wallet'?'余额正在核对，暂不能扣费或入账；原订单和任务仍可查看。':'支付渠道正在核对，暂不能发起新的资金操作；原订单仍可查询。');
}
function invariantEvidence(report:CreditAudit){
  const ordered=(rows:Record<string,unknown>[])=>[...rows].sort((a,b)=>canonicalInputManifest(a).localeCompare(canonicalInputManifest(b)));
  return{lotDrift:ordered(report.lotDrift),reservationDrift:ordered(report.reservationDrift),paymentDrift:ordered(report.paymentDrift),refundDrift:ordered(report.refundDrift)};
}
/** Stable review token over exact invariant observations; held-task age is not a fault. */
export const billingAuditHash=(report:CreditAudit)=>inputManifestHash(invariantEvidence(report));
const allDifferences=(report:CreditAudit)=>Object.entries(invariantEvidence(report)).flatMap(([kind,rows])=>rows.map(row=>({kind,...row})));
async function verify(c:PoolClient,scope:BillingSafetyScope,channel?:ChannelSafetyVerifier,requireChannelEvidence=false):Promise<Verification>{
  const report=await auditCreditClient(c,scope.kind==='wallet'?scope.owner:undefined);
  if(scope.kind==='wallet')return{status:'verified',differences:allDifferences(report),evidence:invariantEvidence(report)};
  const local=[...report.paymentDrift.map(row=>({kind:'paymentDrift',...row})),...report.refundDrift.map(row=>({kind:'refundDrift',...row}))]
    .filter(row=>row.provider===scope.provider&&row.merchant_id===scope.merchantId);
  // An actual local cash/credit mismatch is sufficient to isolate. Missing remote
  // evidence is not a new invariant violation and can never clear an old one.
  if(local.length)return{status:'verified',differences:local,evidence:{local}};
  if(!channel)return requireChannelEvidence?{status:'unknown',reason:'channel_verifier_required',evidence:{local}}:{status:'verified',differences:[],evidence:{local}};
  const remote=await channel(c,scope);
  if(remote?.status!=='verified')return{status:'unknown',reason:remote?.status==='unknown'?remote.reason:'invalid_channel_verification',evidence:{local}};
  if(!Array.isArray(remote.evidenceIds)||!remote.evidenceIds.length||!remote.evidenceIds.every(id=>validText(id,256))||!Array.isArray(remote.differences))
    return{status:'unknown',reason:'authenticated_channel_evidence_required',evidence:{local}};
  return{status:'verified',differences:remote.differences,evidence:{local,channel:remote}};
}
async function appendEvent(c:PoolClient,input:{id:string;incidentId:string;operation:string;actor:string;grantId?:string;requestId:string;requestHash:string;reason:string;evidence:unknown;result:unknown}){
  await c.query(`INSERT INTO bb_billing_safety_audit(id,incident_id,operation,actor,authority_grant_id,request_id,request_hash,reason,evidence,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,[input.id,input.incidentId,input.operation,input.actor,input.grantId??null,input.requestId,input.requestHash,input.reason,JSON.stringify(input.evidence),JSON.stringify(input.result)]);
}
/** Must be called outside a money-write transaction. The exclusive scope lock
 * waits for writers; READ COMMITTED rechecks after waiting. Its durable incident
 * survives rollback of the original business request. Unknown errors propagate. */
export async function inspectAndIsolateBillingScope(pool:Pool,scope:BillingSafetyScope,channel?:ChannelSafetyVerifier):Promise<BillingSafetyResult>{
  checkScope(scope);
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await lockScope(c,scope,false);
    const block=await activeBlock(c,scope);if(block)return{status:'already_isolated',scope,incidentId:block.incident_id};
    const checked=await verify(c,scope,channel);
    if(checked.status==='unknown')return{status:'unverified',scope};
    if(!checked.differences.length)return{status:'healthy',scope};
    const id=uid(),eventId=uid(),requestId=uid();
    await c.query(`INSERT INTO bb_billing_safety_incidents(id,scope_kind,owner_user_id,provider,merchant_id,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [id,scope.kind,scope.kind==='wallet'?scope.owner:null,scope.kind==='channel'?scope.provider:null,scope.kind==='channel'?scope.merchantId:null,JSON.stringify(checked.evidence)]);
    const result:BillingSafetyResult={status:'isolated',scope,incidentId:id};
    await appendEvent(c,{id:eventId,incidentId:id,operation:'isolated',actor:'system',requestId,requestHash:inputManifestHash({scope,evidence:checked.evidence}),reason:'Committed billing invariant mismatch',evidence:checked.evidence,result});
    await c.query('INSERT INTO bb_billing_safety_blocks(incident_id,scope_key) VALUES($1,$2)',[id,billingSafetyScopeKey(scope)]);
    return result;
  });
}

/** Schedule in the existing recovery tick, before admitting new recovery money
 * writes. This function installs no timer and starts no provider/model request.
 * A complete initial snapshot identifies candidates; each is checked again under
 * its own exclusive lock. Already active scopes do not consume the batch limit. */
export async function scanAndIsolateBilling(pool:Pool,options:{limit?:number;channels?:BillingChannelScope[];verifyChannel?:ChannelSafetyVerifier}={}){
  const limit=options.limit??100;if(!Number.isInteger(limit)||limit<1||limit>1000)throw invalid();
  const report=await auditCredits(pool),candidates=new Map<string,BillingSafetyScope>();
  for(const row of [...report.lotDrift,...report.reservationDrift,...report.paymentDrift,...report.refundDrift]){
    const scope:BillingWalletScope={kind:'wallet',owner:row.owner_user_id};candidates.set(billingSafetyScopeKey(scope),scope);
  }
  for(const row of [...report.paymentDrift,...report.refundDrift]){
    const scope:BillingChannelScope={kind:'channel',provider:row.provider,merchantId:row.merchant_id};candidates.set(billingSafetyScopeKey(scope),scope);
  }
  for(const scope of options.channels??[])candidates.set(billingSafetyScopeKey(scope),scope);
  const active=new Set((await pool.query('SELECT scope_key FROM bb_billing_safety_blocks WHERE resume_event_id IS NULL')).rows.map(row=>row.scope_key));
  const selected=[...candidates.entries()].filter(([key])=>!active.has(key));
  const results:BillingSafetyResult[]=[],errors:{scope:BillingSafetyScope;code:'AUDIT_UNAVAILABLE'}[]=[];
  for(const [,scope] of selected.slice(0,limit)){
    try{results.push(await inspectAndIsolateBillingScope(pool,scope,options.verifyChannel));}
    catch{errors.push({scope,code:'AUDIT_UNAVAILABLE'});} // Unknown/database errors are not invariant failures.
  }
  return{consistent:report.consistent&&active.size===0&&results.every(result=>result.status==='healthy')&&errors.length===0,candidates:candidates.size,deferred:Math.max(0,selected.length-limit),results,errors};
}

async function privilegedRequest(c:PoolClient,input:PrivilegedInput,hash:string){
  const grantId=await requireBillingPermission(c,input.actor,'billing_repair');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`billing-safety-request:${input.requestId}`]);
  const prior=(await c.query('SELECT request_hash,result FROM bb_billing_safety_audit WHERE request_id=$1',[input.requestId])).rows[0];
  if(prior&&prior.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Billing safety request conflicts with its original record');
  return{grantId,prior};
}
/** Explicit independent authority only. A failed recheck is persisted and leaves
 * the same block active. No timer or repair automatically calls this function. */
export async function resumeBillingScope(pool:Pool,input:PrivilegedInput&{scope:BillingSafetyScope},channel?:ChannelSafetyVerifier):Promise<BillingResumeResult>{
  checkPrivileged(input);checkScope(input.scope);const hash=inputManifestHash({operation:'resume',...input});
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const {grantId,prior}=await privilegedRequest(c,input,hash);if(prior)return prior.result as BillingResumeResult;
    await lockScope(c,input.scope,false);const block=await activeBlock(c,input.scope);if(!block)throw missing();
    const checked=await verify(c,input.scope,channel,true),eventId=uid();
    const status=checked.status==='unknown'?'unverified':checked.differences.length?'still_isolated':'resumed';
    const result:BillingResumeResult={status,incidentId:block.incident_id,eventId};
    await appendEvent(c,{id:eventId,incidentId:block.incident_id,operation:status==='resumed'?'resumed':'recheck_failed',actor:input.actor,grantId,requestId:input.requestId,requestHash:hash,reason:input.reason,evidence:checked,result});
    if(status==='resumed')await c.query('UPDATE bb_billing_safety_blocks SET resume_event_id=$2 WHERE incident_id=$1',[block.incident_id,eventId]);
    return result;
  });
}

/** Trusted repair interface: targets are derived solely from the immutable
 * ledger. No caller supplied balance or SQL is accepted. A successful repair
 * still leaves isolation active until a separate authorized resumption. */
export async function repairWalletProjection(pool:Pool,input:PrivilegedInput&{owner:string;expectedAuditHash:string}):Promise<BillingProjectionRepairResult>{
  checkPrivileged(input);const scope:BillingWalletScope={kind:'wallet',owner:input.owner};checkScope(scope);
  if(!/^[a-f0-9]{64}$/.test(input.expectedAuditHash))throw invalid();const hash=inputManifestHash({operation:'repair_projection',...input});
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const {grantId,prior}=await privilegedRequest(c,input,hash);if(prior)return prior.result as BillingProjectionRepairResult;
    await lockScope(c,scope,false);const block=await activeBlock(c,scope);if(!block)throw missing();
    // Safety lock comes before the same original wallet row used by money writers.
    await c.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE',[input.owner]);
    const before=await auditCreditClient(c,input.owner),beforeHash=billingAuditHash(before),eventId=uid();
    let reason:string|undefined;
    if(beforeHash!==input.expectedAuditHash)reason='audit_changed';
    else if(before.reservationDrift.length||before.paymentDrift.length||before.refundDrift.length)reason='non_projection_difference';
    else if(!before.lotDrift.length)reason='no_projection_difference';
    const changes:{lotId:string;remaining:string;frozen:string}[]=[];
    if(!reason){
      const lots=(await c.query('SELECT id,original_points::text,remaining::text FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id FOR UPDATE',[input.owner])).rows;
      const originals=new Map(lots.map(row=>[row.id,row.original_points]));
      for(const row of before.lotDrift){
        try{
          const remaining=int64(row.expected_remaining),frozen=int64(row.expected_frozen),original=int64(originals.get(row.id));
          if(frozen>remaining||remaining>original)throw Error('Invalid projection');
          changes.push({lotId:row.id,remaining:remaining.toString(),frozen:frozen.toString()});
        }catch{reason='derived_projection_out_of_range';break;}
      }
      if(!reason){
        const target=new Map(changes.map(change=>[change.lotId,change.remaining]));
        try{int64(lots.reduce((total,row)=>total+int64(target.get(row.id)??row.remaining),0n));}
        catch{reason='derived_account_out_of_range';}
      }
    }
    let after=before;
    if(!reason){
      await c.query('SAVEPOINT billing_projection_repair');
      try{
        for(const change of changes)await c.query('UPDATE bb_credit_lots SET remaining=$3,frozen=$4 WHERE owner_user_id=$1 AND id=$2',[input.owner,change.lotId,change.remaining,change.frozen]);
        after=await auditCreditClient(c,input.owner);
        if(!after.consistent){await c.query('ROLLBACK TO SAVEPOINT billing_projection_repair');reason='repair_did_not_reconcile';after=before;}
        await c.query('RELEASE SAVEPOINT billing_projection_repair');
      }catch(error){await c.query('ROLLBACK TO SAVEPOINT billing_projection_repair');await c.query('RELEASE SAVEPOINT billing_projection_repair');throw error;}
    }
    const result:BillingProjectionRepairResult={status:reason?'rejected':'repaired',incidentId:block.incident_id,eventId,auditHash:billingAuditHash(after),...(reason?{reason}:{})};
    await appendEvent(c,{id:eventId,incidentId:block.incident_id,operation:reason?'repair_rejected':'projection_repaired',actor:input.actor,grantId,requestId:input.requestId,requestHash:hash,reason:input.reason,evidence:{before:invariantEvidence(before),after:invariantEvidence(after),changes:reason?[]:changes,rejection:reason??null},result});
    return result;
  });
}
