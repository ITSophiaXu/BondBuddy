import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {uid} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {auditCredits} from './billing-audit.js';
import {billingAuditHash,inspectAndIsolateBillingScope,repairWalletProjection,resumeBillingScope} from './billing-safety.js';
import {grantBillingPermission} from './billing-permissions.js';
import {applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {requestPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {createSubscriptionCheckout,processDueSubscriptionCreditReleases,subscriptionAccount} from './subscriptions.js';
import {createSubscriptionChangeQuote,createSubscriptionChangeCheckout} from './subscription-changes.js';

// A private clone, synthetic authenticated receipts and real financial APIs.
// Intentional corruptions touch only fixture projections/evidence in this clone.
const database=await isolatedTestDatabase(undefined,'subscription-change-audit');
test('subscription change funding and projection repair share one authoritative audit',{skip:!database,timeout:120000},async t=>{
  const pool=new Pool({connectionString:database}),receipts=new Map<string,VerifiedPayment>();
  const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-change-audit',acknowledgement:{code:'SUCCESS'},
    create:async o=>{receipts.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'pending',transactionId:null});return{checkoutUrl:'https://synthetic.invalid/'+o.id};},
    query:async o=>receipts.get(o.id)!,verifyCallback:async()=>{throw Error('Synthetic only');},
    refunds:{create:async o=>({refundId:o.id,orderId:o.order_id,merchantId:o.merchant_id,transactionId:o.provider_transaction_id,providerRefundId:'synthetic-'+o.id,
      currency:'CNY',orderAmountFen:o.order_amount_fen,amountFen:o.amount_fen,payerTotalFen:o.order_amount_fen,payerRefundFen:o.amount_fen,state:'succeeded'} as VerifiedRefund),
      query:async()=>{throw Error('No pending synthetic refund');},verifyCallback:async()=>{throw Error('Synthetic only');}}};
  const user=async()=>{const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'change_audit_'+id.slice(0,8)]);return id;};
  const pay=async(id:string,state:'paid'|'failed'='paid')=>{const old=receipts.get(id);assert.ok(old);const r:VerifiedPayment={...old,state,transactionId:state==='paid'?'synthetic-'+id:null,
    ...(state==='paid'?{payerCash:{amountFen:old.amountFen,currency:'CNY'}}:{})};receipts.set(id,r);await applyVerifiedPayment(pool,provider,r);return r;};
  const buy=async(owner:string,plan:'light'|'professional'='professional')=>{const a=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:plan,provider:'wechat',billing_cycle:'monthly'},[provider]);await pay(a.order.order_id);return a;};
  const change=async(owner:string,plan:'professional'|'intensive'='intensive',billing_cycle:'monthly'|'annual'='monthly')=>{
    const q=await createSubscriptionChangeQuote(pool,owner,{request_id:uid(),plan_id:plan,billing_cycle});
    const result=await createSubscriptionChangeCheckout(pool,owner,{request_id:uid(),quote_id:q.quote.quote_id,provider:'wechat'},[provider]);return{...result,quote:q.quote};
  };
  const clean=async(owner:string)=>{const r=await auditCredits(pool,owner);assert.equal(r.consistent,true,JSON.stringify(r));return r;};
  const repairer=async()=>{const actor=await user();await grantBillingPermission(pool,{requestId:uid(),userId:actor,permission:'billing_repair',actor:'synthetic',reason:'Independent fixture repair authority'});return actor;};
  const control=(actor:string)=>({requestId:uid(),actor,reason:'Verify exact subscription-change projections'});
  try{
    await t.test('held transfer is a legitimate frozen balance and a failed checkout releases it',async()=>{
      const who=await user(),original=await buy(who),switched=await change(who),actor=await repairer();
      const old=(await pool.query('SELECT lot_id FROM bb_subscription_periods WHERE order_id=$1',[original.order.order_id])).rows[0].lot_id;
      await clean(who);assert.equal((await pool.query('SELECT frozen FROM bb_credit_lots WHERE id=$1',[old])).rows[0].frozen,'55000');
      await pool.query('UPDATE bb_credit_lots SET frozen=0 WHERE id=$1',[old]);
      const broken=await auditCredits(pool,who);assert.equal(broken.paymentDrift.length,0);assert.equal(broken.lotDrift[0].expected_frozen,'55000');
      await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner:who});
      assert.equal((await repairWalletProjection(pool,{...control(actor),owner:who,expectedAuditHash:billingAuditHash(broken)})).status,'repaired');
      assert.equal((await pool.query('SELECT frozen FROM bb_credit_lots WHERE id=$1',[old])).rows[0].frozen,'55000');
      await resumeBillingScope(pool,{...control(actor),scope:{kind:'wallet',owner:who}});
      await pay(switched.order.order_id,'failed');await clean(who);assert.equal((await subscriptionAccount(pool,who)).available_points,'55000');
    });
    await t.test('applied and refunded transfers never resurrect the old lot through repair',async()=>{
      const who=await user(),original=await buy(who),switched=await change(who),actor=await repairer();await pay(switched.order.order_id);
      assert.equal(switched.order.amount_fen,50000);await clean(who);
      const old=(await pool.query('SELECT lot_id,status FROM bb_subscription_periods WHERE order_id=$1',[original.order.order_id])).rows[0];assert.equal(old.status,'superseded');
      const fundingBefore=(await pool.query('SELECT * FROM bb_subscription_funding_sources WHERE owner_user_id=$1 ORDER BY id',[who])).rows;
      await pool.query('UPDATE bb_credit_lots SET remaining=1 WHERE id=$1',[old.lot_id]);
      const broken=await auditCredits(pool,who);assert.equal(broken.paymentDrift.length,0);assert.equal(broken.lotDrift[0].expected_remaining,'0');
      await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner:who});
      assert.equal((await repairWalletProjection(pool,{...control(actor),owner:who,expectedAuditHash:billingAuditHash(broken)})).status,'repaired');
      assert.equal((await pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[old.lot_id])).rows[0].remaining,'0');
      await resumeBillingScope(pool,{...control(actor),scope:{kind:'wallet',owner:who}});
      const refunded=await requestPaymentRefund(pool,who,switched.order.order_id,{request_id:uid(),amount_fen:50000},[provider]);assert.equal(refunded.state,'succeeded');
      await clean(who);assert.equal((await subscriptionAccount(pool,who)).available_points,'55000');
      assert.equal((await pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[old.lot_id])).rows[0].remaining,'0');
      const restored=(await pool.query("SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key LIKE 'subscription-change-restore:%'",[who])).rows;
      assert.equal(restored.length,1);assert.equal(restored[0].original_points,'55000');assert.equal(restored[0].cash_order_id,original.order.order_id);
      assert.deepEqual((await pool.query('SELECT * FROM bb_subscription_funding_sources WHERE owner_user_id=$1 ORDER BY id',[who])).rows,fundingBefore);
    });
    await t.test('multi-step funding survives annual cash allocation with unequal monthly cents',async()=>{
      const who=await user();await buy(who,'light');const middle=await change(who,'professional');await pay(middle.order.order_id);await clean(who);
      const annual=await change(who,'intensive','annual');await pay(annual.order.order_id);await clean(who);
      assert.equal(annual.order.amount_fen,1029020);assert.equal((await subscriptionAccount(pool,who)).available_points,'114000');
      const p=(await pool.query('SELECT * FROM bb_subscription_periods WHERE order_id=$1',[annual.order.order_id])).rows[0];
      const schedule=(await pool.query('SELECT * FROM bb_subscription_credit_releases WHERE period_id=$1 ORDER BY installment_index',[p.id])).rows;
      assert.equal(schedule.length,12);assert.equal(schedule.reduce((sum,r)=>sum+BigInt(r.amount_fen),0n),1029020n);assert.ok(new Set(schedule.map(r=>r.amount_fen)).size>1);
      const funding=(await pool.query('SELECT * FROM bb_subscription_funding_sources WHERE period_id=$1',[p.id])).rows;assert.equal(funding.length,3);
      await pool.query('CREATE TABLE IF NOT EXISTS bb_change_audit_clock(owner_user_id text PRIMARY KEY,at timestamptz NOT NULL)');
      await pool.query("CREATE OR REPLACE FUNCTION bb_subscription_clock(p_owner text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT at FROM bb_change_audit_clock WHERE owner_user_id=p_owner),date_trunc('milliseconds',now())) $$");
      await pool.query('INSERT INTO bb_change_audit_clock VALUES($1,$2)',[who,schedule[1].due_at]);
      assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,1);await clean(who);
      assert.equal((await subscriptionAccount(pool,who)).available_points,'228000');
      const lots=(await pool.query('SELECT lot_id FROM bb_subscription_credit_releases WHERE period_id=$1 AND state=$2',[p.id,'issued'])).rows;
      for(const lot of lots)assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_lot_funding WHERE lot_id=$1',[lot.lot_id])).rows[0].n,3);
    });
    await t.test('missing mixed funding is non-projection evidence and cannot be repaired into credits',async()=>{
      const who=await user();await buy(who);const switched=await change(who);await pay(switched.order.order_id);await clean(who);const actor=await repairer();
      const before=(await pool.query('SELECT id,remaining,frozen FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id',[who])).rows;
      const entry=(await pool.query('SELECT * FROM bb_subscription_lot_funding WHERE owner_user_id=$1 LIMIT 1',[who])).rows[0];
      // Explicit fault injection in this private test clone only. Re-enable the
      // immutable trigger before exercising production audit/repair controls.
      const c=await pool.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE bb_subscription_lot_funding DISABLE TRIGGER bb_subscription_lot_funding_immutable');
        await c.query('DELETE FROM bb_subscription_lot_funding WHERE lot_id=$1 AND funding_source_id=$2',[entry.lot_id,entry.funding_source_id]);
        await c.query('ALTER TABLE bb_subscription_lot_funding ENABLE TRIGGER bb_subscription_lot_funding_immutable');await c.query('COMMIT');
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
      const broken=await auditCredits(pool,who);assert.equal(broken.lotDrift.length,0);assert.ok(broken.paymentDrift.some(r=>r.reason==='mixed_lot_basis_or_funding_missing'));
      await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner:who});
      const rejected=await repairWalletProjection(pool,{...control(actor),owner:who,expectedAuditHash:billingAuditHash(broken)});
      assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'non_projection_difference');
      assert.deepEqual((await pool.query('SELECT id,remaining,frozen FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id',[who])).rows,before);
    });
    await t.test('missing pending source evidence cannot be classified as a repairable hold',async()=>{
      const who=await user();await buy(who);await change(who);await clean(who);const actor=await repairer();
      const entry=(await pool.query("SELECT id FROM bb_subscription_funding_sources WHERE owner_user_id=$1 AND kind='transfer'",[who])).rows[0];
      // This private clone deliberately loses one immutable pending source.
      const c=await pool.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE bb_subscription_funding_sources DISABLE TRIGGER bb_subscription_funding_source_immutable');
        await c.query('DELETE FROM bb_subscription_funding_sources WHERE id=$1',[entry.id]);
        await c.query('ALTER TABLE bb_subscription_funding_sources ENABLE TRIGGER bb_subscription_funding_source_immutable');await c.query('COMMIT');
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
      const broken=await auditCredits(pool,who);assert.equal(broken.lotDrift.length,0);assert.ok(broken.paymentDrift.some(r=>r.reason==='funding_consideration_not_conserved'));
      await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner:who});
      const rejected=await repairWalletProjection(pool,{...control(actor),owner:who,expectedAuditHash:billingAuditHash(broken)});
      assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'non_projection_difference');
      assert.equal((await pool.query('SELECT frozen FROM bb_credit_lots WHERE owner_user_id=$1',[who])).rows[0].frozen,'55000');
    });
    await t.test('funding ownership, original consideration and restoration expiry are database-enforced',async()=>{
      const who=await user(),other=await user(),original=await buy(who),switched=await change(who);
      const target=(await pool.query('SELECT * FROM bb_subscription_periods WHERE order_id=$1',[switched.order.order_id])).rows[0];
      const source=(await pool.query('SELECT l.* FROM bb_credit_lots l JOIN bb_subscription_periods p ON p.lot_id=l.id WHERE p.order_id=$1',[original.order.order_id])).rows[0];
      await assert.rejects(pool.query(`INSERT INTO bb_subscription_funding_sources(id,period_id,owner_user_id,kind,source_order_id,source_lot_id,
        amount_numerator,amount_denominator,point_numerator,point_denominator) VALUES($1,$2,$3,'transfer',$4,$5,1,1,1,$6)`,
        [uid(),target.id,who,original.order.order_id,source.id,target.points]),(error:any)=>error.code==='23514'&&/Transferred consideration/.test(error.message));
      await pay(switched.order.order_id);await clean(who);
      const slice=(await pool.query('SELECT * FROM bb_subscription_lot_funding WHERE owner_user_id=$1 LIMIT 1',[who])).rows[0];
      await assert.rejects(pool.query(`INSERT INTO bb_subscription_lot_funding(lot_id,funding_source_id,owner_user_id,point_numerator,point_denominator)
        VALUES($1,$2,$3,$4,$5)`,[slice.lot_id,slice.funding_source_id,other,slice.point_numerator,slice.point_denominator]),
        (error:any)=>error.code==='23514'&&/ownership/.test(error.message));
      await requestPaymentRefund(pool,who,switched.order.order_id,{request_id:uid(),amount_fen:50000},[provider]);await clean(who);
      const changeId=(await pool.query('SELECT id FROM bb_subscription_changes WHERE order_id=$1',[switched.order.order_id])).rows[0].id;
      await assert.rejects(pool.query(`INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
        VALUES($1,$2,'subscription',$3,$4,$4,$5)`,[uid(),who,'subscription-change-restore:'+changeId+':'+source.id,source.original_points,
          new Date(new Date(source.expires_at).getTime()+1).toISOString()]),(error:any)=>error.code==='23514');
      await clean(who);assert.equal((await subscriptionAccount(pool,who)).available_points,'55000');
    });
  }finally{await pool.end();}
});
