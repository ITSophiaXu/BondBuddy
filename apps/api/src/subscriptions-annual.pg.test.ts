import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {SUBSCRIPTION_PLANS} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {uid,digest,transaction,type PrivateBlobs} from './data.js';
import {grantCredits} from './billing.js';
import {auditCredits} from './billing-audit.js';
import {applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {applyVerifiedRefund,requestPaymentRefund,paymentRefundEligibility,type VerifiedRefund} from './payment-refunds.js';
import {createSubscriptionCheckout,processDueSubscriptionCreditReleases,processDueSubscriptionRenewals,cancelSubscription,subscriptionAccount,
  setSubscriptionAutoRenew,refreshSubscriptionMandate,resolveActiveSubscriptionPrice,type MandateRequest} from './subscriptions.js';
import {subscriptionOrderPeriod} from './subscription-order-detail.js';
import {createServer} from './server.js';
import {claim,finish} from './queue.js';
import {syntheticReviewPair} from './review-delivery-test-fixture.js';

const database=await isolatedTestDatabase(undefined,'annual-subscription');
test('annual payment, monthly release, original consideration and whole-contract refunds',{skip:!database,timeout:180000},async t=>{
 const pool=new Pool({connectionString:database});
 const payments=new Map<string,VerifiedPayment>(),refunds=new Map<string,VerifiedRefund>(),mandates=new Map<string,MandateRequest>();
 let refundState:'processing'|'succeeded'|'failed'='succeeded',chargeCount=0;
 const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-annual-merchant',acknowledgement:{code:'SUCCESS'},
  create:async o=>{payments.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'pending',transactionId:null});return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-annual-'+o.id};},
  query:async o=>{const r=payments.get(o.id);assert.ok(r);return r;},verifyCallback:async()=>{throw Error('Synthetic authenticated adapter seam only');},
  recurring:{createMandate:async m=>{mandates.set(m.requestId,m);return{authorizationUrl:'https://synthetic.invalid/'+m.requestId};},
   queryMandate:async m=>({...m,mandateId:'synthetic-'+m.requestId,state:'active'}),cancelMandate:async m=>({...m,mandateId:m.mandateId??'synthetic-'+m.requestId,state:'cancelled'}),
   charge:async o=>{chargeCount++;const r:VerifiedPayment={orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'paid',transactionId:'synthetic-'+o.id,payerCash:{amountFen:o.amount_fen,currency:'CNY'}};payments.set(o.id,r);return r;}},
  refunds:{create:async o=>{const r:VerifiedRefund={refundId:o.id,orderId:o.order_id,merchantId:o.merchant_id,transactionId:o.provider_transaction_id,providerRefundId:'synthetic-'+o.id,currency:'CNY',orderAmountFen:o.order_amount_fen,amountFen:o.amount_fen,payerTotalFen:o.order_amount_fen,payerRefundFen:o.amount_fen,state:refundState,...(refundState==='failed'?{failureCode:'CLOSED'}:{})};refunds.set(o.id,r);return r;},
   query:async o=>{const r=refunds.get(o.id);assert.ok(r);return r;},verifyCallback:async()=>{throw Error('Synthetic only');}}};
 const setClock=(owner:string,at:string)=>pool.query('INSERT INTO bb_annual_test_clock VALUES($1,$2) ON CONFLICT(owner_user_id) DO UPDATE SET observed_at=EXCLUDED.observed_at',[owner,at]);
 const owner=async()=>{const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synthetic_annual_'+id.slice(0,8)]);await setClock(id,'2028-01-31T12:00:00.000Z');return id;};
 const buy=async(who:string,plan:'light'|'professional'|'intensive'='light',billing_cycle:'monthly'|'annual'='annual')=>{
  const input={request_id:uid(),plan_id:plan,provider:'wechat' as const,billing_cycle};
  const checkout=await createSubscriptionCheckout(pool,who,input,[provider]);
  const receipt:VerifiedPayment={...payments.get(checkout.order.order_id)!,state:'paid',transactionId:'synthetic-'+checkout.order.order_id,payerCash:{amountFen:checkout.order.amount_fen,currency:'CNY'}};
  await applyVerifiedPayment(pool,provider,receipt);return{...checkout,receipt,input};
 };
 const schedule=async(who:string)=>(await pool.query('SELECT r.* FROM bb_subscription_credit_releases r WHERE r.owner_user_id=$1 ORDER BY r.due_at,r.id',[who])).rows;
 const audit=async(who:string)=>{const result=await auditCredits(pool,who);assert.equal(result.consistent,true,JSON.stringify(result));};
 try{
  await t.test('real default clock retains exact milliseconds through verified payment and lot issuance',async()=>{
   const who=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[who,'synthetic_default_clock_'+who.slice(0,8)]);
   const a=await buy(who),rows=await schedule(who);assert.equal(rows.filter(r=>r.state==='issued').length,1);
   await applyVerifiedPayment(pool,provider,a.receipt);assert.equal(new Date(rows[0].expires_at).getTime()-new Date(rows[0].issued_at).getTime(),90*86400000);await audit(who);
  });
  // Only after verifying the production clock, replace this dedicated clone's
  // clock. Purchase and installment dates remain immutable throughout the test.
  await pool.query('CREATE TABLE bb_annual_test_clock(owner_user_id text PRIMARY KEY,observed_at timestamptz NOT NULL)');
  await pool.query("CREATE OR REPLACE FUNCTION bb_subscription_clock(p_owner text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT observed_at FROM bb_annual_test_clock WHERE owner_user_id=p_owner),date_trunc('milliseconds',now())) $$");
  await t.test('one annual payment creates twelve rights, only first month is issued, payment replay cannot mint the year',async()=>{
   const who=await owner(),a=await buy(who);assert.equal(a.order.amount_fen,214920);assert.equal(a.order.points,252000);
   await Promise.all([applyVerifiedPayment(pool,provider,a.receipt),applyVerifiedPayment(pool,provider,a.receipt)]);
   const rows=await schedule(who);assert.equal(rows.length,12);assert.equal(rows.filter(r=>r.state==='issued').length,1);
   assert.equal(rows.reduce((sum,r)=>sum+Number(r.amount_fen),0),214920);assert.equal(rows.reduce((sum,r)=>sum+Number(r.points),0),252000);
   const account=await subscriptionAccount(pool,who);assert.equal(account.available_points,'21000');assert.equal(account.periods[0].points,'252000');assert.equal(account.periods[0].monthly_points,'21000');
   assert.equal(account.subscription?.billing_cycle,'annual');assert.equal(account.subscription?.current_period_end,'2029-01-31T12:00:00.000Z');
   assert.equal(account.periods[0].released_count,1);assert.equal(account.periods[0].next_release_at,'2028-02-29T12:00:00.000Z');
   const detail=await subscriptionOrderPeriod(pool,who,a.order.order_id);assert.equal(detail.period?.monthly_points,'21000');assert.equal(detail.period?.available_points,'21000');
   const lot=(await pool.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1',[who])).rows[0];assert.equal(lot.cash_basis_fen,'17910');assert.equal(lot.cash_basis_points,'21000');
   assert.equal(new Date(lot.expires_at).getTime()-new Date(rows[0].issued_at).getTime(),90*86400000);
   await assert.rejects(transaction(pool,c=>grantCredits(c,{owner:who,source:'subscription',key:'subscription-release:'+rows[1].id,points:21000,expiresAt:'2028-04-30T12:00:00.000Z',actor:'synthetic',reason:'early issuance denied'})),{code:'23514'});
   await assert.rejects(pool.query("UPDATE bb_subscription_credit_releases SET due_at=due_at-interval '1 month' WHERE id=$1",[rows[1].id]),{code:'23514'});
   await setClock(who,'2028-02-07T12:00:00.001Z');assert.equal((await paymentRefundEligibility(pool,who,a.order.order_id,[provider])).enabled,false);
   await audit(who);
  });
  await t.test('cancelled renewal retains twelve monthly installments; retries, catch-up and calendar anchors preserve total cash',async()=>{
   const who=await owner(),a=await buy(who);await cancelSubscription(pool,who,a.subscription.id,uid(),[provider]);
   assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,0);
   const original=await schedule(who);assert.equal(new Date(original[2].due_at).toISOString(),'2028-03-31T12:00:00.000Z');
   // Delayed service catches up two due months with a full 90 days from issue.
   await setClock(who,'2028-04-10T12:00:00.000Z');
   await Promise.all([processDueSubscriptionCreditReleases(pool,100,who),processDueSubscriptionCreditReleases(pool,100,who)]);
   let rows=await schedule(who);assert.equal(rows.filter(r=>r.state==='issued').length,3);
   for(const r of rows.slice(1,3)){assert.equal(new Date(r.issued_at).toISOString(),'2028-04-10T12:00:00.000Z');assert.equal(new Date(r.expires_at).getTime()-new Date(r.issued_at).getTime(),90*86400000);}
   for(const due of original.slice(3)){await setClock(who,new Date(due.due_at).toISOString());await Promise.all([processDueSubscriptionCreditReleases(pool,100,who),processDueSubscriptionCreditReleases(pool,100,who)]);}
   rows=await schedule(who);assert.equal(rows.filter(r=>r.state==='issued').length,12);assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,0);
   const totals=(await pool.query('SELECT count(*)::int n,sum(original_points)::text points,sum(cash_basis_fen)::text basis FROM bb_credit_lots WHERE owner_user_id=$1',[who])).rows[0];
   assert.deepEqual(totals,{n:12,points:'252000',basis:'214920'});assert.equal((await pool.query('SELECT count(*)::int n FROM bb_payment_cash_proofs WHERE owner_user_id=$1',[who])).rows[0].n,1);
   await applyVerifiedPayment(pool,provider,a.receipt);assert.equal((await subscriptionAccount(pool,who)).subscription?.current_period_end,'2029-01-31T12:00:00.000Z');
   assert.ok(await resolveActiveSubscriptionPrice(pool,who));await audit(who);
   await setClock(who,'2029-01-31T12:00:00.000Z');assert.equal(await resolveActiveSubscriptionPrice(pool,who),null);
   assert.equal((await processDueSubscriptionRenewals(pool,[provider],50,who)).checked,0);
  });
  await t.test('seven-day unused annual whole-order refund removes only issued credits, blocks future grants and never refunds twice',async()=>{
   const who=await owner(),a=await buy(who,'intensive');assert.equal(a.order.amount_fen,1078920);refundState='processing';
   const eligibility=await paymentRefundEligibility(pool,who,a.order.order_id,[provider]);assert.equal(eligibility.refundable_fen,1078920);assert.equal(eligibility.refundable_points,114000);
   await assert.rejects(requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:89910},[provider]));
   const request={request_id:uid(),amount_fen:1078920};const r=await requestPaymentRefund(pool,who,a.order.order_id,request,[provider]);assert.equal(r.credit_points,114000);assert.equal(r.state,'processing');await audit(who);
   await setClock(who,'2028-03-01T12:00:00.000Z');assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,0);
   const receipt={...refunds.get(r.refund_id)!,state:'succeeded' as const};await applyVerifiedRefund(pool,provider,receipt);await applyVerifiedRefund(pool,provider,receipt);
   assert.equal((await requestPaymentRefund(pool,who,a.order.order_id,request,[provider])).refund_id,r.refund_id);
   await assert.rejects(requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:1078920},[provider]));
   const rows=await schedule(who);assert.equal(rows.filter(x=>x.state==='cancelled').length,11);assert.equal(rows.filter(x=>x.state==='issued').length,1);
   assert.equal((await subscriptionAccount(pool,who)).available_points,'0');assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,0);
   const sums=(await pool.query("SELECT sum(cash_refunded_fen)::text cash FROM bb_payment_refund_events WHERE owner_user_id=$1 AND kind='succeeded'",[who])).rows[0];assert.equal(sums.cash,'1078920');await audit(who);
  });
  await t.test('failed cash refund unfreezes its issued batch and allows overdue paid installments',async()=>{
   const who=await owner(),a=await buy(who);refundState='processing';const r=await requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:214920},[provider]);
   await setClock(who,'2028-03-01T12:00:00.000Z');assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,0);
   await applyVerifiedRefund(pool,provider,{...refunds.get(r.refund_id)!,state:'failed',failureCode:'CLOSED'});
   assert.equal((await processDueSubscriptionCreditReleases(pool,100,who)).issued,1);assert.equal((await subscriptionAccount(pool,who)).available_points,'42000');
   assert.equal((await paymentRefundEligibility(pool,who,a.order.order_id,[provider])).enabled,false);await audit(who);
  });
  await t.test('legacy monthly request hash survives omitted or explicit monthly; annual cannot reuse that request',async()=>{
   const who=await owner(),a=await buy(who,'light','monthly');
   const {billing_cycle,...legacy}=a.input;assert.equal((await createSubscriptionCheckout(pool,who,legacy,[provider])).order.order_id,a.order.order_id);
   assert.equal((await createSubscriptionCheckout(pool,who,a.input,[provider])).order.order_id,a.order.order_id);
   await assert.rejects(createSubscriptionCheckout(pool,who,{...a.input,billing_cycle:'annual'},[provider]),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
   assert.equal((await schedule(who)).length,0);assert.equal((await subscriptionAccount(pool,who)).available_points,'21000');await audit(who);
   await setSubscriptionAutoRenew(pool,who,a.subscription.id,{request_id:uid(),enabled:true},[provider]);await refreshSubscriptionMandate(pool,who,a.subscription.id,[provider]);
   await setClock(who,'2028-03-01T12:00:00.000Z');const annual={...a.input,request_id:uid(),billing_cycle:'annual' as const};
   await assert.rejects(createSubscriptionCheckout(pool,who,annual,[provider]),e=>(e as any).code==='PAYMENT_INVALID');
   await cancelSubscription(pool,who,a.subscription.id,uid(),[provider]);const changed=await createSubscriptionCheckout(pool,who,annual,[provider]);
   assert.equal(changed.subscription.billing_cycle,'annual');assert.equal(changed.subscription.auto_renew,false);assert.equal(changed.order.amount_fen,214920);
  });
  await t.test('year mandate binds annual amount/interval, can be reopened after cancellation, and charges once only at anniversary',async()=>{
   const who=await owner(),a=await buy(who);const first=await setSubscriptionAutoRenew(pool,who,a.subscription.id,{request_id:uid(),enabled:true},[provider]);assert.equal(first.subscription.mandate_status,'pending');
   let active=await refreshSubscriptionMandate(pool,who,a.subscription.id,[provider]);assert.equal(active.subscription.next_charge_amount_fen,214920);assert.equal(active.subscription.next_charge_at,'2029-01-31T12:00:00.000Z');
   const old=(await pool.query('SELECT mandate_request_id FROM bb_subscriptions WHERE id=$1',[a.subscription.id])).rows[0].mandate_request_id;
   assert.equal(mandates.get(old)?.interval,'year');await cancelSubscription(pool,who,a.subscription.id,uid(),[provider]);
   await setSubscriptionAutoRenew(pool,who,a.subscription.id,{request_id:uid(),enabled:true},[provider]);
   const newer=(await pool.query('SELECT mandate_request_id FROM bb_subscriptions WHERE id=$1',[a.subscription.id])).rows[0].mandate_request_id;assert.notEqual(newer,old);
   const stale:PaymentProvider={...provider,recurring:{...provider.recurring!,queryMandate:async()=>({...mandates.get(old)!,mandateId:'synthetic-'+old,state:'active'})}};
   await assert.rejects(refreshSubscriptionMandate(pool,who,a.subscription.id,[stale]),e=>(e as any).code==='PAYMENT_INVALID');
   const wrongInterval:PaymentProvider={...provider,recurring:{...provider.recurring!,queryMandate:async m=>({...m,interval:'month',mandateId:'synthetic-'+m.requestId,state:'active'})}};
   await assert.rejects(refreshSubscriptionMandate(pool,who,a.subscription.id,[wrongInterval]),e=>(e as any).code==='PAYMENT_INVALID');
   active=await refreshSubscriptionMandate(pool,who,a.subscription.id,[provider]);assert.equal(active.subscription.auto_renew,true);
   await setClock(who,'2028-02-29T12:00:00.000Z');const before=chargeCount;await processDueSubscriptionRenewals(pool,[provider],50,who);assert.equal(chargeCount,before);
   await setClock(who,'2029-01-31T12:00:00.000Z');await processDueSubscriptionCreditReleases(pool,100,who);
   await Promise.all([processDueSubscriptionRenewals(pool,[provider],50,who),processDueSubscriptionRenewals(pool,[provider],50,who)]);assert.equal(chargeCount,before+1);
   const account=await subscriptionAccount(pool,who);assert.equal(account.subscription?.current_period_end,'2030-01-31T12:00:00.000Z');assert.equal(account.periods.length,2);assert.equal(account.periods[0].released_count,1);await audit(who);
  });
  await t.test('actual review settlement uses annual lot consideration and disqualifies whole-contract cash withdrawal',async()=>{
   const who=await owner(),a=await buy(who,'professional'),bytes=new Map<string,Buffer>();
   const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async k=>bytes.get(k)??null,exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
   const origin='https://synthetic.invalid',app=createServer({pool,blobs,enableSyntheticQueue:true,enableSubscriptionBilling:true,principal:async()=>({userId:who,csrfVerified:true}),allowedOrigin:origin});
   const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin}});
   const ok=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
   try{
    const project=ok(await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic annual paid review',issuer_name:null,market:null,offering:null})).project_id;
    const upload=uid(),material=uid(),sha=digest('synthetic annual review'),base='/api/v1/projects/'+project;
    await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')",[upload,who,project,sha,'synthetic/'+upload]);
    await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')",[material,who,project,upload,sha,'synthetic/'+material]);
    const pin={material_id:material,material_version:1,sha256:sha};ok(await send('PUT',base+'/review-draft',{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}}));
    const intent={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const quote=ok(await send('POST',base+'/review-executions/quote',intent)).quote;
    const run=ok(await send('POST',base+'/review-executions',{...intent,quote_id:quote.quote_id}));
    assert.equal((await paymentRefundEligibility(pool,who,a.order.order_id,[provider])).enabled,false);
    const lease=await claim(pool,120,{runKinds:['review']});assert.ok(lease);assert.equal(lease.runId,run.run_id);
    const delivered=await syntheticReviewPair(pool,lease,blobs);await finish(pool,lease,'succeeded',{artifactId:delivered.artifactId,artifactVersion:1,blobs});
    assert.equal((await paymentRefundEligibility(pool,who,a.order.order_id,[provider])).enabled,false);
    await assert.rejects(requestPaymentRefund(pool,who,a.order.order_id,{request_id:uid(),amount_fen:538920},[provider]));
    const slice=(await pool.query(`SELECT l.cash_basis_fen::text,l.cash_basis_points::text,a.charged_points::text FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id JOIN bb_credit_reservations r ON r.id=a.reservation_id WHERE r.run_id=$1`,[run.run_id])).rows[0];
    assert.deepEqual(slice,{cash_basis_fen:'44910',cash_basis_points:'55000',charged_points:'27195'});await audit(who);
   }finally{await app.close();}
  });
 }finally{await pool.end();}
});
