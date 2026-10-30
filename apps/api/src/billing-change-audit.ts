import type {PoolClient} from 'pg';
import {ZERO,add,ratio,type ExactRatio} from './commerce-economics-math.js';

type PaymentDifference={id:string;owner_user_id:string;provider:string;merchant_id:string;state:string;reason:string};
const fraction=(n:unknown,d:unknown)=>ratio(BigInt(String(n)),BigInt(String(d)));
const equal=(a:ExactRatio,b:ExactRatio)=>a.numerator*b.denominator===b.numerator*a.denominator;
const times=(a:ExactRatio,n:unknown)=>ratio(a.numerator*BigInt(String(n)),a.denominator);
const group=(rows:any[],key:string)=>{const result=new Map<string,any[]>();for(const row of rows){const id=String(row[key]);result.set(id,[...(result.get(id)??[]),row]);}return result;};

/** Funding is immutable evidence, never a projection-repair target. Keep these
 * faults in paymentDrift so a missing provenance row cannot authorize restoring
 * already transferred credits through the balance repair operation. */
export async function auditSubscriptionChanges(c:PoolClient,owner?:string):Promise<PaymentDifference[]>{
  const periods=(await c.query(`SELECT p.*,o.provider,o.merchant_id,o.state order_state,o.owner_user_id order_owner,
    ch.id change_id,ch.state change_state,ch.owner_user_id change_owner,ch.source_period_id,ch.quote_id,
    q.owner_user_id quote_owner,q.transfer_points,q.transfer_numerator,q.transfer_denominator,
    q.consideration_numerator quote_numerator,q.consideration_denominator quote_denominator,
    q.pay_now_fen,q.total_points quote_points,q.source_period_id quote_source_period,q.face_amount_fen quote_face,
    q.subscription_id quote_subscription,q.target_plan_id quote_plan,q.billing_cycle quote_cycle,q.source_snapshot,
    previous.owner_user_id source_owner,previous.subscription_id source_subscription,previous.lot_id source_root
    FROM bb_subscription_periods p JOIN bb_recharge_orders o ON o.id=p.order_id
    LEFT JOIN bb_subscription_changes ch ON ch.target_period_id=p.id AND ch.order_id=o.id
    LEFT JOIN bb_subscription_change_quotes q ON q.id=ch.quote_id
    LEFT JOIN bb_subscription_periods previous ON previous.id=ch.source_period_id
    WHERE p.funding_kind='mixed' AND ($1::text IS NULL OR p.owner_user_id=$1)`,[owner??null])).rows;
  if(!periods.length)return [];
  const ids=periods.map(p=>p.id);
  const allocations=(await c.query(`SELECT a.*,ch.target_period_id,l.cash_basis_fen,l.cash_basis_points,l.cash_order_id,l.cash_origin_lot_id,l.source,l.owner_user_id lot_owner,
      origin.owner_user_id source_order_owner
    FROM bb_subscription_change_allocations a JOIN bb_subscription_changes ch ON ch.id=a.change_id
    JOIN bb_credit_lots l ON l.id=a.lot_id LEFT JOIN bb_recharge_orders origin ON origin.id=l.cash_order_id
    WHERE ch.target_period_id=ANY($1::text[])`,[ids])).rows;
  const sources=(await c.query(`SELECT f.*,o.owner_user_id order_owner,o.state order_state,o.amount_fen source_order_fen,proof.cash_amount_fen FROM bb_subscription_funding_sources f
    JOIN bb_recharge_orders o ON o.id=f.source_order_id LEFT JOIN bb_payment_cash_proofs proof ON proof.order_id=o.id AND proof.owner_user_id=o.owner_user_id
    WHERE f.period_id=ANY($1::text[])`,[ids])).rows;
  const originalFunding=(await c.query(`SELECT lf.*,f.source_order_id,f.owner_user_id source_owner FROM bb_subscription_lot_funding lf
    JOIN bb_subscription_funding_sources f ON f.id=lf.funding_source_id WHERE lf.lot_id=ANY($1::text[])`,[allocations.map(a=>a.lot_id)])).rows;
  const lots=(await c.query(`SELECT l.*,p.id period_id FROM bb_credit_lots l JOIN bb_subscription_periods p ON p.id=ANY($1::text[]) AND
      (p.lot_id=l.id OR p.lot_id=l.cash_origin_lot_id OR EXISTS(SELECT 1 FROM bb_subscription_credit_releases r WHERE r.period_id=p.id AND (r.lot_id=l.id OR r.lot_id=l.cash_origin_lot_id))
       OR EXISTS(SELECT 1 FROM bb_subscription_lot_funding lf JOIN bb_subscription_funding_sources f ON f.id=lf.funding_source_id WHERE lf.lot_id=l.id AND f.period_id=p.id))`,[ids])).rows;
  const events=(await c.query(`SELECT e.*,ch.target_period_id,ch.id change_id FROM bb_credit_events e JOIN bb_subscription_changes ch
    ON e.event_key LIKE 'subscription-change:'||ch.id||':%' WHERE ch.target_period_id=ANY($1::text[])`,[ids])).rows;
  const lotFunding=(await c.query(`SELECT lf.*,f.period_id funding_period,f.owner_user_id source_owner,f.point_numerator source_numerator,f.point_denominator source_denominator
    FROM bb_subscription_lot_funding lf JOIN bb_subscription_funding_sources f ON f.id=lf.funding_source_id
    WHERE lf.lot_id=ANY($1::text[])`,[lots.map(l=>l.id)])).rows;
  const allocationByPeriod=group(allocations,'target_period_id'),sourcesByPeriod=group(sources,'period_id'),oldFundingByLot=group(originalFunding,'lot_id');
  const lotsByPeriod=group(lots,'period_id'),fundingByLot=group(lotFunding,'lot_id'),eventsByPeriod=group(events,'target_period_id');
  const differences:PaymentDifference[]=[];
  for(const p of periods){
    const reasons=new Set<string>(),a=allocationByPeriod.get(p.id)??[],funds=sourcesByPeriod.get(p.id)??[];
    const problem=(reason:string)=>reasons.add(reason);
    try{
      if(!p.change_id||p.change_owner!==p.owner_user_id||p.order_owner!==p.owner_user_id||p.quote_owner!==p.owner_user_id||p.quote_source_period!==p.source_period_id||
        p.source_owner!==p.owner_user_id||p.source_subscription!==p.subscription_id||p.quote_subscription!==p.subscription_id||p.quote_plan!==p.plan_id||p.quote_cycle!==p.billing_cycle||
        BigInt(p.pay_now_fen)!==BigInt(p.amount_fen)||BigInt(p.quote_points)!==BigInt(p.points)||BigInt(p.quote_face)!==BigInt(p.face_amount_fen)||
        !equal(fraction(p.quote_numerator,p.quote_denominator),fraction(p.consideration_numerator,p.consideration_denominator)))problem('change_contract_or_quote_mismatch');
      const snapshot:any[]=Array.isArray(p.source_snapshot)?p.source_snapshot:[];
      if(a.length!==snapshot.length||a.some(x=>x.owner_user_id!==p.owner_user_id||x.lot_owner!==p.owner_user_id||x.source!=='subscription'||
        !(x.lot_id===p.source_root||x.cash_origin_lot_id===p.source_root)||!snapshot.some(s=>s.lot_id===x.lot_id&&BigInt(s.points)===BigInt(x.points)))||
        a.reduce((n,x)=>n+BigInt(x.points),0n)!==BigInt(p.transfer_points))problem('change_allocations_mismatch');
      const recorded=eventsByPeriod.get(p.id)??[],kinds=p.change_state==='held'?['hold']:p.change_state==='failed'?['hold','release']:['hold','settle'];
      if(recorded.length!==a.length*kinds.length||a.some(x=>kinds.some(kind=>!recorded.some(e=>e.event_key===`subscription-change:${p.change_id}:${kind}:${x.lot_id}`&&
        e.kind==='subscription_change_'+kind&&e.lot_id===x.lot_id&&e.owner_user_id===p.owner_user_id&&BigInt(e.points)===BigInt(x.points)))))problem('change_events_mismatch');
      if(p.change_state==='held'&&(p.order_state!=='pending'||p.status!=='pending')||p.change_state==='failed'&&(!['failed','expired'].includes(p.order_state)||p.status!=='failed')||
        ['applied','refunded'].includes(p.change_state)&&p.order_state!=='paid'||p.change_state==='refunded'&&p.status!=='refunded')problem('change_payment_state_mismatch');
      // Checkout writes immutable sources even while payment is unknown. Check
      // them without misrepresenting pending new cash as an authenticated receipt.
      {
        if(p.order_state==='paid'&&!['applied','refunded'].includes(p.change_state))problem('paid_change_not_applied');
        const unit=fraction(p.consideration_numerator,p.consideration_denominator),total=times(unit,p.points);
        let amount=ZERO,perPoint=ZERO;const actualTransfer=new Map<string,ExactRatio>();
        const newCash=funds.filter(f=>f.kind==='new_cash');
        if(newCash.length!==1||newCash[0].source_order_id!==p.order_id||newCash[0].source_lot_id!==null||!equal(fraction(newCash[0].amount_numerator,newCash[0].amount_denominator),fraction(p.amount_fen,1)))problem('new_cash_funding_mismatch');
        for(const f of funds){
          const value=fraction(f.amount_numerator,f.amount_denominator),point=fraction(f.point_numerator,f.point_denominator);
          amount=add(amount,value);perPoint=add(perPoint,point);
          const needsCashProof=f.kind==='transfer'||p.order_state==='paid';
          if(f.owner_user_id!==p.owner_user_id||f.order_owner!==p.owner_user_id||f.order_state!==(f.kind==='new_cash'?p.order_state:'paid')||
            needsCashProof&&(f.cash_amount_fen===null||BigInt(f.cash_amount_fen)!==BigInt(f.source_order_fen))||!equal(value,times(point,p.points)))problem('funding_source_mismatch');
          if(f.kind==='transfer'){
            if(!a.some(x=>x.lot_id===f.source_lot_id))problem('transfer_funding_without_allocation');
            const key=f.source_lot_id+'|'+f.source_order_id;actualTransfer.set(key,add(actualTransfer.get(key)??ZERO,value));
          }
        }
        if(!equal(amount,total)||!equal(perPoint,unit)||!equal(total,add(fraction(p.amount_fen,1),fraction(p.transfer_numerator,p.transfer_denominator))))problem('funding_consideration_not_conserved');
        const expectedTransfer=new Map<string,ExactRatio>();
        for(const x of a){
          const inherited=oldFundingByLot.get(x.lot_id)??[];
          if(x.cash_order_id){
            if(x.source_order_owner!==p.owner_user_id)problem('transfer_original_owner_mismatch');
            expectedTransfer.set(x.lot_id+'|'+x.cash_order_id,times(fraction(x.cash_basis_fen,x.cash_basis_points),x.points));
          }else{
            if(!inherited.length)problem('transferred_mixed_lot_missing_funding');
            for(const prior of inherited){
              if(prior.owner_user_id!==p.owner_user_id||prior.source_owner!==p.owner_user_id)problem('transfer_original_owner_mismatch');
              const key=x.lot_id+'|'+prior.source_order_id;
              expectedTransfer.set(key,add(expectedTransfer.get(key)??ZERO,times(fraction(prior.point_numerator,prior.point_denominator),x.points)));
            }
          }
        }
        if(actualTransfer.size!==expectedTransfer.size||[...expectedTransfer].some(([key,value])=>!actualTransfer.has(key)||!equal(value,actualTransfer.get(key)!)))problem('transfer_funding_not_original_consideration');
        for(const l of lotsByPeriod.get(p.id)??[]){
          const inherited=fundingByLot.get(l.id)??[];
          if(l.owner_user_id!==p.owner_user_id||l.cash_order_id!==null||!equal(fraction(l.cash_basis_fen,l.cash_basis_points),unit)||inherited.length!==funds.length)problem('mixed_lot_basis_or_funding_missing');
          for(const entry of inherited)if(entry.owner_user_id!==p.owner_user_id||entry.source_owner!==p.owner_user_id||entry.funding_period!==p.id||
            !equal(fraction(entry.point_numerator,entry.point_denominator),fraction(entry.source_numerator,entry.source_denominator)))problem('mixed_lot_funding_lineage_mismatch');
        }
      }
    }catch{problem('change_funding_evidence_invalid');}
    for(const reason of reasons)differences.push({id:p.order_id,owner_user_id:p.owner_user_id,provider:p.provider,merchant_id:p.merchant_id,state:p.order_state,reason});
  }
  return differences;
}
