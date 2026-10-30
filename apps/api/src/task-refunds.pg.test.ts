import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {transaction,uid,Problem,publicProblem,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {grantCredits,lockCreditAccount,creditBalanceExact} from './billing.js';
import {correctSettlement,auditCredits} from './billing-ops.js';
import {readRunEconomics} from './commerce-economics.js';
import {readSubscriptionFacts} from './subscription-facts-report.js';
import {grantBillingPermission,revokeBillingPermission} from './billing-permissions.js';
import {createSubscriptionCheckout} from './subscriptions.js';
import {createServiceTopup,applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {taskRefundEligibility,createTaskRefund,decideTaskRefund,listTaskRefunds,installTaskRefunds} from './task-refunds.js';
import {claim,enqueue,finish,promoteWordArtifact} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';

function memoryBlobs():PrivateBlobs{const m=new Map<string,Buffer>();return{put:async(k,b)=>{m.set(k,Buffer.from(b));},get:async k=>{const b=m.get(k);assert.ok(b);return b;},getIfExists:async k=>m.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=m.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>m.has(k),delete:async k=>{m.delete(k);}};}

const database=await isolatedTestDatabase(undefined,'task-quality-refunds');
test('task quality returns preserve frozen item/lot evidence, original cash rights and independent approval',{skip:!database,timeout:120000},async t=>{
  const pool=new Pool({connectionString:database}),payments=new Map<string,VerifiedPayment>();
  const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-task-refunds',acknowledgement:{code:'SUCCESS'},
    create:async o=>{payments.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'pending',transactionId:null});return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-refund-test'};},
    query:async o=>payments.get(o.id)!,verifyCallback:async()=>{throw Error('No real channel');}};
  const person=async()=>{const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synthetic_refund_'+id.slice(0,8)]);return id;};
  const reviewer=await person(),outsider=await person();
  const permission=await grantBillingPermission(pool,{requestId:uid(),userId:reviewer,permission:'task_refund_approve',actor:'synthetic-authority',reason:'Isolated synthetic test'});
  const pay=async(order:string)=>{const p=payments.get(order)!;await applyVerifiedPayment(pool,provider,{...p,state:'paid',transactionId:'synthetic-'+order,payerCash:{amountFen:p.amountFen,currency:'CNY'}});};
  async function funding(owner:string,mixed=false){
    if(mixed){const subscription=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:'light',provider:'wechat'},[provider]);await pay(subscription.order.order_id);
      await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:500,expiresAt:new Date(Date.now()+86400000).toISOString(),actor:'synthetic',reason:'Synthetic noncash promotional points'}));}
    const topup=await createServiceTopup(pool,owner,{request_id:uid(),provider:'wechat',amount_fen:mixed?5000:30000},[provider]);await pay(topup.order_id);
  }
  // A synthetic settled-task ledger fixture. No provider/model quality is claimed.
  // All scope guards, account locks, actual lot allocation triggers and immutable
  // records run normally; independent QA results are persisted with their hashes.
  async function fixture(owner:string,options:{mixed?:boolean;incomplete?:boolean;unmapped?:boolean;held?:boolean}={}){
    await funding(owner,options.mixed);
    const f=await transaction(pool,async c=>{
      await lockCreditAccount(c,owner);const project=uid(),run=uid(),quote=uid(),reservation=uid(),scope=uid(),total=options.unmapped?120:25000;
      const questions=[{id:'q0',question:'Synthetic quality item 1'},{id:'q1',question:'Synthetic quality item 2'}],manifest={questions,requirements:'Synthetic fixed scope'};
      const hash=inputManifestHash(manifest),result={answers:(options.incomplete?questions.slice(0,1):questions).map(q=>({question_id:q.id,answer:'Synthetic delivered answer'}))};
      const lines=questions.map(q=>({key:q.id,label:q.question,quantity:1,unit:'题',unit_price_fen:12500,amount_fen:12500,evidence:['Synthetic exact reviewed task scope']}));
      await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic task refund fixture','generation')",[project,owner]);
      await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[project,owner,hash,manifest]);
      await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')`,[run,owner,project,hash]);
      await c.query('INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,1,$4,$5,$6)',[run,owner,project,'answer',manifest,hash]);
      if(!options.unmapped)await c.query(`INSERT INTO bb_scope_quotations(id,owner_user_id,project_id,action,input_hash,snapshot,status,lines,amount_fen,approved_by,reason,published_at,price_version,expires_at)
        VALUES($1,$2,$3,'project_qa_answer',$4,$5,'quoted',$6,25000,'synthetic-reviewed-scope','Synthetic test of original quote items',now(),'outcome-cny-20261028-v1',now()+interval '1 day')`,[scope,owner,project,hash,manifest,JSON.stringify(lines)]);
      await c.query(`INSERT INTO bb_project_qa_quotes(id,owner_user_id,run_id,input_hash,question_count,unit_points,points,price_version,scope_quote_id,scope_lines,scope_work_hash)
        VALUES($1,$2,$3,$4,2,$8,$9,$10,$5,$6,$7)`,[quote,owner,run,hash,options.unmapped?null:scope,JSON.stringify(options.unmapped?[]:lines),options.unmapped?null:hash,options.unmapped?60:0,total,options.unmapped?'project-qa-question-60-v1':'outcome-cny-20261028-v1']);
      await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,state,charged_points,finalized_at,billing_policy)
        VALUES($1,$2,$3,$4,$5,'held',NULL,NULL,'on_delivery')`,[reservation,owner,run,quote,total]);
      await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run,reservation]);
      const lots=(await c.query("SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE",[owner])).rows;
      let left=BigInt(total);
      for(const lot of lots){const available=BigInt(lot.remaining)-BigInt(lot.frozen),take=left<available?left:available;if(!take)continue;
        await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservation,lot.id,String(take)]);
        await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lot.id,String(take)]);
        left-=take;if(!left)break;
      }
      await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$1,'reserve',$5,$3,$4,'synthetic','Synthetic accepted allocation')",[uid(),owner,reservation,run,total]);
      assert.equal(left,0n);return{run,reservation,scope,result};
    });
    if(options.held)return f;
    const blobs=memoryBlobs(),run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.run])).rows[0];
    await transaction(pool,c=>enqueue(c,run,'project_qa_v1'));const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,f.run);
    const doc=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic answers for task quality return'}),blobs,'generated_review_v1');
    const artifact=(await pool.query('SELECT * FROM bb_artifact_versions WHERE id=$1',[doc.artifactId])).rows[0];
    const result={...f.result,document:{sha256:artifact.sha256.trim(),key:artifact.object_key,byte_size:(await blobs.get(artifact.object_key)).length}};
    await pool.query('UPDATE bb_project_qa_runs SET result=$2,result_hash=$3 WHERE run_id=$1',[f.run,result,inputManifestHash(result)]);
    if(options.incomplete)await assert.rejects(finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs}),{code:'DELIVERY_FAILED'});
    else await finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
    return f;
  }
  try{
    await t.test('int64 issuance overflow rolls back the whole approval and preserves the original pending request',async()=>{
      const owner=await person(),f=await fixture(owner),eligibility=await taskRefundEligibility(pool,owner,f.run);
      const item=eligibility.units[0],request=await createTaskRefund(pool,owner,f.run,{request_id:uid(),item_ids:[item.item_id],reason:'Synthetic quality request before a subsequent large credit'});
      const before=await creditBalanceExact(pool,owner),max=9223372036854775807n,room=BigInt(item.charged_points)-1n;
      await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:max-before.available-before.frozen-room,expiresAt:null,actor:'synthetic',reason:'Synthetic verified right near the int64 representation boundary'}));
      const filled=await creditBalanceExact(pool,owner),decision={request_id:uid(),item_ids:[item.item_id],reason:'Synthetic approved original item'};
      assert.equal(filled.available,max-room);
      for(let attempt=0;attempt<2;attempt++)await assert.rejects(decideTaskRefund(pool,reviewer,request.refund_request_id,decision),{code:'DATA_UNAVAILABLE'});
      assert.deepEqual(await creditBalanceExact(pool,owner),filled);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_task_refund_decisions WHERE request_id=$1',[request.refund_request_id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_task_refund_credits WHERE reservation_id=$1',[f.reservation])).rows[0].n,0);
      const pending=await taskRefundEligibility(pool,owner,f.run);
      assert.equal(pending.requests[0].state,'requested');assert.equal(pending.requests[0].request_id,request.request_id);
      assert.equal(pending.units.find(u=>u.item_id===item.item_id)!.pending,true);
      assert.equal(pending.refunded_points,'0');
    });
    await t.test('acceptance commits independent units and cross-lot slices before any refund read; strings and no free approval',async()=>{
      const owner=await person(),f=await fixture(owner,{mixed:true});
      const captured=(await pool.query('SELECT * FROM bb_task_refund_units WHERE reservation_id=$1 ORDER BY ordinal',[f.reservation])).rows;
      assert.equal(captured.length,2);assert.equal(captured[0].evidence.capture,'acceptance_transaction');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_task_refund_unit_slices WHERE reservation_id=$1',[f.reservation])).rows[0].n,4);
      const before=await creditBalanceExact(pool,owner),e=await taskRefundEligibility(pool,owner,f.run);
      const initialEconomics=await readRunEconomics(pool,f.run);
      assert.equal(initialEconomics.consideration_complete,true);
      assert.deepEqual(initialEconomics.net_consideration_fen,{numerator:'23400',denominator:'1'},'500 promo points have no cash basis; 21000 subscription points carry 19900 fen, and 3500 topup points carry 3500 fen');
      assert.deepEqual(e.units.map(u=>u.charged_points),['12500','12500']);
      const body={request_id:uid(),item_ids:e.units.map(u=>u.item_id),reason:'Synthetic second item is incorrect'};
      const [a,b]=await Promise.all([createTaskRefund(pool,owner,f.run,body),createTaskRefund(pool,owner,f.run,body)]);assert.equal(a.refund_request_id,b.refund_request_id);assert.equal(a.refunded_points,'0');
      assert.deepEqual(await creditBalanceExact(pool,owner),before);
      await assert.rejects(createTaskRefund(pool,owner,f.run,{...body,reason:'Different request content'}),{code:'IDEMPOTENCY_CONFLICT'});
      await assert.rejects(createTaskRefund(pool,outsider,f.run,body),{code:'NOT_FOUND'});
      const decision={request_id:uid(),item_ids:[e.units[1].item_id],reason:'Synthetic quality audit confirms only item 2'};
      await assert.rejects(decideTaskRefund(pool,outsider,a.refund_request_id,decision),{code:'NOT_FOUND'});
      await grantBillingPermission(pool,{requestId:uid(),userId:owner,permission:'task_refund_approve',actor:'synthetic',reason:'Verify reviewer cannot self-approve'});
      await assert.rejects(decideTaskRefund(pool,owner,a.refund_request_id,decision),{code:'NOT_FOUND'});
      await pool.query("UPDATE bb_credit_lots SET expires_at=now()-interval '1 second' WHERE owner_user_id=$1 AND source='subscription'",[owner]);
      const results=await Promise.all([decideTaskRefund(pool,reviewer,a.refund_request_id,decision),decideTaskRefund(pool,reviewer,a.refund_request_id,decision)]);
      assert.equal(results[0].state,'partially_approved');assert.equal(results[0].refunded_points,'12500');assert.deepEqual(results[0],results[1]);
      const returned=(await pool.query(`SELECT l.* FROM bb_task_refund_credits t JOIN bb_credit_lots l ON l.id=t.return_lot_id WHERE t.reservation_id=$1 ORDER BY l.source`,[f.reservation])).rows;
      assert.equal(returned.length,2);const sub=returned.find(l=>l.source==='subscription'),cash=returned.find(l=>l.source==='purchase');
      assert.equal(sub.cash_basis_fen,'19900');assert.equal(sub.cash_basis_points,'21000');assert.equal(sub.original_points,'9000');assert.ok(new Date(sub.expires_at).getTime()>Date.now()+6.9*86400000);
      assert.equal(cash.cash_basis_fen,'5000');assert.equal(cash.cash_basis_points,'5000');assert.equal(cash.original_points,'3500');assert.equal(cash.expires_at,null);
      const partialEconomics=await readRunEconomics(pool,f.run);
      assert.equal(partialEconomics.consideration_complete,true);assert.equal(partialEconomics.service_compensation_points,'12500');
      assert.deepEqual(partialEconomics.cash_compensation_fen,{numerator:'84200',denominator:'7'},'new task-refund corrections reverse the original 9000/21000 subscription share and 3500 topup points exactly');
      assert.deepEqual(partialEconomics.net_consideration_fen,{numerator:'79600',denominator:'7'});
      assert.notEqual(partialEconomics.snapshot_hash,initialEconomics.snapshot_hash);
      assert.equal((await pool.query('SELECT bb_task_item_was_refunded($1,$2,$3) a,bb_task_item_was_refunded($1,$2,$4) b',[owner,f.run,'q0','q1'])).rows[0].a,false);
      assert.equal((await taskRefundEligibility(pool,owner,f.run)).units[0].available_points,'12500','unapproved item can be reapplied and keeps its coverage');
      const rest=await createTaskRefund(pool,owner,f.run,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic fresh evidence on first item'});
      await decideTaskRefund(pool,reviewer,rest.refund_request_id,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic verified first item'});
      const promo=(await pool.query(`SELECT l.* FROM bb_task_refund_credits t JOIN bb_credit_lots l ON l.id=t.return_lot_id JOIN bb_credit_lots origin ON origin.id=t.origin_lot_id WHERE t.reservation_id=$1 AND origin.source='existing_grant'`,[f.reservation])).rows[0];
      assert.equal(promo.cash_basis_fen,'0');assert.equal(promo.cash_basis_points,'1');assert.equal((await taskRefundEligibility(pool,owner,f.run)).refunded_points,'25000');
      const finalEconomics=await readRunEconomics(pool,f.run);
      assert.equal(finalEconomics.consideration_complete,true);assert.deepEqual(finalEconomics.net_consideration_fen,{numerator:'0',denominator:'1'});
      assert.equal(finalEconomics.after_tax_net_profit,null,'returning points does not assert actual company profitability');
      const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7),monthly=await readSubscriptionFacts(pool,month,month);
      for(const origin of [cash.cash_origin_lot_id,sub.cash_origin_lot_id]){
        const batch=monthly.original_batches.find(b=>b.origin_lot_id===origin);assert.ok(batch);assert.equal(batch.consideration_complete,true);
        assert.deepEqual(batch.net_earned_order_consideration_fen,{numerator:'0',denominator:'1'},'monthly original-lot facts include exact task-quality reversals without double-counting returned credits');
      }
      assert.deepEqual(await correctSettlement(pool,{runId:f.run,actor:'synthetic-repair',reason:'Already fully returned'}),[]);
      // Restore the synthetic time-travel mutation before the independent audit
      // compares each original purchase lot to its immutable period terms.
      await pool.query('UPDATE bb_credit_lots l SET expires_at=p.credits_expires_at FROM bb_subscription_periods p WHERE l.id=p.lot_id AND l.owner_user_id=$1',[owner]);
      const audit=await auditCredits(pool);assert.equal(audit.consistent,true,JSON.stringify(audit));
    });
    await t.test('concurrent whole repair and partial approval cannot exceed original charge',async()=>{
      const owner=await person(),f=await fixture(owner),e=await taskRefundEligibility(pool,owner,f.run),r=await createTaskRefund(pool,owner,f.run,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic partial concern'});
      await Promise.allSettled([decideTaskRefund(pool,reviewer,r.refund_request_id,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Confirmed'}),correctSettlement(pool,{runId:f.run,actor:'synthetic-repair',reason:'Whole original task correction'})]);
      const returned=(await pool.query("SELECT sum(points)::text n FROM bb_credit_events WHERE reservation_id=$1 AND kind='correction'",[f.reservation])).rows[0].n;assert.equal(returned,'25000');
      await correctSettlement(pool,{runId:f.run,actor:'synthetic-repair',reason:'Idempotent replay'});
      assert.equal((await taskRefundEligibility(pool,owner,f.run)).refunded_points,'25000');assert.equal((await auditCredits(pool)).consistent,true);
    });
    await t.test('missing independent delivery, held work and rejected requests never issue a return',async()=>{
      const owner=await person(),f=await fixture(owner,{incomplete:true}),e=await taskRefundEligibility(pool,owner,f.run);
      assert.equal(e.enabled,false);assert.equal(e.units[1].available_points,'0');await assert.rejects(createTaskRefund(pool,owner,f.run,{request_id:uid(),item_ids:[e.units[1].item_id],reason:'Undelivered unit'}));
      const rejectedOwner=await person(),valid=await fixture(rejectedOwner),validE=await taskRefundEligibility(pool,rejectedOwner,valid.run);
      const r=await createTaskRefund(pool,rejectedOwner,valid.run,{request_id:uid(),item_ids:[validE.units[0].item_id],reason:'Delivered item concern'});
      assert.equal((await decideTaskRefund(pool,reviewer,r.refund_request_id,{request_id:uid(),item_ids:[],reason:'Synthetic review found no error'})).state,'rejected');
      assert.equal((await taskRefundEligibility(pool,owner,f.run)).refunded_points,'0');
      const held=await fixture(await person(),{held:true});assert.equal((await pool.query('SELECT count(*)::int n FROM bb_task_refund_units WHERE reservation_id=$1',[held.reservation])).rows[0].n,2,'real held acceptance commit captured units');
      assert.equal((await taskRefundEligibility(pool,(await pool.query('SELECT owner_user_id FROM bb_runs WHERE id=$1',[held.run])).rows[0].owner_user_id,held.run)).enabled,false);
    });
    await t.test('legacy whole-task refund revokes every dependent item, without inventing separate historic allocations',async()=>{
      const owner=await person(),f=await fixture(owner,{unmapped:true}),e=await taskRefundEligibility(pool,owner,f.run);
      assert.equal(e.units.length,1);assert.equal(e.units[0].evidence_kind,'legacy_task');assert.equal(e.units[0].charged_points,'120');
      const r=await createTaskRefund(pool,owner,f.run,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic historic task quality concern'});
      await decideTaskRefund(pool,reviewer,r.refund_request_id,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic whole original task correction'});
      const flags=(await pool.query('SELECT bb_task_item_was_refunded($1,$2,$3) a,bb_task_item_was_refunded($1,$2,$4) b',[owner,f.run,'q0','q1'])).rows[0];
      assert.deepEqual(flags,{a:true,b:true});
    });
    await t.test('HTTP rejects client-supplied amounts, isolates owners, and permissions revoke independently',async()=>{
      const owner=await person(),f=await fixture(owner),app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
      app.setErrorHandler((e,r,reply)=>e instanceof Problem?reply.code(e.status).send(publicProblem(e,r.id)):reply.code((e as any).statusCode??500).send({message:e instanceof Error?e.message:String(e)}));
      installTaskRefunds(app,{db:()=>pool,owner:async r=>String(r.headers['x-synthetic-user'])});
      const get=await app.inject({method:'GET',url:`/api/v1/tasks/${f.run}/refund-eligibility`,headers:{'x-synthetic-user':owner}});assert.equal(get.statusCode,200,get.body);assert.equal(typeof get.json().charged_points,'string');
      const payload={request_id:uid(),item_ids:[get.json().units[0].item_id],reason:'Synthetic',points:'1'};
      const invalid=await app.inject({method:'POST',url:`/api/v1/tasks/${f.run}/refund-requests`,headers:{'x-synthetic-user':owner},payload});assert.equal(invalid.statusCode,400);
      const foreign=await app.inject({method:'GET',url:`/api/v1/tasks/${f.run}/refund-eligibility`,headers:{'x-synthetic-user':outsider}});assert.equal(foreign.statusCode,404);
      await app.close();assert.ok((await listTaskRefunds(pool,reviewer)).items.length);
      await revokeBillingPermission(pool,{requestId:uid(),grantId:permission,actor:'synthetic-authority',reason:'Revoke test reviewer'});
      await assert.rejects(listTaskRefunds(pool,reviewer),{code:'NOT_FOUND'});
    });
  }finally{await pool.end();}
});
