import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {Pool} from 'pg';
import {transaction} from './data.js';
import {grantBillingPermission} from './billing-permissions.js';
import {auditCreditClient,auditCredits} from './billing-audit.js';
import {assertWalletWritable,assertChannelWritable,inspectAndIsolateBillingScope,scanAndIsolateBilling,resumeBillingScope,
  repairWalletProjection,billingAuditHash,withBillingDispatch,lockWalletSafetyForControl,type BillingChannelScope,type ChannelSafetyVerifier} from './billing-safety.js';
import {quoteM4,reserveM4} from './m4-billing.js';
import {createServiceTopup,applyVerifiedPayment,type PaymentProvider} from './payments.js';
import {requestPaymentRefund,type RefundOrder,type VerifiedRefund} from './payment-refunds.js';
import {isolatedTestDatabase} from './test-database.js';

// Synthetic ledger projections and verified-channel fixtures only. No live
// payment/model endpoint, customer wallet or production repair is exercised.
const database=await isolatedTestDatabase(undefined,'billing-safety');
async function owner(pool:Pool,points='1000',remaining=points){
  const owner=randomUUID(),lot=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'safety_'+owner.slice(0,8)]);
  await pool.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1)',[owner]);
  await pool.query("INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining) VALUES($1,$2,'existing_grant',$1,$3,$4)",[lot,owner,points,remaining]);
  await pool.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason) VALUES($1,$2,$1,'grant',$3,$1,'synthetic','Synthetic fixture')",[lot,owner,points]);
  return{owner,lot};
}
async function repairer(pool:Pool,permission:'billing_repair'|'price_publish'='billing_repair'){
  const actor=(await owner(pool)).owner;
  await grantBillingPermission(pool,{requestId:randomUUID(),userId:actor,permission,actor:'synthetic',reason:'Synthetic independent authority'});return actor;
}
const request=(actor:string)=>({requestId:randomUUID(),actor,reason:'Synthetic safety validation'});
const scope=(owner:string)=>({kind:'wallet' as const,owner});

