import {ZERO,add,ratio,unsignedInteger,type IntegerInput} from './commerce-economics-math.js';

export type LotFundingEvidence={funding_source_id:string;kind:'new_cash'|'transfer';source_order_id:string;source_lot_id:string|null;
 point_numerator:string;point_denominator:string;source_point_numerator:string;source_point_denominator:string;
 amount_numerator:string;amount_denominator:string;contract_points:string;cash_amount_fen:string|null};

/** Read-only provenance, also attached to returned lots. Points are counted once
 * per wallet allocation; these components split consideration, never points. */
export function lotFundingEvidenceSql(lot='l'){return `COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'funding_source_id',f.funding_source_id,'kind',s.kind,'source_order_id',s.source_order_id,'source_lot_id',s.source_lot_id,
 'point_numerator',f.point_numerator::text,'point_denominator',f.point_denominator::text,
 'source_point_numerator',s.point_numerator::text,'source_point_denominator',s.point_denominator::text,
 'amount_numerator',s.amount_numerator::text,'amount_denominator',s.amount_denominator::text,
 'contract_points',p.points::text,'cash_amount_fen',proof.cash_amount_fen::text) ORDER BY f.funding_source_id)
 FROM bb_subscription_lot_funding f
 LEFT JOIN bb_subscription_funding_sources s ON s.id=f.funding_source_id AND s.owner_user_id=f.owner_user_id
 LEFT JOIN bb_subscription_periods p ON p.id=s.period_id AND p.owner_user_id=s.owner_user_id
 LEFT JOIN bb_payment_cash_proofs proof ON proof.order_id=s.source_order_id AND proof.owner_user_id=s.owner_user_id
 WHERE f.lot_id=${lot}.id AND f.owner_user_id=${lot}.owner_user_id),'[]'::jsonb)`;}

/** Exact rational comparison avoids rounding each funding component before
 * checking the sum. Missing or inconsistent evidence must remain unknown. */
export function lotFundingMatches(input:{required?:boolean;funding?:LotFundingEvidence[];numerator:IntegerInput|null;denominator:IntegerInput|null}):boolean{
 const rows=input.funding??[];if(!input.required&&!rows.length)return true;
 if(!rows.length)return false;
 try{
  const expected=ratio(unsignedInteger(input.numerator),unsignedInteger(input.denominator));
  let total=ZERO;const ids=new Set<string>();
  for(const row of rows){
   if(!row.funding_source_id||ids.has(row.funding_source_id)||!row.source_order_id||!['new_cash','transfer'].includes(row.kind))return false;
   ids.add(row.funding_source_id);
   const point=ratio(unsignedInteger(row.point_numerator),unsignedInteger(row.point_denominator));
   const sourcePoint=ratio(unsignedInteger(row.source_point_numerator),unsignedInteger(row.source_point_denominator));
   const amount=ratio(unsignedInteger(row.amount_numerator),unsignedInteger(row.amount_denominator));
   const contractPoints=unsignedInteger(row.contract_points),cash=unsignedInteger(row.cash_amount_fen);
   if(!contractPoints||point.numerator<=0n||point.numerator!==sourcePoint.numerator||point.denominator!==sourcePoint.denominator)return false;
   if(point.numerator*contractPoints*amount.denominator!==amount.numerator*point.denominator)return false;
   if(amount.numerator>cash*amount.denominator)return false;
   if(row.kind==='new_cash'&&(row.source_lot_id!==null||amount.numerator!==cash*amount.denominator))return false;
   if(row.kind==='transfer'&&!row.source_lot_id)return false;
   total=add(total,point);
  }
  return total.numerator===expected.numerator&&total.denominator===expected.denominator;
 }catch{return false;}
}

/** Both statement adapters use the same issued-rights check. This leaves the
 * channel's full order/cash/refund comparisons unchanged. */
export const subscriptionIssuanceMatchesSql=`
 sp.id IS NOT NULL AND sp.status IN ('active','refunded','superseded') AND sp.lot_id=l.id AND sp.points=o.points AND sp.amount_fen=o.amount_fen
 AND l.source='subscription' AND l.expires_at=sp.credits_expires_at AND l.cash_origin_lot_id=l.id
 AND (sp.funding_kind='cash' AND l.cash_order_id=o.id AND l.cash_basis_points=sp.monthly_points
   AND l.cash_basis_fen=sp.amount_fen/CASE sp.billing_cycle WHEN 'annual' THEN 12 ELSE 1 END
  OR sp.funding_kind='mixed' AND l.cash_order_id IS NULL
   AND l.cash_basis_fen=sp.consideration_numerator AND l.cash_basis_points=sp.consideration_denominator)
 AND (sp.billing_cycle='monthly' OR EXISTS(SELECT 1 FROM bb_subscription_credit_releases initial
   WHERE initial.period_id=sp.id AND initial.owner_user_id=o.owner_user_id AND initial.installment_index=1
    AND initial.state='issued' AND initial.lot_id=l.id AND initial.points=sp.monthly_points
    AND initial.amount_fen=floor(o.amount_fen::numeric/12)))`;
