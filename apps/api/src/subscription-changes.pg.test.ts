import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {uid,digest,type PrivateBlobs} from './data.js';
import {applyVerifiedPayment,type VerifiedPayment,type PaymentProvider} from './payments.js';
import {applyVerifiedRefund,paymentRefundEligibility,requestPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {createSubscriptionCheckout,subscriptionAccount,setSubscriptionAutoRenew,refreshSubscriptionMandate,type MandateRequest} from './subscriptions.js';
import {createSubscriptionChangeQuote,createSubscriptionChangeCheckout} from './subscription-changes.js';
import {auditCredits,correctSettlement} from './billing-ops.js';
import {createServer} from './server.js';
import {claim,finish,action} from './queue.js';
import {syntheticReviewPair} from './review-delivery-test-fixture.js';
import {grantBillingPermission} from './billing-permissions.js';
import {taskRefundEligibility,createTaskRefund,decideTaskRefund} from './task-refunds.js';

const database=await isolatedTestDatabase(undefined,'subscription-changes-core');
test('subscription changes preserve actual task charges, pending rights and exact funding',{skip:!database,timeout:180000},async t=>{
 const pool=new Pool({connectionString:database}),payments=new Map<string,VerifiedPayment>(),refunds=new Map<string,VerifiedRefund>(),mandates=new Map<string,MandateRequest>();
 const cancelled:MandateRequest[]=[];let cancelUnknown=false,refundState:'succeeded'|'processing'|'failed'='succeeded';
 const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-change-core',acknowledgement:{},
  create:async o=>{payments.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'pending',transactionId:null});return{checkoutUrl:'https://synthetic.invalid/'+o.id};},
  query:async o=>payments.get(o.id)!,verifyCallback:async()=>{throw Error('Synthetic only');},
  closePayment:async o=>({...payments.get(o.id)!,state:'expired',transactionId:null}),
  recurring:{createMandate:async m=>{mandates.set(m.requestId,m);return{authorizationUrl:'https://synthetic.invalid/'+m.requestId};},
   queryMandate:async m=>({...m,mandateId:m.mandateId??'mandate_'+m.requestId,state:'active'}),
   cancelMandate:async m=>{cancelled.push(m);if(cancelUnknown)throw Error('Synthetic cancellation timeout');return{...m,mandateId:m.mandateId??'mandate_'+m.requestId,state:'cancelled'};},
   charge:async()=>{throw Error('No recurring cash call permitted in core change test');}},
  refunds:{create:async o=>{const r:VerifiedRefund={refundId:o.id,orderId:o.order_id,merchantId:o.merchant_id,transactionId:o.provider_transaction_id,providerRefundId:'refund_'+o.id,
   currency:'CNY',orderAmountFen:o.order_amount_fen,amountFen:o.amount_fen,payerTotalFen:o.order_amount_fen,payerRefundFen:o.amount_fen,state:refundState,...(refundState==='failed'?{failureCode:'CLOSED'}:{})};refunds.set(o.id,r);return r;},
   query:async o=>refunds.get(o.id)!,verifyCallback:async()=>{throw Error('Synthetic only');}}};
 const user=async()=>{const owner=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'change_core_'+owner.slice(0,8)]);return owner;};
 const pay=async(order:string,cash=true)=>{const pending=payments.get(order)!;const receipt:VerifiedPayment={...pending,state:'paid',transactionId:'paid_'+order,...(cash?{payerCash:{amountFen:pending.amountFen,currency:'CNY'}}:{})};payments.set(order,receipt);return applyVerifiedPayment(pool,provider,receipt);};
 const buy=async(owner:string,proof=true)=>{const a=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:'professional',provider:'wechat'},[provider]);await pay(a.order.order_id,proof);return a;};
 const quote=(owner:string,plan_id:'professional'|'intensive'='professional',billing_cycle:'monthly'|'annual'='annual')=>createSubscriptionChangeQuote(pool,owner,{request_id:uid(),plan_id,billing_cycle});
 const checkout=(owner:string,quote_id:string,request_id=uid())=>createSubscriptionChangeCheckout(pool,owner,{request_id,quote_id,provider:'wechat'},[provider]);
 const clean=async(owner:string)=>{const report=await auditCredits(pool,owner);assert.equal(report.consistent,true,JSON.stringify(report));};
 async function review(owner:string,deliver:boolean){
  const data=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{data.set(k,Buffer.from(b));},get:async k=>{const b=data.get(k);assert.ok(b);return b;},getIfExists:async k=>data.get(k)??null,getIfExistsBounded:async k=>data.get(k)??null,exists:async k=>data.has(k),delete:async k=>{data.delete(k);}};
  const origin='https://synthetic.invalid',app=createServer({pool,blobs,enableSyntheticQueue:true,enableSubscriptionBilling:true,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
  const call=async(method:string,url:string,payload?:any)=>{const r=await app.inject({method:method as any,url,payload,headers:{origin}});assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
  try{
   const project=(await call('POST','/api/v1/projects',{kind:'review',name:'Synthetic subscription-change review',issuer_name:null,market:null,offering:null})).project_id;
   const upload=uid(),material=uid(),sha=digest('synthetic change review'),base='/api/v1/projects/'+project;
   await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')",[upload,owner,project,sha,'synthetic/'+upload]);
   await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')",[material,owner,project,upload,sha,'synthetic/'+material]);
   const pin={material_id:material,material_version:1,sha256:sha};await call('PUT',base+'/review-draft',{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}});
   const intent={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
   const quoted=await call('POST',base+'/review-executions/quote',intent),run=await call('POST',base+'/review-executions',{...intent,quote_id:quoted.quote.quote_id});
   assert.equal((await pool.query('SELECT points FROM bb_credit_reservations WHERE run_id=$1',[run.run_id])).rows[0].points,'27195');
   if(deliver){const lease=await claim(pool,120,{runKinds:['review']});assert.ok(lease);assert.equal(lease.runId,run.run_id);const output=await syntheticReviewPair(pool,lease,blobs);await finish(pool,lease,'succeeded',{artifactId:output.artifactId,artifactVersion:1,blobs});}
   return run.run_id as string;
  }finally{await app.close();}
 }
 try{
  await t.test('real delivered review reduces original consideration and fractional rounding is only a concession',async()=>{
   const owner=await user();await buy(owner);await review(owner,true);const q=await quote(owner);
   assert.equal(q.quote.transfer_points,'27805');assert.equal(q.quote.credit_offset_fen,'25227');assert.equal(q.quote.pay_now_fen,'513693');
   const changed=await checkout(owner,q.quote.quote_id);await pay(changed.order.order_id);
   assert.equal((await subscriptionAccount(pool,owner)).available_points,'55000');await clean(owner);
   const p=(await pool.query('SELECT consideration_numerator,consideration_denominator,points,face_amount_fen,amount_fen FROM bb_subscription_periods WHERE order_id=$1',[changed.order.order_id])).rows[0];
   assert.equal(BigInt(p.consideration_numerator)*55000n*BigInt(p.points),(513693n*55000n+49900n*27805n)*BigInt(p.consideration_denominator));
   assert.equal(p.face_amount_fen,'538920');assert.equal(p.amount_fen,'513693');
  });
  await t.test('in-flight task rights are excluded; unknown payment holds only unused rights and cannot duplicate orders',async()=>{
   const owner=await user(),old=await buy(owner),run=await review(owner,false),q=await quote(owner),key=uid();
   assert.equal(q.quote.excluded_held_points,'27195');assert.equal(q.quote.transfer_points,'27805');
   const first=await checkout(owner,q.quote.quote_id,key),replay=await checkout(owner,q.quote.quote_id,key);assert.equal(first.order.order_id,replay.order.order_id);
   await applyVerifiedPayment(pool,provider,payments.get(first.order.order_id)!);
   const pending=await subscriptionAccount(pool,owner);assert.equal(pending.task_held_points,'27195');assert.equal(pending.change_held_points,'27805');assert.equal(pending.available_points,'0');await clean(owner);
   await assert.rejects(()=>pay(first.order.order_id,false),(e:any)=>e.code==='PAYMENT_INVALID');
   assert.equal((await pool.query('SELECT state FROM bb_recharge_orders WHERE id=$1',[first.order.order_id])).rows[0].state,'pending');
   assert.equal((await subscriptionAccount(pool,owner)).change_held_points,'27805','Unproved new cash cannot consume original rights');
   await pay(first.order.order_id);const original=(await pool.query("SELECT remaining,frozen FROM bb_credit_lots WHERE source_key='recharge:'||$1",[old.order.order_id])).rows[0];
   assert.deepEqual(original,{remaining:'27195',frozen:'27195'});await action(pool,owner,run,'cancel',uid());
   assert.equal((await subscriptionAccount(pool,owner)).available_points,'82195');assert.equal((await subscriptionAccount(pool,owner)).task_held_points,'0');await clean(owner);
  });
  await t.test('stale quote rejection permanently fences its key even after original balance is restored',async()=>{
   const owner=await user();await buy(owner);const q=await quote(owner),run=await review(owner,false),key=uid();
   await assert.rejects(()=>checkout(owner,q.quote.quote_id,key),(e:any)=>e.code==='SUBSCRIPTION_CHANGE_QUOTE_STALE');
   await action(pool,owner,run,'cancel',uid());await assert.rejects(()=>checkout(owner,q.quote.quote_id,key),(e:any)=>e.code==='SUBSCRIPTION_CHANGE_QUOTE_STALE');
   assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2',[owner,key])).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_change_rejections WHERE owner_user_id=$1 AND request_id=$2',[owner,key])).rows[0].n,1);await clean(owner);
  });
  await t.test('selective quality return and whole correction preserve mixed funding and remain convertible',async()=>{
   const owner=await user();await buy(owner);const q=await quote(owner,'intensive','monthly'),changed=await checkout(owner,q.quote.quote_id);await pay(changed.order.order_id);
   const run=await review(owner,true),eligibility=await taskRefundEligibility(pool,owner,run),items=eligibility.units.filter(u=>BigInt(u.available_points)>0n).map(u=>u.item_id);assert.ok(items.length);
   const request=await createTaskRefund(pool,owner,run,{request_id:uid(),item_ids:items,reason:'Synthetic original quality return'}),reviewer=await user();
   await grantBillingPermission(pool,{requestId:uid(),userId:reviewer,permission:'task_refund_approve',actor:'synthetic',reason:'Independent quality review'});
   await decideTaskRefund(pool,reviewer,request.refund_request_id,{request_id:uid(),item_ids:items,reason:'Synthetic source-preserving approval'});
   assert.equal((await subscriptionAccount(pool,owner)).available_points,'114000');
   const returned=(await pool.query("SELECT id,cash_order_id,cash_basis_fen,cash_basis_points FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key LIKE 'task-refund:%'",[owner])).rows;
   assert.ok(returned.length);for(const lot of returned){assert.equal(lot.cash_order_id,null);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_subscription_lot_funding WHERE lot_id=$1',[lot.id])).rows[0].n,2);}
   assert.equal((await paymentRefundEligibility(pool,owner,changed.order.order_id,[provider])).enabled,false,'Returned credits do not erase consumption history');
   const secondRun=await review(owner,true);await correctSettlement(pool,{runId:secondRun,actor:'synthetic',reason:'Whole settlement source correction'});
   assert.equal((await subscriptionAccount(pool,owner)).available_points,'114000');const annual=await quote(owner,'intensive','annual');assert.equal(annual.quote.credit_offset_fen,'99900');
   const final=await checkout(owner,annual.quote.quote_id);await pay(final.order.order_id);await clean(owner);
  });
  await t.test('old mandate must be cancelled at old amount and new annual renewal requires a new mandate',async()=>{
   const owner=await user(),old=await buy(owner);await setSubscriptionAutoRenew(pool,owner,old.subscription.id,{request_id:uid(),enabled:true},[provider]);
   await refreshSubscriptionMandate(pool,owner,old.subscription.id,[provider]);const q=await quote(owner),key=uid();
   const oldKey=(await pool.query('SELECT request_id FROM bb_recharge_orders WHERE id=$1',[old.order.order_id])).rows[0].request_id,cancellationsBefore=cancelled.length;
   await assert.rejects(()=>checkout(owner,q.quote.quote_id,oldKey),(e:any)=>e.code==='IDEMPOTENCY_CONFLICT');
   assert.equal(cancelled.length,cancellationsBefore,'A colliding request must fail before cancelling the original renewal');
   assert.equal((await subscriptionAccount(pool,owner)).subscription?.mandate_status,'active');cancelUnknown=true;
   await assert.rejects(()=>checkout(owner,q.quote.quote_id,key),(e:any)=>e.code==='SUBSCRIPTION_CHANGE_MANDATE_PENDING');
   assert.equal((await subscriptionAccount(pool,owner)).change_held_points,'0');assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1',[owner])).rows[0].n,1);
   cancelUnknown=false;const changed=await checkout(owner,q.quote.quote_id,key);await pay(changed.order.order_id);
   assert.equal(cancelled.at(-1)!.amountFen,49900);assert.equal(cancelled.at(-1)!.interval,'month');
   const account=await subscriptionAccount(pool,owner);assert.equal(account.subscription?.auto_renew,false);assert.equal(account.subscription?.billing_cycle,'annual');
   await setSubscriptionAutoRenew(pool,owner,old.subscription.id,{request_id:uid(),enabled:true},[provider]);
   const newest=[...mandates.values()].at(-1)!;assert.equal(newest.amountFen,538920);assert.equal(newest.interval,'year');await clean(owner);
  });
  await t.test('cash proof gaps and unknown/refused refund cannot manufacture transfer or restoration',async()=>{
   const missing=await user();await buy(missing,false);await assert.rejects(()=>quote(missing),(e:any)=>e.code==='DATA_UNAVAILABLE');assert.equal((await subscriptionAccount(pool,missing)).available_points,'55000');
   const owner=await user();await buy(owner);const q=await quote(owner,'intensive','monthly'),changed=await checkout(owner,q.quote.quote_id);await pay(changed.order.order_id);
   refundState='processing';const refund=await requestPaymentRefund(pool,owner,changed.order.order_id,{request_id:uid(),amount_fen:50000},[provider]);assert.equal(refund.state,'processing');
   assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key LIKE 'subscription-change-restore:%'",[owner])).rows[0].n,0);await clean(owner);
   await applyVerifiedRefund(pool,provider,{...refunds.get(refund.refund_id)!,state:'failed',failureCode:'CLOSED'});assert.equal((await subscriptionAccount(pool,owner)).available_points,'114000');await clean(owner);
   refundState='succeeded';const success=await requestPaymentRefund(pool,owner,changed.order.order_id,{request_id:uid(),amount_fen:50000},[provider]);assert.equal(success.state,'succeeded');assert.equal((await subscriptionAccount(pool,owner)).available_points,'55000');await clean(owner);
  });
  await t.test('mixed contract cannot omit either exact consideration scalar at INSERT',async()=>{
   const owner=await user();await buy(owner);const q=await quote(owner,'intensive','monthly'),changed=await checkout(owner,q.quote.quote_id);await pay(changed.order.order_id);
   for(const missing of ['consideration_numerator','consideration_denominator']){
    const c=await pool.connect();try{
     await c.query('BEGIN');const newOrder=uid().replaceAll('-','');
     await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind)
       SELECT $2,owner_user_id,$3,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind FROM bb_recharge_orders WHERE id=$1`,[changed.order.order_id,newOrder,uid()]);
     await assert.rejects(()=>c.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,billing_cycle,funding_kind,face_amount_fen,consideration_numerator,consideration_denominator)
       SELECT $2,owner_user_id,subscription_id,cycle_index+1,$3,plan_id,catalog_version,amount_fen,points,task_price_version,billing_cycle,funding_kind,face_amount_fen,${missing==='consideration_numerator'?'NULL':'consideration_numerator'},${missing==='consideration_denominator'?'NULL':'consideration_denominator'} FROM bb_subscription_periods WHERE order_id=$1`,
       [changed.order.order_id,uid(),newOrder]),(e:any)=>e.code==='23514'&&e.table==='bb_subscription_periods');
    }finally{await c.query('ROLLBACK');c.release();}
   }
   await clean(owner);
  });
 }finally{await pool.end();}
});