test('durable wallet isolation, exact authorized projection repair and separate resumption preserve original facts',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const wallet=await owner(pool,'9007199254740993','9007199254740992'),unaffected=await owner(pool),actor=await repairer(pool),outsider=await repairer(pool,'price_publish');
    const original=(await pool.query('SELECT original_points,source,source_key,cash_basis_fen FROM bb_credit_lots WHERE id=$1',[wallet.lot])).rows[0];
    const originalEvents=(await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id',[wallet.owner])).rows;
    const initial=await auditCredits(pool,wallet.owner);assert.equal(initial.lotDrift.length,1);assert.equal(initial.lotDrift[0].expected_remaining,'9007199254740993');
    assert.equal((await transaction(pool,c=>auditCreditClient(c,unaffected.owner))).consistent,true,'owner filter cannot inherit another wallet fault');
    const aborted=await pool.connect();await aborted.query('BEGIN');
    let isolated:Awaited<ReturnType<typeof inspectAndIsolateBillingScope>>;
    try{await aborted.query('UPDATE bb_users SET username=username WHERE id=$1',[unaffected.owner]);isolated=await inspectAndIsolateBillingScope(pool,scope(wallet.owner));}
    finally{await aborted.query('ROLLBACK');aborted.release();}
    assert.equal(isolated!.status,'isolated');assert.equal((await inspectAndIsolateBillingScope(pool,scope(wallet.owner))).incidentId,isolated!.incidentId);
    await assert.rejects(transaction(pool,c=>assertWalletWritable(c,wallet.owner)),{code:'BILLING_NOT_READY'});
    await transaction(pool,c=>assertWalletWritable(c,unaffected.owner));
    assert.equal((await pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[wallet.lot])).rows[0].remaining,'9007199254740992','reads and original state remain available');
    await assert.rejects(repairWalletProjection(pool,{...request(outsider),owner:wallet.owner,expectedAuditHash:billingAuditHash(initial)}),{status:404});
    await assert.rejects(resumeBillingScope(pool,{...request(outsider),scope:scope(wallet.owner)}),{status:404});
    const dirty=await resumeBillingScope(pool,{...request(actor),scope:scope(wallet.owner)});assert.equal(dirty.status,'still_isolated');
    assert.equal((await pool.query('SELECT operation FROM bb_billing_safety_audit WHERE id=$1',[dirty.eventId])).rows[0].operation,'recheck_failed');
    const stale=await repairWalletProjection(pool,{...request(actor),owner:wallet.owner,expectedAuditHash:'0'.repeat(64)});assert.equal(stale.status,'rejected');assert.equal(stale.reason,'audit_changed');
    const repairInput={...request(actor),owner:wallet.owner,expectedAuditHash:billingAuditHash(initial)};
    const repair=await repairWalletProjection(pool,repairInput);assert.equal(repair.status,'repaired');
    assert.deepEqual(await repairWalletProjection(pool,repairInput),repair,'a retried repair returns its immutable first result');
    await assert.rejects(repairWalletProjection(pool,{...repairInput,reason:'different'}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal((await auditCredits(pool,wallet.owner)).consistent,true);
    await assert.rejects(transaction(pool,c=>assertWalletWritable(c,wallet.owner)),{code:'BILLING_NOT_READY'},'repair never auto-resumes');
    const resumeInput={...request(actor),scope:scope(wallet.owner)},resumed=await resumeBillingScope(pool,resumeInput);assert.equal(resumed.status,'resumed');
    assert.deepEqual(await resumeBillingScope(pool,resumeInput),resumed);
    await transaction(pool,c=>assertWalletWritable(c,wallet.owner));
    assert.deepEqual((await pool.query('SELECT original_points,source,source_key,cash_basis_fen FROM bb_credit_lots WHERE id=$1',[wallet.lot])).rows[0],original);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id',[wallet.owner])).rows,originalEvents);
    await assert.rejects(pool.query("UPDATE bb_billing_safety_audit SET reason='tampered' WHERE id=$1",[repair.eventId]),{code:'23514'});
    await assert.rejects(pool.query('DELETE FROM bb_billing_safety_incidents WHERE id=$1',[isolated!.incidentId]),{code:'23514'});
    await assert.rejects(pool.query('UPDATE bb_billing_safety_blocks SET resume_event_id=NULL WHERE incident_id=$1',[isolated!.incidentId]),{code:'23514'});
  }finally{await pool.end();}
});

test('exclusive recheck waits for an in-flight writer and never isolates a legitimate intermediate state',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const wallet=await owner(pool),writer=await pool.connect();await writer.query('BEGIN');
    let done=false;
    try{
      await assertWalletWritable(writer,wallet.owner);await writer.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE',[wallet.owner]);
      await writer.query('UPDATE bb_credit_lots SET remaining=999 WHERE id=$1',[wallet.lot]);
      assert.equal((await auditCredits(pool,wallet.owner)).consistent,true,'uncommitted projection changes are invisible to candidate scans');
      const checking=inspectAndIsolateBillingScope(pool,scope(wallet.owner)).then(result=>{done=true;return result;});
      await setTimeout(80);assert.equal(done,false,'exclusive safety check waits for the shared writer');
      await writer.query('UPDATE bb_credit_lots SET remaining=1000 WHERE id=$1',[wallet.lot]);await writer.query('COMMIT');
      assert.equal((await checking).status,'healthy');
      assert.equal((await pool.query('SELECT count(*) FROM bb_billing_safety_incidents WHERE owner_user_id=$1',[wallet.owner])).rows[0].count,'0');
    }finally{await writer.query('ROLLBACK');writer.release();}
    // A stale candidate that was inconsistent before the lock wait is also rechecked.
    const stale=await owner(pool,'1000','999'),fixing=await pool.connect();await fixing.query('BEGIN');
    try{
      await assertWalletWritable(fixing,stale.owner);await fixing.query('UPDATE bb_credit_lots SET remaining=1000 WHERE id=$1',[stale.lot]);
      const checking=inspectAndIsolateBillingScope(pool,scope(stale.owner));await setTimeout(40);await fixing.query('COMMIT');
      assert.equal((await checking).status,'healthy','READ COMMITTED must observe the writer commit after waiting');
    }finally{await fixing.query('ROLLBACK');fixing.release();}
  }finally{await pool.end();}
});

