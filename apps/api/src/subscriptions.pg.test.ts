import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION,SUBSCRIPTION_PLANS,SUBSCRIPTION_TASK_PRICE_VERSION,INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {transaction,uid} from './data.js';
import {installBillingWire,legacyBillingReplayExists} from './billing-wire.js';
import {creditBalance,lockCreditAccount,publishPrices} from './billing.js';
import {auditCredits,correctSettlement} from './billing-ops.js';
import {applyVerifiedPayment,createServiceTopup,refreshRecharge,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {applyVerifiedRefund,paymentRefundEligibility,requestPaymentRefund,refreshPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {createSubscriptionCheckout,subscriptionAccount,cancelSubscription,resolveActiveSubscriptionPrice,setSubscriptionAutoRenew,
  refreshSubscriptionMandate,processDueSubscriptionRenewals,supportsAutomaticRenewal,installSubscriptions,type RecurringPaymentProvider,type MandateRequest} from './subscriptions.js';

const database=await isolatedTestDatabase(undefined,'subscription-wallet');
test('synthetic subscriptions share the wallet, retain original cash rights, refund atomically and renew once',{skip:!database,timeout:120000},async t=>{
  const pool=new Pool({connectionString:database});
  const payments=new Map<string,VerifiedPayment>(),refunds=new Map<string,VerifiedRefund>();
  let refundMode:'processing'|'succeeded'='processing',chargeTimeout=false,charges=0,mandateCreates=0;
  const mandateStates=new Map<string,'pending'|'active'|'cancelled'>();
  const recurring:RecurringPaymentProvider={
    createMandate:async m=>{mandateCreates++;mandateStates.set(m.requestId,'pending');return{authorizationUrl:'https://synthetic.invalid/mandate/'+m.requestId};},
    queryMandate:async m=>({...m,mandateId:'synthetic-'+m.requestId,state:mandateStates.get(m.requestId)??'pending'}),
    cancelMandate:async m=>{mandateStates.set(m.requestId,'cancelled');return{...m,mandateId:m.mandateId??'synthetic-'+m.requestId,state:'cancelled'};},
    charge:async o=>{charges++;const r:VerifiedPayment={orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'paid',transactionId:'synthetic-'+o.id,payerCash:{amountFen:o.amount_fen,currency:'CNY'}};payments.set(o.id,r);if(chargeTimeout)throw Error('synthetic lost response');return r;},
  };
  const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-subscription-merchant',acknowledgement:{code:'SUCCESS'},recurring,
    create:async o=>{payments.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'pending',transactionId:null});return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-subscription'};},
    query:async o=>{const r=payments.get(o.id);if(!r)throw Error('synthetic query not found');return r;},verifyCallback:async()=>{throw Error('Synthetic tests call authenticated adapter seam only');},
    refunds:{create:async o=>{const r:VerifiedRefund={refundId:o.id,orderId:o.order_id,merchantId:o.merchant_id,transactionId:o.provider_transaction_id,providerRefundId:'synthetic-'+o.id,currency:'CNY',orderAmountFen:o.order_amount_fen,amountFen:o.amount_fen,payerTotalFen:o.order_amount_fen,payerRefundFen:o.amount_fen,state:refundMode};refunds.set(o.id,r);return r;},
      query:async o=>{const r=refunds.get(o.id);if(!r)throw Error('synthetic refund query unknown');return r;},verifyCallback:async()=>{throw Error('Synthetic only');}}};
  const owner=async()=>{const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synthetic_sub_'+id.slice(0,8)]);return id;};
  const buy=async(who:string,planId:'light'|'professional'|'intensive'='light')=>{
    const checkout=await createSubscriptionCheckout(pool,who,{request_id:uid(),plan_id:planId,provider:'wechat'},[provider]);
    const p=payments.get(checkout.order.order_id)!;
    const receipt:VerifiedPayment={...p,state:'paid',transactionId:'synthetic-'+p.orderId,payerCash:{amountFen:p.amountFen,currency:'CNY'}};
    await applyVerifiedPayment(pool,provider,receipt);return{...checkout,receipt};
  };
  // This is explicitly a synthetic delivered-allocation fixture, not a generated
  // document or provider-quality test. It exercises the real immutable money rules.
  const settleFixture=async(who:string,lotId:string,points:number,held=false)=>transaction(pool,async c=>{
    await lockCreditAccount(c,who);const project=uid(),run=uid(),quote=uid(),reservation=uid(),hash='a'.repeat(64);
    const version=(await c.query("SELECT id FROM bb_credit_price_versions WHERE pricing_mode='legacy_credit' ORDER BY effective_at LIMIT 1")).rows[0].id;
    await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic allocation fixture','generation')",[project,who]);
    await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,who,hash]);
    await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')",[run,who,project,hash]);
    await c.query("INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason) VALUES($1,$2,$3,1,$4,$5,'annual',$6,'synthetic settled allocation fixture')",[quote,who,project,hash,version,points]);
    await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,charged_points,state,finalized_at,billing_policy) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='settled' THEN now() ELSE NULL END,'on_delivery')",[reservation,who,run,quote,points,held?null:points,held?'held':'settled']);
    if(held)await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run,reservation]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points,charged_points) VALUES($1,$2,$3,$4)',[reservation,lotId,points,held?null:points]);
    await c.query(held?'UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1':'UPDATE bb_credit_lots SET remaining=remaining-$2 WHERE id=$1',[lotId,points]);
    await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,reservation_id,run_id,actor,reason) VALUES($1,$2,$1,$7,$3,$4,$5,$6,'synthetic','synthetic allocation')",[uid(),who,points,lotId,reservation,run,held?'reserve':'settle']);
    return{run,reservation};
  });
  try{
    await publishPrices(pool,{id:'synthetic-subscription-allocation-price',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-02T00:00:00Z',actor:'synthetic-test',reason:'Synthetic isolated allocation fixture, not the live tariff'});
    await t.test('verified payment grants once, 90-day rights and cash ratio survive cancellation',async()=>{
      const who=await owner(),input={request_id:uid(),plan_id:'light' as const,provider:'wechat' as const};
      const a=await createSubscriptionCheckout(pool,who,input,[provider]);
      assert.equal(a.order.amount_fen,19900);assert.equal(a.order.points,21000);assert.equal((await creditBalance(pool,who)).available,0);
      let audit=await auditCredits(pool);assert.equal(audit.consistent,true,JSON.stringify(audit));
      assert.equal((await createSubscriptionCheckout(pool,who,input,[provider])).order.order_id,a.order.order_id);
      await assert.rejects(createSubscriptionCheckout(pool,who,{...input,plan_id:'professional'},[provider]),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
      const receipt:VerifiedPayment={...payments.get(a.order.order_id)!,state:'paid',transactionId:'synthetic-'+a.order.order_id,payerCash:{amountFen:19900,currency:'CNY'}};
      await assert.rejects(applyVerifiedPayment(pool,provider,{...receipt,amountFen:1}));
      await Promise.all([applyVerifiedPayment(pool,provider,receipt),applyVerifiedPayment(pool,provider,receipt)]);
      let account=await subscriptionAccount(pool,who);assert.equal(account.available_points,"21000");assert.equal(account.subscription_available_points,"21000");assert.equal(account.periods.length,1);
      const p=account.periods[0];assert.equal(new Date(p.credits_expires_at!).getTime()-new Date(p.starts_at!).getTime(),90*86400000);
      const lot=(await pool.query('SELECT * FROM bb_credit_lots WHERE source_key=$1',[`recharge:${a.order.order_id}`])).rows[0];
      assert.equal(lot.source,'subscription');assert.equal(Number(lot.cash_basis_fen),19900);assert.equal(Number(lot.cash_basis_points),21000);
      assert.equal(await transaction(pool,c=>resolveActiveSubscriptionPrice(c,who)),SUBSCRIPTION_TASK_PRICE_VERSION);
      audit=await auditCredits(pool);assert.equal(audit.consistent,true,JSON.stringify(audit));
      await cancelSubscription(pool,who,a.subscription.id,uid(),[provider]);account=await subscriptionAccount(pool,who);
      assert.equal(account.subscription!.status,'cancelled');assert.equal(account.available_points,"21000");assert.equal(account.periods[0].credits_expires_at,p.credits_expires_at);
      assert.equal(await transaction(pool,c=>resolveActiveSubscriptionPrice(c,who)),SUBSCRIPTION_TASK_PRICE_VERSION);
      audit=await auditCredits(pool);assert.equal(audit.consistent,true,JSON.stringify(audit));
      await assert.rejects(cancelSubscription(pool,await owner(),a.subscription.id,uid(),[provider]));
      assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_credit_lots WHERE source_key=$1',[`recharge:${a.order.order_id}`])).rows[0].n),1);
    });
    await t.test('a stale tab subscription request is durably rejected without an order and topup stays available',async()=>{
      const who=await owner(),active=await buy(who),input={request_id:uid(),plan_id:'professional' as const,provider:'wechat' as const};
      let channelCalls=0;const watched={...provider,create:async(o:Parameters<PaymentProvider['create']>[0])=>{channelCalls++;return provider.create(o);}};
      const rejected=(error:unknown)=>(error as any).code==='SUBSCRIPTION_CHECKOUT_REJECTED'&&(error as any).status===409;
      await Promise.all([assert.rejects(createSubscriptionCheckout(pool,who,input,[watched]),rejected),assert.rejects(createSubscriptionCheckout(pool,who,input,[watched]),rejected)]);
      assert.equal(channelCalls,0,'rejected requests never reach the payment provider');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[who,input.request_id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_checkout_rejections WHERE owner_user_id=$1 AND request_id=$2',[who,input.request_id])).rows[0].n,1);
      await assert.rejects(createSubscriptionCheckout(pool,who,{...input,plan_id:'intensive'},[watched]),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
      // An ordinary new topup is still available while the paid subscription is active.
      const topup=await createServiceTopup(pool,who,{request_id:uid(),provider:'wechat',amount_fen:1000},[provider]);assert.equal(topup.state,'pending');
      await pool.query("UPDATE bb_subscriptions SET current_period_start=now()-interval '1 month 1 second',current_period_end=now()-interval '1 second' WHERE id=$1",[active.subscription.id]);
      await assert.rejects(createSubscriptionCheckout(pool,who,input,[watched]),rejected,'old rejected key stays rejected after state changes');
      assert.equal(channelCalls,0);
      const next=await createSubscriptionCheckout(pool,who,{...input,request_id:uid()},[watched]);assert.equal(next.order.state,'pending');assert.equal(channelCalls,1);
      await assert.rejects(pool.query('DELETE FROM bb_subscription_checkout_rejections WHERE owner_user_id=$1',[who]),e=>(e as any).code==='23514');
    });
    await t.test('legacy HTTP replays only the exact owner rejection and can never create a new subscription payment',async()=>{
      const who=await owner(),foreign=await owner(),active=await buy(who),input={request_id:uid(),plan_id:'professional',provider:'wechat'};
      const app=Fastify(),actor=async(r:any)=>r.headers['x-synthetic-owner']??who,headers={[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION};
      installBillingWire(app,{db:()=>pool,owner:actor});installSubscriptions(app,pool,actor,true,[provider]);
      app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status??e.statusCode??500).send({code:e.code}));
      const post=(payload:object,extraHeaders:Record<string,string>={},url='/api/v1/subscriptions')=>app.inject({method:'POST',url,headers:extraHeaders,payload});
      try{
        const rejected=await post(input);assert.equal(rejected.statusCode,409);assert.equal(rejected.json().code,'SUBSCRIPTION_CHECKOUT_REJECTED');
        const replay=await post(input,headers);assert.equal(replay.statusCode,409);assert.equal(replay.json().code,'SUBSCRIPTION_CHECKOUT_REJECTED');
        for(const payload of [{...input,plan_id:'intensive'},{...input,billing_cycle:'annual'}]){
          const altered=await post(payload,headers);assert.equal(altered.statusCode,409);assert.equal(altered.json().code,'IDEMPOTENCY_CONFLICT');
        }
        const wrongEndpoint=await post(input,headers,`/api/v1/subscriptions/${active.subscription.id}/renew`);
        assert.equal(wrongEndpoint.statusCode,409);assert.equal(wrongEndpoint.json().code,'IDEMPOTENCY_CONFLICT','rejection does not authorize another endpoint/resource');
        const other=await post(input,{...headers,'x-synthetic-owner':foreign});assert.equal(other.statusCode,409);assert.equal(other.json().code,'BILLING_PROTOCOL_REPLAY_ONLY');
        assert.equal(await legacyBillingReplayExists(pool,who,'topup',{params:{},body:input}),false,'subscription rejection cannot admit a topup');
        await pool.query("UPDATE bb_subscriptions SET current_period_start=now()-interval '1 month 1 second',current_period_end=now()-interval '1 second' WHERE id=$1",[active.subscription.id]);
        const stillRejected=await post(input,headers);assert.equal(stillRejected.json().code,'SUBSCRIPTION_CHECKOUT_REJECTED');
        const fresh={...input,request_id:uid()},blocked=await post(fresh,headers);
        assert.equal(blocked.statusCode,409);assert.equal(blocked.json().code,'BILLING_PROTOCOL_REPLAY_ONLY','legacy protocol cannot open a newly available period');
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=ANY($2)',[who,[input.request_id,fresh.request_id]])).rows[0].n,0);
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_checkout_rejections WHERE owner_user_id=$1 AND request_id=$2',[who,fresh.request_id])).rows[0].n,0);
      }finally{await app.close();}
    });
    await t.test('checkout failure before channel creation stays unknown until authenticated expiry, then permits a new purchase',async()=>{
      const who=await owner();let createFails=true,absenceVerified=false;
      const faultProvider:PaymentProvider={...provider,
        create:async o=>{if(createFails)throw Error('synthetic connection failure before channel creation');return provider.create(o);},
        query:async o=>{if(!absenceVerified)throw Error('synthetic unsigned/unknown query failure');return{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',transactionId:null,state:'expired'};},
      };
      await assert.rejects(createSubscriptionCheckout(pool,who,{request_id:uid(),plan_id:'light',provider:'wechat'},[faultProvider]));
      const old=(await pool.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1',[who])).rows[0],realNow=Date.now;
      try{
        Date.now=()=>new Date(old.expires_at).getTime()+1;
        await assert.rejects(createSubscriptionCheckout(pool,who,{request_id:uid(),plan_id:'professional',provider:'wechat'},[faultProvider]),e=>(e as any).code==='PAYMENT_INVALID');
        assert.equal((await pool.query('SELECT state FROM bb_recharge_orders WHERE id=$1',[old.id])).rows[0].state,'pending');
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_periods WHERE owner_user_id=$1',[who])).rows[0].n,1);
        // The channel adapter alone can produce this terminal outcome. The
        // matching WeChat test proves signature and immutable deadline checks.
        absenceVerified=true;createFails=false;
        assert.equal((await refreshRecharge(pool,who,old.id,[faultProvider])).state,'expired');
        Date.now=realNow;
        const replacement=await createSubscriptionCheckout(pool,who,{request_id:uid(),plan_id:'professional',provider:'wechat'},[faultProvider]);
        assert.notEqual(replacement.order.order_id,old.id);assert.equal(replacement.order.state,'pending');
        assert.equal((await pool.query('SELECT state FROM bb_recharge_orders WHERE id=$1',[old.id])).rows[0].state,'expired');
        assert.equal((await pool.query('SELECT status FROM bb_subscription_periods WHERE order_id=$1',[old.id])).rows[0].status,'failed');
        assert.deepEqual(await creditBalance(pool,who),{available:0,frozen:0});
      }finally{Date.now=realNow;}
    });
    await t.test('only a wholly unused period refunds 199 cash by removing 21000 points, unknown status stays held',async()=>{
      const who=await owner(),a=await buy(who);refundMode='processing';
      let eligibility=await paymentRefundEligibility(pool,who,a.order.order_id,[provider]);assert.equal(eligibility.refundable_fen,19900);
      await assert.rejects(requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:1},[provider]));
      const input={request_id:uid(),amount_fen:19900};const r=await requestPaymentRefund(pool,who,a.order.order_id,input,[provider]);assert.equal(r.state,'processing');
      assert.deepEqual(await creditBalance(pool,who),{available:0,frozen:21000});
      const heldAccount=await subscriptionAccount(pool,who);
      assert.equal(heldAccount.task_held_points,"0");assert.equal(heldAccount.refund_held_points,"21000");
      assert.equal(heldAccount.periods[0].task_held_points,"0");assert.equal(heldAccount.periods[0].refund_held_points,"21000");
      assert.equal((await requestPaymentRefund(pool,who,a.order.order_id,input,[provider])).refund_id,r.refund_id);
      await assert.rejects(requestPaymentRefund(pool,who,a.order.order_id,{...input,request_id:uid()},[provider]));
      const receipt={...refunds.get(r.refund_id)!,state:'succeeded' as const};refunds.set(r.refund_id,receipt);
      await Promise.all([applyVerifiedRefund(pool,provider,receipt),refreshPaymentRefund(pool,who,r.refund_id,[provider])]);
      assert.deepEqual(await creditBalance(pool,who),{available:0,frozen:0});
      const account=await subscriptionAccount(pool,who);assert.equal(account.periods[0].status,'refunded');assert.equal(account.subscription!.status,'cancelled');
      assert.equal(account.task_held_points,"0");assert.equal(account.refund_held_points,"0");
      assert.equal(await transaction(pool,c=>resolveActiveSubscriptionPrice(c,who)),null);
      assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_credit_events WHERE owner_user_id=$1 AND kind='refund_settle'",[who])).rows[0].n),1);
      await applyVerifiedPayment(pool,provider,a.receipt);assert.equal((await creditBalance(pool,who)).available,0,'late payment callback never reissues a refunded period');
      eligibility=await paymentRefundEligibility(pool,who,a.order.order_id,[provider]);assert.equal(eligibility.enabled,false);
      const replacement=await createSubscriptionCheckout(pool,who,{request_id:uid(),plan_id:'professional',provider:'wechat'},[provider]);
      assert.equal(replacement.order.amount_fen,49900,'refunded period must not prevent a new purchase for another month');
    });
    await t.test('task and cash-refund holds are separate in the same wallet and each period',async()=>{
      const who=await owner(),a=await buy(who);refundMode='processing';
      const topup=await createServiceTopup(pool,who,{request_id:uid(),provider:'wechat',amount_fen:1000},[provider]);
      await applyVerifiedPayment(pool,provider,{...payments.get(topup.order_id)!,state:'paid',transactionId:'synthetic-'+topup.order_id,payerCash:{amountFen:1000,currency:'CNY'}});
      const lot=(await pool.query('SELECT id FROM bb_credit_lots WHERE source_key=$1',[`recharge:${topup.order_id}`])).rows[0];
      await settleFixture(who,lot.id,200,true);
      await requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:19900},[provider]);
      const account=await subscriptionAccount(pool,who);
      assert.equal(account.available_points,"800");assert.equal(account.held_points,"21200");
      assert.equal(account.task_held_points,"200");assert.equal(account.refund_held_points,"21000");
      assert.equal(account.periods[0].held_points,"21000");assert.equal(account.periods[0].task_held_points,"0");assert.equal(account.periods[0].refund_held_points,"21000");
      const other=await subscriptionAccount(pool,await owner());assert.equal(other.task_held_points,"0");assert.equal(other.refund_held_points,"0");
      const audit=await auditCredits(pool);assert.equal(audit.consistent,true,JSON.stringify(audit));
    });
    await t.test('consumption prevents subscription cash refund; expired correction preserves original paid ratio',async()=>{
      const who=await owner(),a=await buy(who),lot=(await pool.query('SELECT * FROM bb_credit_lots WHERE source_key=$1',[`recharge:${a.order.order_id}`])).rows[0];
      const f=await settleFixture(who,lot.id,1218);
      assert.equal((await paymentRefundEligibility(pool,who,a.order.order_id,[provider])).enabled,false);
      assert.equal(Number((await pool.query('SELECT 1218::numeric*cash_basis_fen/cash_basis_points AS value FROM bb_credit_lots WHERE id=$1',[lot.id])).rows[0].value),1154.2);
      // Synthetic passage of time for this lot; no production clock or historical cash fact is changed.
      await pool.query("UPDATE bb_credit_lots SET expires_at=now()-interval '1 second' WHERE id=$1",[lot.id]);
      const corrections=await correctSettlement(pool,{runId:f.run,actor:'synthetic-test',reason:'Synthetic platform quality correction'});
      const restored=(await pool.query('SELECT * FROM bb_credit_lots WHERE id=$1',[corrections[0]])).rows[0];
      assert.equal(restored.source,'subscription');assert.equal(Number(restored.cash_basis_fen),19900);assert.equal(Number(restored.cash_basis_points),21000);assert.equal(restored.cash_origin_lot_id,lot.id);
      assert.ok(new Date(restored.expires_at).getTime()>Date.now()+6*86400000);assert.equal((await creditBalance(pool,who)).available,1218);
      assert.deepEqual(await correctSettlement(pool,{runId:f.run,actor:'synthetic-test',reason:'Synthetic repeated correction'}),corrections);
    });
    await t.test('the application rejects an unused subscription after the seven-day refund window',async()=>{
      const who=await owner(),a=await buy(who),account=await subscriptionAccount(pool,who);
      await pool.query('CREATE TABLE IF NOT EXISTS bb_subscription_refund_test_clock(owner_user_id text PRIMARY KEY,observed_at timestamptz NOT NULL)');
      await pool.query("CREATE OR REPLACE FUNCTION bb_subscription_clock(p_owner text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT observed_at FROM bb_subscription_refund_test_clock WHERE owner_user_id=p_owner),date_trunc('milliseconds',now())) $$");
      try{
        await pool.query('INSERT INTO bb_subscription_refund_test_clock VALUES($1,$2)',[who,new Date(new Date(account.periods[0].starts_at!).getTime()+7*86400000+1).toISOString()]);
        const eligibility=await paymentRefundEligibility(pool,who,a.order.order_id,[provider]);assert.equal(eligibility.enabled,false);assert.equal(eligibility.refundable_fen,0);
        await assert.rejects(requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:19900},[provider]));
      }finally{await pool.query('DELETE FROM bb_subscription_refund_test_clock WHERE owner_user_id=$1',[who]);}
      assert.equal((await creditBalance(pool,who)).available,21000);
    });
    await t.test('topup is 1:1 permanent and does not inherit a subscription discount',async()=>{
      const who=await owner(),a=await buy(who,'professional');
      const topup=await createServiceTopup(pool,who,{request_id:uid(),provider:'wechat',amount_fen:1000},[provider]);
      const receipt:VerifiedPayment={...payments.get(topup.order_id)!,state:'paid',transactionId:'synthetic-'+topup.order_id,payerCash:{amountFen:1000,currency:'CNY'}};
      await applyVerifiedPayment(pool,provider,receipt);const account=await subscriptionAccount(pool,who);
      assert.equal(account.available_points,"56000");assert.equal(account.topup_available_points,"1000");assert.equal(account.subscription_available_points,"55000");
      const lot=(await pool.query('SELECT * FROM bb_credit_lots WHERE source_key=$1',[`recharge:${topup.order_id}`])).rows[0];assert.equal(lot.expires_at,null);assert.equal(Number(lot.cash_basis_fen),1000);assert.equal(Number(lot.cash_basis_points),1000);
      assert.equal((await paymentRefundEligibility(pool,who,topup.order_id,[provider])).refundable_fen,1000);assert.ok(a.subscription.id);
    });
    await t.test('native checkout has no recurring capability; an authenticated synthetic mandate renews once after timeout',async()=>{
      const who=await owner(),a=await buy(who,'intensive'),native={...provider,recurring:undefined};assert.equal(supportsAutomaticRenewal(native),false);
      await assert.rejects(setSubscriptionAutoRenew(pool,who,a.subscription.id,{request_id:uid(),enabled:true},[native]),e=>(e as any).code==='PAYMENT_UNAVAILABLE');
      const input={request_id:uid(),enabled:true},requested=await setSubscriptionAutoRenew(pool,who,a.subscription.id,input,[provider]);
      assert.equal(requested.subscription.auto_renew,false);assert.ok(requested.authorization_url);assert.equal(mandateCreates,1);
      const row=(await pool.query('SELECT * FROM bb_subscriptions WHERE id=$1',[a.subscription.id])).rows[0];mandateStates.set(row.mandate_request_id,'active');
      assert.equal((await refreshSubscriptionMandate(pool,who,a.subscription.id,[provider])).subscription.auto_renew,true);
      await setSubscriptionAutoRenew(pool,who,a.subscription.id,input,[provider]);assert.equal(mandateCreates,1);
      // Synthetic advancement of the renewal scheduler projection; period/lot facts remain immutable.
      await pool.query("UPDATE bb_subscriptions SET current_period_start=now()-interval '1 month 1 second',current_period_end=now()-interval '1 second' WHERE id=$1",[a.subscription.id]);
      chargeTimeout=true;await processDueSubscriptionRenewals(pool,[provider]);assert.equal(charges,1);
      await Promise.all([processDueSubscriptionRenewals(pool,[provider]),processDueSubscriptionRenewals(pool,[provider])]);
      assert.equal(charges,1);const account=await subscriptionAccount(pool,who);assert.equal(account.periods.length,2);assert.equal(account.available_points,"228000");
      await cancelSubscription(pool,who,a.subscription.id,uid(),[provider]);assert.equal((await subscriptionAccount(pool,who)).subscription!.auto_renew,false);
      await processDueSubscriptionRenewals(pool,[provider]);assert.equal(charges,1);
      assert.equal(SUBSCRIPTION_PLANS.find(p=>p.id==='intensive')!.points,114000);
    });
    await t.test('a delayed refund for an earlier period cannot cancel a later paid period or its mandate',async()=>{
      const who=await owner(),old=await buy(who);refundMode='processing';
      const refund=await requestPaymentRefund(pool,who,old.order.order_id,{request_id:uid(),amount_fen:19900},[provider]);
      // Advance only the scheduler projection to simulate a refund still
      // processing after month end; original period and payment facts stay locked.
      await pool.query("UPDATE bb_subscriptions SET current_period_start=now()-interval '1 month 1 second',current_period_end=now()-interval '1 second' WHERE id=$1",[old.subscription.id]);
      const current=await buy(who,'professional');
      await setSubscriptionAutoRenew(pool,who,current.subscription.id,{request_id:uid(),enabled:true},[provider]);
      const mandate=(await pool.query('SELECT mandate_request_id FROM bb_subscriptions WHERE id=$1',[current.subscription.id])).rows[0];
      mandateStates.set(mandate.mandate_request_id,'active');await refreshSubscriptionMandate(pool,who,current.subscription.id,[provider]);
      const before=(await subscriptionAccount(pool,who)).subscription!;
      await applyVerifiedRefund(pool,provider,{...refunds.get(refund.refund_id)!,state:'succeeded'});
      const after=await subscriptionAccount(pool,who);
      assert.equal(after.subscription!.status,'active');assert.equal(after.subscription!.plan_id,'professional');
      assert.equal(after.subscription!.auto_renew,true);assert.equal(after.subscription!.mandate_status,'active');
      assert.equal(after.subscription!.current_period_start,before.current_period_start);assert.equal(after.subscription!.current_period_end,before.current_period_end);
      assert.equal(after.periods.find(p=>p.order_id===old.order.order_id)!.status,'refunded');
      assert.equal(after.periods.find(p=>p.order_id===current.order.order_id)!.status,'active');
      assert.deepEqual(await creditBalance(pool,who),{available:55000,frozen:0});
    });
  }finally{await pool.end();}
});
