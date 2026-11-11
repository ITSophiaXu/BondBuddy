import type {PoolClient} from 'pg';
import {digest,Problem} from './data.js';

export type BillingRequestIdentity={owner:string;kind:'integrity'|'refund';requestId:string;resourceId:string;hash:string};
export type BillingRequestRejection={reason_code:'QUOTE_CHANGED'|'QUOTE_REQUIRED'|'BILLING_PROTOCOL_REPLAY_ONLY';message:string};

/** Preserve the original amount-request hash and the distinct points unit. */
export function refundRequestHash(orderId:string,request:{amount_fen?:number;points?:number;expected_amount_fen?:number}){
  return digest(JSON.stringify(Object.hasOwn(request,'amount_fen')?[orderId,request.amount_fen]:[orderId,'points',request.points,...(request.expected_amount_fen===undefined?[]:[request.expected_amount_fen])]));
}

/** Caller holds the same project/account and request locks as acceptance, and
 * has already looked up an accepted receipt using the original immutable hash. */
export async function readBillingRequestRejection(c:PoolClient,key:BillingRequestIdentity):Promise<BillingRequestRejection|undefined>{
  const row=(await c.query('SELECT resource_id,request_hash,reason_code,message FROM bb_billing_request_rejections WHERE owner_user_id=$1 AND kind=$2 AND request_id=$3',[key.owner,key.kind,key.requestId])).rows[0];
  if(!row)return undefined;
  if(row.resource_id!==key.resourceId||row.request_hash!==key.hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','原请求编号已用于另一项请求，请保留原请求核对。');
  return {reason_code:row.reason_code,message:row.message};
}

/** Return the receipt from the transaction; throw only after it has committed. */
export async function recordBillingRequestRejection(c:PoolClient,key:BillingRequestIdentity,rejection:BillingRequestRejection):Promise<BillingRequestRejection>{
  const prior=await readBillingRequestRejection(c,key);if(prior)return prior;
  await c.query('INSERT INTO bb_billing_request_rejections(owner_user_id,kind,request_id,resource_id,request_hash,reason_code,message) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [key.owner,key.kind,key.requestId,key.resourceId,key.hash,rejection.reason_code,rejection.message]);
  return rejection;
}

export function billingRequestRejectedProblem(rejection:BillingRequestRejection){
  return new Problem(409,'BILLING_REQUEST_REJECTED',rejection.message+' 原请求已确认未受理且已结束，请刷新后重新确认。');
}