test('channel mismatch blocks only that merchant; no verifier, unknown and malformed evidence cannot resume',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const actor=await repairer(pool),channel:BillingChannelScope={kind:'channel',provider:'wechat',merchantId:'synthetic-'+randomUUID()};
    const mismatched:ChannelSafetyVerifier=async()=>({status:'verified',evidenceIds:['synthetic-authenticated-statement'],differences:[{kind:'settlement_mismatch',expected:'1000',observed:'999'}]});
    const clean:ChannelSafetyVerifier=async()=>({status:'verified',evidenceIds:['synthetic-authenticated-recheck'],differences:[]});
    const isolated=await inspectAndIsolateBillingScope(pool,channel,mismatched);assert.equal(isolated.status,'isolated');
    await assert.rejects(transaction(pool,c=>assertChannelWritable(c,channel.provider,channel.merchantId)),{code:'BILLING_NOT_READY'});
    await transaction(pool,c=>assertChannelWritable(c,channel.provider,channel.merchantId+'-other'));
    assert.equal((await resumeBillingScope(pool,{...request(actor),scope:channel})).status,'unverified');
    assert.equal((await resumeBillingScope(pool,{...request(actor),scope:channel},async()=>({status:'unknown',reason:'channel unavailable'}))).status,'unverified');
    assert.equal((await resumeBillingScope(pool,{...request(actor),scope:channel},async()=>({status:'verified',evidenceIds:[],differences:[]}))).status,'unverified');
    assert.equal((await resumeBillingScope(pool,{...request(actor),scope:channel},mismatched)).status,'still_isolated');
    assert.equal((await resumeBillingScope(pool,{...request(actor),scope:channel},clean)).status,'resumed');
    await transaction(pool,c=>assertChannelWritable(c,channel.provider,channel.merchantId));
    assert.equal((await pool.query('SELECT count(*) FROM bb_billing_safety_audit WHERE incident_id=$1',[isolated.incidentId])).rows[0].count,'6');
    const before=(await pool.query('SELECT count(*) FROM bb_billing_safety_incidents')).rows[0].count;
    const unknown={...channel,merchantId:channel.merchantId+'-unknown'};
    assert.equal((await inspectAndIsolateBillingScope(pool,unknown,async()=>({status:'unknown',reason:'timeout'}))).status,'unverified');
    const scan=await scanAndIsolateBilling(pool,{channels:[unknown],verifyChannel:async()=>{throw Error('Synthetic database/channel failure');}});
    assert(scan.errors.some(error=>error.scope.kind==='channel'&&error.scope.merchantId===unknown.merchantId));
    assert.equal((await pool.query('SELECT count(*) FROM bb_billing_safety_incidents')).rows[0].count,before,'unknown errors cannot manufacture an invariant incident');
  }finally{await pool.end();}
});

