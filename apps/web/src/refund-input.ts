import type {PaymentRefundEligibility,PaymentRefundRequest} from '@bondbuddy/contracts';

export function parseRefundInput(value:string,unit:'points'|'amount_fen'):number|null{
  const input=value.trim();
  if(unit==='points'){
    if(!/^\d{1,7}$/.test(input))return null;
    const points=Number(input);return points>=1&&points<=1_150_000?points:null;
  }
  const match=/^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(input);if(!match)return null;
  const fen=Number(match[1])*100+Number((match[2]??'').padEnd(2,'0'));
  return fen>=1&&fen<=1_000_000?fen:null;
}

/** Display only. The API recomputes against locked original consideration and cumulative refunds. */
export function pointRefundPreview(e:PaymentRefundEligibility,points:number):number|null{
  const values=[e.paid_amount_fen,e.original_points,e.refunded_points,e.refunded_fen,e.refundable_points,e.refundable_fen,points];
  if(values.some(n=>typeof n!=='number'||!Number.isSafeInteger(n)||n<0)||!e.original_points||!e.paid_amount_fen||
    points<1||points>1_150_000||points>e.refundable_points)return null;
  const A=BigInt(e.paid_amount_fen),Q=BigInt(e.original_points),R=BigInt(e.refunded_points),F=BigInt(e.refunded_fen),q=BigInt(points);
  if(R+q>Q||F>A||F!==A*R/Q)return null;
  const cash=A*(R+q)/Q-F;
  if(cash<1n||cash>1_000_000n||cash>A-F||cash>BigInt(e.refundable_fen))return null;
  return Number(cash);
}

export function refundRequestCash(request:PaymentRefundRequest):number|undefined{
  return 'points' in request?request.expected_amount_fen:request.amount_fen;
}
