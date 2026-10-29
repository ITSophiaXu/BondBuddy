import {int64,parseYuanToFen,serializeInt64} from '@bondbuddy/contracts';
import type {PaymentRefundEligibility,PaymentRefundRequest} from './billing-types.js';

export function parseRefundInput(value:string,unit:'points'|'amount_fen'):string|null{
 try{
  const input=value.trim();
  if(unit==='points'){
   if(!/^\d{1,7}$/.test(input))return null;
   const points=BigInt(input);return points>=1n&&points<=1_150_000n?serializeInt64(points):null;
  }
  if(!/^(\d{1,5})(?:\.(\d{1,2}))?$/.test(input))return null;
  const fen=int64(parseYuanToFen(input));return fen>=1n&&fen<=1_000_000n?serializeInt64(fen):null;
 }catch{return null;}
}

/** Exact display preview. Server recomputes under the original-order lock. */
export function pointRefundPreview(e:PaymentRefundEligibility,points:string):string|null{
 try{
  if(e.paid_amount_fen===null)return null;
  const A=int64(e.paid_amount_fen),Q=int64(e.original_points),R=int64(e.refunded_points),F=int64(e.refunded_fen),q=int64(points);
  if(Q===0n||A===0n||q<1n||q>1_150_000n||q>int64(e.refundable_points)||R+q>Q||F>A||F!==A*R/Q)return null;
  const cash=A*(R+q)/Q-F;
  return cash<1n||cash>1_000_000n||cash>A-F||cash>int64(e.refundable_fen)?null:serializeInt64(cash);
 }catch{return null;}
}
export function refundRequestCash(request:PaymentRefundRequest):string|undefined{return 'points' in request?request.expected_amount_fen:request.amount_fen;}