test('committed payment/credit mismatch isolates wallet and channel and rejects projection-only repair',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const wallet=await owner(pool),actor=await repairer(pool),order=randomUUID(),merchant='synthetic-local-'+randomUUID();
    await pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at)
      VALUES($1,$2,$1,$3,'wechat','service_balance','synthetic',1000,1000,'CNY',$4,now()+interval '1 hour')`,[order,wallet.owner,'a'.repeat(64),merchant]);
    // Synthetic fault: an issued purchase lot with its original payment still pending.
    await pool.query(`INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining)
      VALUES($1,$2,'purchase',$3,1000,1000)`,[randomUUID(),wallet.owner,'recharge:'+order]);
    const report=await auditCredits(pool,wallet.owner);assert.equal(report.paymentDrift.length,1);
    const scan=await scanAndIsolateBilling(pool);assert(scan.results.some(result=>result.scope.kind==='wallet'&&result.scope.owner===wallet.owner&&result.status==='isolated'));
    assert(scan.results.some(result=>result.scope.kind==='channel'&&result.scope.merchantId===merchant&&result.status==='isolated'));
    await assert.rejects(transaction(pool,c=>assertWalletWritable(c,wallet.owner)),{code:'BILLING_NOT_READY'});
    await assert.rejects(transaction(pool,c=>assertChannelWritable(c,'wechat',merchant)),{code:'BILLING_NOT_READY'});
    const result=await repairWalletProjection(pool,{...request(actor),owner:wallet.owner,expectedAuditHash:billingAuditHash(report)});
    assert.equal(result.status,'rejected');assert.equal(result.reason,'non_projection_difference');
    assert.equal((await pool.query('SELECT state FROM bb_recharge_orders WHERE id=$1',[order])).rows[0].state,'pending');
    assert.equal((await resumeBillingScope(pool,{...request(actor),scope:{kind:'channel',provider:'wechat',merchantId:merchant}},async()=>({status:'verified',evidenceIds:['synthetic'],differences:[]}))).status,'still_isolated','remote evidence cannot hide a local ledger mismatch');
    const again=await scanAndIsolateBilling(pool);assert(!again.results.some(result=>result.scope.kind==='wallet'&&result.scope.owner===wallet.owner),'active incidents do not flood the audit or consume the batch limit');
  }finally{await pool.end();}
});

test('committed dispatch holds shared safety through external work; isolation stops later dispatch but keeps exit controls available',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const wallet=await owner(pool),channel:BillingChannelScope={kind:'channel',provider:'wechat',merchantId:'synthetic-dispatch-'+randomUUID()};
    let release!:()=>void,started!:()=>void;
    const external=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const dispatch=withBillingDispatch(pool,wallet.owner,channel.provider,channel.merchantId,async()=>{started();await external;return'original-request-only';});await entered;
    let isolated=false;
    const blocking=inspectAndIsolateBillingScope(pool,channel,async()=>({status:'verified',evidenceIds:['synthetic-dispatch-evidence'],differences:[{kind:'cash_mismatch'}]})).then(result=>{isolated=true;return result;});
    await setTimeout(60);assert.equal(isolated,false,'external create/charge cannot race beyond an already admitted shared safety section');
    release();assert.equal(await dispatch,'original-request-only');assert.equal((await blocking).status,'isolated');
    let called=false;await assert.rejects(withBillingDispatch(pool,wallet.owner,channel.provider,channel.merchantId,async()=>{called=true;}),{code:'BILLING_NOT_READY'});assert.equal(called,false);
    await pool.query('UPDATE bb_credit_lots SET remaining=999 WHERE id=$1',[wallet.lot]);await inspectAndIsolateBillingScope(pool,scope(wallet.owner));
    await assert.rejects(transaction(pool,c=>assertWalletWritable(c,wallet.owner)),{code:'BILLING_NOT_READY'});
    await transaction(pool,async c=>{await lockWalletSafetyForControl(c,wallet.owner);await c.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE',[wallet.owner]);});
  }finally{await pool.end();}
});

async function heldQa(pool:Pool,wallet:{owner:string;lot:string}){
  const project=randomUUID(),run=randomUUID(),quote=randomUUID(),reservation=randomUUID(),hash='b'.repeat(64);
  await transaction(pool,async c=>{
    await assertWalletWritable(c,wallet.owner);await c.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE',[wallet.owner]);
    await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic safety task','generation')",[project,wallet.owner]);
    await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,wallet.owner,hash]);
    await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')",[run,wallet.owner,project,hash]);
    await c.query("INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,1,'answer',$5,$4)",[run,wallet.owner,project,hash,{questions:[{id:'q0',question:'Synthetic safety question'}]}]);
    await c.query("INSERT INTO bb_project_qa_quotes(id,owner_user_id,run_id,input_hash,question_count,unit_points,points,price_version) VALUES($1,$2,$3,$4,1,60,60,'project-qa-question-60-v1')",[quote,wallet.owner,run,hash]);
    await c.query('INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points) VALUES($1,$2,$3,$4,60)',[reservation,wallet.owner,run,quote]);
    await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run,reservation]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,60)',[reservation,wallet.lot]);
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+60 WHERE id=$1',[wallet.lot]);
    await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$1,'reserve',60,$3,$4,'synthetic','Synthetic task reserve')",[randomUUID(),wallet.owner,reservation,run]);
  });return{run,reservation};
}

test('direct SQL finalization observes safety before wallet lock for original and M4 task families',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const wallet=await owner(pool),task=await heldQa(pool,wallet),actor=await repairer(pool);
    assert.equal((await auditCredits(pool,wallet.owner)).consistent,true);
    const controller=await pool.connect();await controller.query('BEGIN');
    try{
      await controller.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['billing-safety:wallet:'+wallet.owner]);
      let finished=false;const finalizing=pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[task.run]).then(result=>{finished=true;return result;});
      await setTimeout(60);assert.equal(finished,false);
      const probe=await pool.connect();await probe.query('BEGIN');
      try{await probe.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE NOWAIT',[wallet.owner]);}
      finally{await probe.query('ROLLBACK');probe.release();}
      await controller.query('COMMIT');await finalizing;
    }finally{await controller.query('ROLLBACK');controller.release();}
    assert.equal((await auditCredits(pool,wallet.owner)).consistent,true);
    const blocked=await heldQa(pool,wallet);await pool.query('UPDATE bb_credit_lots SET remaining=999 WHERE id=$1',[wallet.lot]);
    await inspectAndIsolateBillingScope(pool,scope(wallet.owner));
    await assert.rejects(pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[blocked.run]),{code:'55000'});
    assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE id=$1',[blocked.reservation])).rows[0].state,'held');
    const audited=await auditCredits(pool,wallet.owner);assert.equal((await repairWalletProjection(pool,{...request(actor),owner:wallet.owner,expectedAuditHash:billingAuditHash(audited)})).status,'repaired');
    await resumeBillingScope(pool,{...request(actor),scope:scope(wallet.owner)});await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[blocked.run]);
    assert.equal((await auditCredits(pool,wallet.owner)).consistent,true);

    const m4=await owner(pool,'10000'),project=randomUUID(),topic=randomUUID(),run=randomUUID(),hash='c'.repeat(64);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic safety M4','generation')",[project,m4.owner]);
    await pool.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash) VALUES($1,$2,$3,'Synthetic safety topic',$1,$4)",[topic,m4.owner,project,hash]);
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,m4.owner,hash]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')",[run,m4.owner,project,hash]);
    const q=await transaction(pool,c=>quoteM4(c,m4.owner,topic,'m4_G02',hash,{}));
    await transaction(pool,c=>reserveM4(c,m4.owner,{id:run},q.quote.quote_id,topic,hash));
    await pool.query('UPDATE bb_credit_lots SET remaining=9999 WHERE id=$1',[m4.lot]);await inspectAndIsolateBillingScope(pool,scope(m4.owner));
    await assert.rejects(pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run]),{code:'55000'});
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[run])).rows[0].state,'queued');
    const definitions=(await pool.query("SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.proname=ANY($1::text[])",[['bb_credit_finalize_run','bb_m4_credit_finalize_run','bb_payment_refund_credit_guard','bb_payment_refund_allocation_guard','bb_task_refund_credit_guard','bb_capture_task_refund_units']])).rows;
    assert.equal(definitions.length,6);
    for(const row of definitions)assert(row.definition.indexOf('bb_assert_wallet_writable')<row.definition.indexOf('PERFORM 1 FROM bb_credit_accounts'),row.proname+' must guard before its original wallet lock');
  }finally{await pool.end();}
});

test('isolated refund permits schedule metadata but rejects state or credit changes without blocking other wallets',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const customer=await owner(pool),merchant='synthetic-refund-schedule-'+randomUUID();
    const receipt=(order:RefundOrder):VerifiedRefund=>({refundId:order.id,orderId:order.order_id,merchantId:merchant,transactionId:order.provider_transaction_id,
      providerRefundId:'synthetic-'+order.id,currency:'CNY',orderAmountFen:order.order_amount_fen,amountFen:order.amount_fen,payerTotalFen:order.order_amount_fen,payerRefundFen:order.amount_fen,state:'processing'});
    const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>({checkoutUrl:'https://synthetic.invalid/checkout'}),
      query:async()=>{throw Error('Synthetic test does not query payment');},verifyCallback:async()=>{throw Error('No callback');},
      refunds:{create:async order=>receipt(order),query:async order=>receipt(order),verifyCallback:async()=>{throw Error('No callback');}}};
    const order=await createServiceTopup(pool,customer.owner,{request_id:randomUUID(),provider:'wechat',amount_fen:2000},[provider]);
    await applyVerifiedPayment(pool,provider,{orderId:order.order_id,merchantId:merchant,amountFen:2000,currency:'CNY',transactionId:'synthetic-'+order.order_id,state:'paid',payerCash:{amountFen:2000,currency:'CNY'}});
    const refund=await requestPaymentRefund(pool,customer.owner,order.order_id,{request_id:randomUUID(),amount_fen:100},[provider]);
    const other=await owner(pool),otherOrder=await createServiceTopup(pool,other.owner,{request_id:randomUUID(),provider:'wechat',amount_fen:2000},[provider]);
    await applyVerifiedPayment(pool,provider,{orderId:otherOrder.order_id,merchantId:merchant,amountFen:2000,currency:'CNY',transactionId:'synthetic-'+otherOrder.order_id,state:'paid',payerCash:{amountFen:2000,currency:'CNY'}});
    const otherRefund=await requestPaymentRefund(pool,other.owner,otherOrder.order_id,{request_id:randomUUID(),amount_fen:100},[provider]);
    assert.equal(refund.state,'processing');await pool.query('UPDATE bb_credit_lots SET remaining=999 WHERE id=$1',[customer.lot]);
    await inspectAndIsolateBillingScope(pool,scope(customer.owner));
    const before=(await pool.query('SELECT state,credit_points,amount_fen FROM bb_payment_refunds WHERE id=$1',[refund.refund_id])).rows[0];
    const scheduled=await pool.query("UPDATE bb_payment_refunds SET reconcile_attempts=reconcile_attempts+1,next_reconcile_at=now()+interval '1 minute',updated_at=now() WHERE id=ANY($1::text[])",[[refund.refund_id,otherRefund.refund_id]]);
    assert.equal(scheduled.rowCount,2,'an isolated refund cannot abort the healthy refund in a scheduling batch');
    assert.deepEqual((await pool.query('SELECT state,credit_points,amount_fen FROM bb_payment_refunds WHERE id=$1',[refund.refund_id])).rows[0],before);
    await assert.rejects(pool.query('UPDATE bb_payment_refunds SET credit_points=credit_points-1 WHERE id=$1',[refund.refund_id]),{code:'55000'});
  }finally{await pool.end();}
});

test('projection repair cannot restore individually valid lots into an overflowing account total',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const max=9223372036854775807n,wallet=await owner(pool,max.toString(),(max-200n).toString()),actor=await repairer(pool),second=randomUUID();
    await pool.query("INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining) VALUES($1,$2,'existing_grant',$1,100,100)",[second,wallet.owner]);
    const report=await auditCredits(pool,wallet.owner);await inspectAndIsolateBillingScope(pool,scope(wallet.owner));
    const result=await repairWalletProjection(pool,{...request(actor),owner:wallet.owner,expectedAuditHash:billingAuditHash(report)});
    assert.equal(result.status,'rejected');assert.equal(result.reason,'derived_account_out_of_range');
    assert.equal((await pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[wallet.lot])).rows[0].remaining,(max-200n).toString());
    await assert.rejects(transaction(pool,c=>assertWalletWritable(c,wallet.owner)),{code:'BILLING_NOT_READY'});
  }finally{await pool.end();}
});
