import {safeBillingNumber} from '@bondbuddy/contracts';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {createWechatPayProvider} from './wechat-pay.js';
import {syntheticWechatFixture} from './test-wechat-pay-fixtures.js';
import {creditBalance,grantCredits,lockCreditAccount,publishPrices} from './billing.js';
import {auditCredits,correctSettlement} from './billing-ops.js';
import {createRecharge,type PaymentProvider} from './payments.js';
import {digest,Problem,transaction,type PrivateBlobs} from './data.js';
import {requestPaymentRefund,type RefundOrder} from './payment-refunds.js';
import {enqueue,claim,promoteWordArtifact,checkpointStage,finish} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import {parsePaymentStatement} from './payment-statements-format.js';
import {syntheticTradeStatement,statementFixtureDate} from './test-payment-statements.js';

const database=process.env.BB_TEST_DATABASE_URL;

async function setup(){
  // Each merchant-day statement must see only this case's channel population.
  const isolated=await isolatedTestDatabase(undefined,'original-cash-refunds-'+randomUUID());
  const pool=new Pool({connectionString:isolated}),f=syntheticWechatFixture(Date.now()),owner=randomUUID();let actor:string=owner,creates=0,queries=0;
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_refund_'+owner.slice(0,8)]);
  await publishPrices(pool,{id:'synthetic-refund-price',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'Synthetic isolated refund-allocation price fixture'});
  const channel=new Map<string,any>(),orders=new Map<string,any>(),refundIds=new Set<string>();let mode:'processing'|'timeout'|'success'|'closed'='processing';
  const provider=createWechatPayProvider({...f.options,refundNotifyUrl:'https://bondbuddy.example/api/v1/payments/wechat/refund-callback'},
    {now:()=>f.now,fetch:async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v3/pay/transactions/native')return f.response({code_url:'weixin://wxpay/bizpayurl?pr=synthetic-refund-payment'});
      if(init?.method==='POST'){
        assert.equal(path,'/v3/refund/domestic/refunds');creates++;
        const body=JSON.parse(String(init.body)),original=orders.get(body.transaction_id);assert.ok(original);refundIds.add(body.out_refund_no);
        const stored=(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1',[body.out_refund_no])).rows[0];assert.equal(stored.state,'processing');assert.ok(stored.dispatch_started_at);
        const allocations=(await pool.query(`SELECT a.points,l.frozen FROM bb_payment_refund_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id WHERE a.refund_id=$1`,[stored.id])).rows;
        assert.equal(allocations.reduce((n,a)=>n+Number(a.points),0),Number(stored.credit_points));
        for(const a of allocations)assert.ok(Number(a.frozen)>=Number(a.points),'All original-source credit freezes commit before any external request');
        assert.equal(body.amount.total,original.amount_fen);assert.equal(body.amount.currency,'CNY');
        const prior=channel.get(body.out_refund_no);
        if(prior){assert.equal(prior.transaction_id,body.transaction_id);assert.equal(prior.amount.refund,body.amount.refund);assert.equal(prior.amount.total,body.amount.total);}
        const receipt=prior??{out_refund_no:body.out_refund_no,out_trade_no:original.order_id,transaction_id:body.transaction_id,refund_id:'wx_'+body.out_refund_no.slice(0,27),
          channel:'ORIGINAL',status:mode==='success'?'SUCCESS':mode==='closed'?'CLOSED':'PROCESSING',
          amount:{total:original.amount_fen,refund:body.amount.refund,payer_total:original.amount_fen,payer_refund:body.amount.refund,currency:'CNY'}};
        channel.set(body.out_refund_no,receipt);if(mode==='timeout')throw Error('Synthetic accepted request with lost response');return f.response(receipt);
      }
      assert.match(path,/^\/v3\/refund\/domestic\/refunds\//);queries++;
      const id=decodeURIComponent(path.split('/').at(-1)!),receipt=channel.get(id);if(!receipt)return new Response('synthetic not found',{status:404});return f.response(receipt);
    }});
  const app=createServer({pool,enableOutcomePricing:true,paymentProviders:[provider],allowedOrigin:'http://refund.test',principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin:'http://refund.test',...headers}});
  const paymentCallback=async(order:any,payer:number|null=safeBillingNumber(order.amount_fen))=>{
    order={...order,amount_fen:safeBillingNumber(order.amount_fen),points:safeBillingNumber(order.points)};
    const transactionId='txn_'+order.order_id,amount={total:order.amount_fen,currency:'CNY',...(payer===null?{}:{payer_total:payer,payer_currency:'CNY'})};
    orders.set(transactionId,order);
    const envelope=f.envelope({...f.paid,out_trade_no:order.order_id,transaction_id:transactionId,amount,success_time:statementFixtureDate+'T12:00:00+08:00'});
    const response=await send('POST','/api/v1/payments/wechat/callback',envelope.raw,{'content-type':'application/json',...envelope.headers as Record<string,string>});assert.equal(response.statusCode,200,response.body);return envelope;
  };
  const topup=async(amount:number,payer:number|null=amount)=>{
    const response=await send('POST','/api/v1/commerce/topups',{request_id:randomUUID(),provider:'wechat',amount_fen:String(amount)});assert.equal(response.statusCode,201,response.body);
    const order=response.json(),envelope=await paymentCallback(order,payer);return {...order,envelope};
  };
  const refundCallback=(id:string,changes:Record<string,unknown>={},valid=true)=>{
    const receipt=channel.get(id);assert.ok(receipt);
    const value={...receipt,mchid:f.options.merchantId,refund_status:receipt.status,...changes};
    const envelope=f.envelope(value,{event_type:`REFUND.${value.refund_status}`},{original_type:'refund'});
    return send('POST','/api/v1/payments/wechat/refund-callback',envelope.raw,{'content-type':'application/json',...envelope.headers as Record<string,string>,...(!valid?{'wechatpay-signature':'invalid'}:{})});
  };
  const request=(order:string,amount:number,key=randomUUID())=>send('POST',`/api/v1/commerce/topups/${order}/refunds`,{request_id:key,amount_fen:String(amount)});
  const requestPoints=(order:string,points:number,key=randomUUID(),expected?:number)=>send('POST',`/api/v1/commerce/topups/${order}/refunds`,{request_id:key,points:String(points),...(expected===undefined?{}:{expected_amount_fen:String(expected)})});
  const eligibility=(id:string)=>send('GET',`/api/v1/commerce/topups/${id}/refund-eligibility`);
  const readLot=async(id:string)=>(await pool.query("SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key='recharge:'||$2",[owner,id])).rows[0];
  return {pool,f,owner,provider,app,send,topup,paymentCallback,refundCallback,request,requestPoints,eligibility,readLot,channel,orders,
    setActor:(value:string)=>{actor=value;},setMode:(value:typeof mode)=>{mode=value;},counts:()=>({creates,queries,refundIds:[...refundIds]}),close:async()=>{await app.close();await pool.end();}};
}

function memoryBlobs():PrivateBlobs{
  const values=new Map<string,Buffer>();return {put:async(k,b)=>{values.set(k,Buffer.from(b));},get:async k=>{const b=values.get(k);assert.ok(b);return b;},getIfExists:async k=>values.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=values.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>values.has(k),delete:async k=>{values.delete(k);}};
}
/** Synthetic fixtures allocate the named original cash lot under production account locks.
 * Settled work then passes through real immutable Word promotion and delivery finalization. */
async function syntheticTask(pool:Pool,owner:string,lotId:string,points:number,state:'held'|'settled'='held'){
  const project=randomUUID(),run=randomUUID(),quote=randomUUID(),reservation=randomUUID(),hash=digest(run);
  await transaction(pool,async c=>{
    await lockCreditAccount(c,owner);
    const lot=(await c.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,lotId])).rows[0];
    if(Number(lot.remaining)-Number(lot.frozen)<points)throw new Problem(402,'CREDITS_INSUFFICIENT','Synthetic task cannot spend frozen money');
    await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic refund allocation','generation')",[project,owner]);
    await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{\"draft_revision\":1}','[]','[]')",[project,owner,hash]);
    const task=(await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *`,[run,owner,project,hash])).rows[0];
    await c.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
      VALUES($1,$2,$3,1,$4,(SELECT id FROM bb_credit_price_versions WHERE pricing_mode='legacy_credit' ORDER BY effective_at LIMIT 1),'new_authoring',$5,'Synthetic prior ledger fixture')`,[quote,owner,project,hash,points]);
    await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,state,billing_policy)
      VALUES($1,$2,$3,$4,$5,'held','on_delivery')`,[reservation,owner,run,quote,points]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservation,lotId,points]);
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lotId,points]);
    await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$1,'reserve',$3,$4,$5,'synthetic','Synthetic task allocation')",[randomUUID(),owner,points,reservation,run]);
    await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run,reservation]);
    if(state==='settled')await enqueue(c,task);
  });
  if(state==='settled'){
    const blobs=memoryBlobs(),lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run);
    const revised=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic refund allocation revision'}),blobs,'generated_pair_v1');
    const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic refund allocation clean copy'}),blobs,'generated_pair_v1');
    await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revised.artifactId,clean_artifact_id:clean.artifactId});
    await finish(pool,lease,'succeeded',{artifactId:revised.artifactId,artifactVersion:1,blobs});
  }
  return run;
}

test('synthetic signed cash refunds bind original payment/lot, exclude consumed/held/noncash money and settle once under callback/query concurrency',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const first=await h.topup(10000),second=await h.topup(5000),discount=await h.topup(2000,1),unknown=await h.topup(1000,null);
    const grantLot=await transaction(h.pool,c=>grantCredits(c,{owner:h.owner,source:'existing_grant',key:'synthetic-noncash-grant',points:777,expiresAt:null,actor:'synthetic',reason:'Synthetic noncash money'}));
    const old=await createRecharge(h.pool,h.owner,{request_id:randomUUID(),provider:'wechat',pack_id:'cny500'},[h.provider]);await h.paymentCallback(old,null);
    const firstLot=await h.readLot(first.order_id),secondLot=await h.readLot(second.order_id);
    await syntheticTask(h.pool,h.owner,firstLot.id,2000,'settled');const held=await syntheticTask(h.pool,h.owner,firstLot.id,3000);
    assert.equal((await h.eligibility(first.order_id)).json().refundable_fen,"5000");
    assert.equal((await h.eligibility(discount.order_id)).json().enabled,false);assert.equal((await h.eligibility(discount.order_id)).json().paid_amount_fen,"1");
    assert.equal((await h.eligibility(unknown.order_id)).json().paid_amount_fen,null);assert.equal((await h.eligibility(old.order_id)).json().enabled,false);
    assert.equal((await h.request(discount.order_id,1)).statusCode,409);assert.equal((await h.request(unknown.order_id,1)).statusCode,409);assert.equal((await h.request(old.order_id,1)).statusCode,409);
    assert.equal((await h.request(first.order_id,5001)).statusCode,409,'Other paid lots and gifts cannot replace original unused balance');
    const key=randomUUID(),created=await h.request(first.order_id,4000,key);assert.equal(created.statusCode,202,created.body);const refund=created.json();assert.equal(refund.state,'processing');
    assert.equal((await h.readLot(first.order_id)).frozen, '7000');assert.equal((await h.readLot(first.order_id)).remaining,'8000');
    const replay=await Promise.all([h.request(first.order_id,4000,key),h.request(first.order_id,4000,key)]);replay.forEach(r=>assert.equal(r.json().refund_id,refund.refund_id));assert.equal(h.counts().creates,1);
    assert.equal((await h.request(first.order_id,3999,key)).statusCode,409);assert.equal((await h.request(first.order_id,1)).statusCode,409,'One active refund per original order');
    const original=h.channel.get(refund.refund_id);original.status='SUCCESS';
    const forged=await h.refundCallback(refund.refund_id,{},false);assert.equal(forged.statusCode,401);
    for(const changes of [{mchid:'1900000002'},{transaction_id:'another_txn'},{out_trade_no:second.order_id},
      {amount:{...original.amount,refund:3999,payer_refund:3999}},{amount:{...original.amount,currency:'USD'}},{refund_id:'different_channel_refund'},
      {out_refund_no:'unknown_refund'}]){
      // The first processing receipt already pinned the channel refund ID.
      const response=await h.refundCallback(refund.refund_id,changes);assert.ok([401,404,409,422].includes(response.statusCode),response.body);
    }
    assert.equal((await h.readLot(first.order_id)).remaining,'8000');
    const settled=await Promise.all([h.refundCallback(refund.refund_id),h.refundCallback(refund.refund_id),h.send('POST',`/api/v1/commerce/refunds/${refund.refund_id}/refresh`,{})]);settled.forEach(r=>assert.equal(r.statusCode,200,r.body));
    const final=await h.readLot(first.order_id);assert.equal(final.remaining,'4000');assert.equal(final.frozen,'3000');
    assert.equal((await h.pool.query("SELECT count(*)::int n,sum(cash_refunded_fen)::int cash FROM bb_payment_refund_events WHERE refund_id=$1 AND kind='succeeded'",[refund.refund_id])).rows[0].cash,4000);
    assert.equal((await h.readLot(second.order_id)).remaining,secondLot.remaining);assert.equal((await h.pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[grantLot])).rows[0].remaining,'777');
    await h.send('POST','/api/v1/payments/wechat/callback',first.envelope.raw,{'content-type':'application/json',...first.envelope.headers});assert.equal((await h.readLot(first.order_id)).remaining,'4000','Paid callback replay cannot reissue refunded credit');
    assert.equal((await h.send('GET',`/api/v1/commerce/topups/${first.order_id}`)).json().state,'paid');
    await h.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[held]);assert.equal((await h.eligibility(first.order_id)).json().refundable_fen,"4000");
    h.setMode('success');const rest=await h.request(first.order_id,4000);assert.equal(rest.json().state,'succeeded',rest.body);assert.equal((await h.readLot(first.order_id)).remaining,'0');
    const report=await auditCredits(h.pool);assert.equal(report.consistent,true,JSON.stringify(report));
    await assert.rejects(()=>h.pool.query('UPDATE bb_payment_refunds SET amount_fen=1 WHERE id=$1',[refund.refund_id]),/locked/);
    await assert.rejects(()=>h.pool.query('UPDATE bb_payment_cash_proofs SET cash_amount_fen=1 WHERE order_id=$1',[first.order_id]),/append only/);
    await assert.rejects(()=>h.pool.query('DELETE FROM bb_payment_refund_events WHERE refund_id=$1',[refund.refund_id]),/append only/);
    h.setActor('foreign_owner');assert.equal((await h.eligibility(first.order_id)).statusCode,404);assert.equal((await h.send('GET',`/api/v1/commerce/refunds/${refund.refund_id}`)).statusCode,404);assert.equal((await h.send('POST',`/api/v1/commerce/refunds/${refund.refund_id}/refresh`,{})).statusCode,404);
  }finally{await h.close();}
});

test('synthetic timeout/unknown retains freeze, reconciles same refund ID, and explicit CLOSED releases without reusing a failed request',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const order=await h.topup(1000);h.setMode('timeout');const key=randomUUID(),requested=await h.request(order.order_id,600,key);assert.equal(requested.statusCode,202,requested.body);const refund=requested.json();assert.equal(refund.state,'processing');
    assert.deepEqual(await creditBalance(h.pool,h.owner),{available:400,frozen:600});assert.equal((await h.request(order.order_id,600,key)).json().refund_id,refund.refund_id);assert.equal(h.counts().creates,1);
    h.channel.delete(refund.refund_id);assert.equal((await h.send('POST',`/api/v1/commerce/refunds/${refund.refund_id}/refresh`,{})).json().state,'processing');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:400,frozen:600});
    const row=(await h.pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1',[refund.refund_id])).rows[0];
    const receipt={out_refund_no:row.id,out_trade_no:row.order_id,transaction_id:row.provider_txn_id,refund_id:'wx_'+row.id.slice(0,27),status:'ABNORMAL',
      amount:{total:1000,refund:600,payer_total:1000,payer_refund:600,currency:'CNY'}};h.channel.set(row.id,receipt);
    assert.equal((await h.send('POST',`/api/v1/commerce/refunds/${row.id}/refresh`,{})).json().state,'processing');assert.equal((await h.readLot(order.order_id)).frozen,'600');
    receipt.status='SUCCESS';const recovered=await h.send('POST',`/api/v1/commerce/refunds/${row.id}/refresh`,{});assert.equal(recovered.json().state,'succeeded',recovered.body);assert.deepEqual(await creditBalance(h.pool,h.owner),{available:400,frozen:0});
    assert.equal(h.counts().creates,2,'Unknown query permits one same-request resend, not another refund ID');assert.deepEqual(h.counts().refundIds,[row.id]);
    h.setMode('closed');const failedKey=randomUUID(),failed=await h.request(order.order_id,300,failedKey);assert.equal(failed.json().state,'failed',failed.body);assert.equal(failed.json().failure_code,'CLOSED');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:400,frozen:0});
    assert.equal((await h.request(order.order_id,300,failedKey)).json().refund_id,failed.json().refund_id);assert.equal(h.counts().creates,3);assert.equal(h.counts().refundIds.length,2);
    assert.equal((await h.request(order.order_id,301,failedKey)).statusCode,409);
    h.setMode('success');const explicit=await h.request(order.order_id,300);assert.equal(explicit.json().state,'succeeded',explicit.body);assert.equal(h.counts().creates,4);assert.equal(h.counts().refundIds.length,3);assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100,frozen:0});
    assert.equal((await h.refundCallback(failed.json().refund_id,{refund_status:'SUCCESS'})).statusCode,409,'Conflicting terminal outcome needs reconciliation, not another debit');
    const report=await auditCredits(h.pool);assert.equal(report.consistent,true,JSON.stringify(report));
    const disabled=createServer({pool:h.pool,enableOutcomePricing:true,paymentProviders:[{...h.provider,refunds:undefined}],allowedOrigin:'http://refund.test',principal:async()=>({userId:h.owner,csrfVerified:true})});
    try{const eligibility=await disabled.inject({url:`/api/v1/commerce/topups/${order.order_id}/refund-eligibility`});assert.equal(eligibility.json().enabled,false);assert.match(eligibility.json().reason,/渠道/);}finally{await disabled.close();}
  }finally{await h.close();}
});

test('synthetic task/refund races serialize on original account and rollback cannot send cash before a durable freeze',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const order=await h.topup(1000),lot=await h.readLot(order.order_id);
    const race=await Promise.allSettled([h.request(order.order_id,700),syntheticTask(h.pool,h.owner,lot.id,700)]);
    const first=race[0],second=race[1];assert.equal(first.status,'fulfilled');
    const response=(first as PromiseFulfilledResult<any>).value;
    assert.ok(response.statusCode===202||response.statusCode===409,response.body);
    assert.equal(response.statusCode===202,second.status==='rejected','Only one allocation may claim the original available money');
    assert.equal((await h.readLot(order.order_id)).frozen,'700');assert.equal((await h.readLot(order.order_id)).remaining,'1000');
    if(second.status==='fulfilled')await h.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[second.value]);
    else {const id=response.json().refund_id;h.channel.get(id).status='CLOSED';assert.equal((await h.send('POST',`/api/v1/commerce/refunds/${id}/refresh`,{})).json().state,'failed');}
    const before=h.counts().creates;
    await h.pool.query("CREATE FUNCTION synthetic_refund_outbox_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_type='payment_refund' THEN RAISE EXCEPTION 'synthetic refund outbox fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_refund_outbox_fault BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION synthetic_refund_outbox_fault()");
    try{assert.equal((await h.request(order.order_id,100)).statusCode,500);}finally{await h.pool.query('DROP TRIGGER synthetic_refund_outbox_fault ON bb_outbox');}
    assert.equal(h.counts().creates,before);assert.equal((await h.readLot(order.order_id)).frozen,'0');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:1000,frozen:0});
    const report=await auditCredits(h.pool);assert.equal(report.consistent,true,JSON.stringify(report));
  }finally{await h.close();}
});

test('historical bonus package refunds consumed remainder at original A/Q and quality restoration keeps the same cash ceiling',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const order=await createRecharge(h.pool,h.owner,{request_id:randomUUID(),provider:'wechat',pack_id:'cny500'},[h.provider]);
    await h.paymentCallback(order);const lot=await h.readLot(order.order_id);
    assert.equal(lot.original_points,'52500');assert.equal(lot.cash_basis_fen,'50000');
    const run=await syntheticTask(h.pool,h.owner,lot.id,10500,'settled');
    let eligibility=(await h.eligibility(order.order_id)).json();
    assert.equal(eligibility.enabled,true);assert.equal(eligibility.request_unit,'points');assert.equal(eligibility.original_points,"52500");
    assert.equal(eligibility.refundable_points,"42000");assert.equal(eligibility.refundable_fen,"40000");
    assert.equal((await h.request(order.order_id,40000)).statusCode,409,'Bonus package requests must name credits, not pretend cash equals credits');
    const changedKey=randomUUID(),changedQuote=await h.requestPoints(order.order_id,42000,changedKey,50000);
    assert.equal(changedQuote.statusCode,409,'Server checks the cash preview against original consideration');assert.equal(changedQuote.json().code,'QUOTE_CHANGED');
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_refunds WHERE owner_user_id=$1 AND request_id=$2',[h.owner,changedKey])).rows[0].n,0);
    assert.equal(h.counts().creates,0,'A stale cash preview cannot create or dispatch a refund');
    assert.equal((await h.readLot(order.order_id)).frozen,'0');
    // A direct stale/wrong proportional refund is blocked before any allocation.
    const insertWrong=()=>h.pool.query(`INSERT INTO bb_payment_refunds(id,owner_user_id,order_id,lot_id,request_id,request_hash,provider,merchant_id,provider_txn_id,currency,order_amount_fen,amount_fen,credit_points)
      SELECT $1,o.owner_user_id,o.id,p.lot_id,$2,$3,o.provider,o.merchant_id,o.provider_txn_id,'CNY',o.amount_fen,50000,42000
      FROM bb_recharge_orders o JOIN bb_payment_cash_proofs p ON p.order_id=o.id WHERE o.id=$4`,[randomUUID().replaceAll('-',''),randomUUID(),'a'.repeat(64),order.order_id]);
    await assert.rejects(insertWrong,/original A\/Q/);
    h.setMode('timeout');const key=randomUUID(),created=await h.requestPoints(order.order_id,42000,key,40000);assert.equal(created.statusCode,202,created.body);
    const refund=created.json();assert.equal(refund.amount_fen,"40000");assert.equal(refund.credit_points,"42000");assert.equal(refund.state,'processing');
    assert.equal((await h.readLot(order.order_id)).frozen,'42000');assert.equal((await h.readLot(order.order_id)).remaining,'42000');
    const repeats=await Promise.all([h.requestPoints(order.order_id,42000,key,40000),h.requestPoints(order.order_id,42000,key,40000)]);
    repeats.forEach(r=>assert.equal(r.json().refund_id,refund.refund_id));assert.equal(h.counts().creates,1);
    assert.equal((await h.requestPoints(order.order_id,42000,key,39999)).statusCode,409);
    assert.equal((await h.requestPoints(order.order_id,2)).statusCode,409,'Only one unresolved cash refund on the order');
    h.channel.delete(refund.refund_id);
    const unknown=await h.send('POST',`/api/v1/commerce/refunds/${refund.refund_id}/refresh`,{});assert.equal(unknown.json().state,'processing');
    assert.equal((await h.readLot(order.order_id)).frozen,'42000','Unknown channel state cannot release the credit freeze');
    h.channel.get(refund.refund_id).status='SUCCESS';
    const settled=await Promise.all([h.refundCallback(refund.refund_id),h.send('POST',`/api/v1/commerce/refunds/${refund.refund_id}/refresh`,{})]);
    settled.forEach(r=>assert.equal(r.statusCode,200,r.body));assert.equal((await h.readLot(order.order_id)).remaining,'0');
    assert.equal((await h.eligibility(order.order_id)).json().enabled,false);
    const restored=await correctSettlement(h.pool,{runId:run,actor:'synthetic-quality-review',reason:'Synthetic quality correction preserves paid consideration'});
    const quality=(await h.pool.query('SELECT * FROM bb_credit_lots WHERE id=$1',[restored[0]])).rows[0];
    assert.equal(quality.remaining,'10500');assert.equal(quality.cash_origin_lot_id,lot.id);assert.equal(quality.cash_basis_fen,'50000');assert.equal(quality.cash_basis_points,'52500');
    eligibility=(await h.eligibility(order.order_id)).json();assert.equal(eligibility.refunded_fen,"40000");assert.equal(eligibility.refunded_points,"42000");
    assert.equal(eligibility.refundable_points,"10500");assert.equal(eligibility.refundable_fen,"10000");
    h.setMode('success');const final=await h.requestPoints(order.order_id,10500,randomUUID(),10000);assert.equal(final.statusCode,202,final.body);
    assert.equal(final.json().amount_fen,"10000");assert.equal(final.json().credit_points,"10500");assert.equal(final.json().state,'succeeded');
    assert.equal((await h.pool.query('SELECT remaining,frozen FROM bb_credit_lots WHERE id=$1',[quality.id])).rows[0].remaining,'0');
    assert.equal((await h.readLot(order.order_id)).remaining,'0','Original exhausted lot is never debited for restored-source credits');
    const allocations=(await h.pool.query('SELECT lot_id,points FROM bb_payment_refund_allocations WHERE refund_id=$1',[final.json().refund_id])).rows;
    assert.deepEqual(allocations,[{lot_id:quality.id,points:'10500'}]);
    assert.deepEqual(await correctSettlement(h.pool,{runId:run,actor:'synthetic-quality-review',reason:'Duplicate correction must not create refundable cash'}),restored);
    assert.equal((await h.requestPoints(order.order_id,2)).statusCode,409);
    const totals=(await h.pool.query("SELECT sum(amount_fen)::text cash,sum(credit_points)::text points FROM bb_payment_refunds WHERE order_id=$1 AND state='succeeded'",[order.order_id])).rows[0];
    assert.deepEqual(totals,{cash:'50000',points:'52500'});
    const audit=await auditCredits(h.pool);assert.equal(audit.consistent,true,JSON.stringify(audit));
  }finally{await h.close();}
});

test('historical package cumulative one-cent rounding preserves sub-cent credits and strict request units',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const order=await createRecharge(h.pool,h.owner,{request_id:randomUUID(),provider:'wechat',pack_id:'cny500'},[h.provider]);await h.paymentCallback(order);
    const before=await h.readLot(order.order_id),count=h.counts().creates;
    const subcent=await h.requestPoints(order.order_id,1);assert.equal(subcent.statusCode,409);assert.match(subcent.body,/不足人民币1分/);
    assert.equal((await h.readLot(order.order_id)).remaining,before.remaining);assert.equal((await h.readLot(order.order_id)).frozen,'0');assert.equal(h.counts().creates,count);
    for(const input of [{request_id:randomUUID(),amount_fen:1,points:2},{request_id:randomUUID()},
      {request_id:randomUUID(),points:1150001},{request_id:randomUUID(),points:1.1},{request_id:randomUUID(),points:NaN},
      {request_id:randomUUID(),points:Infinity},{request_id:randomUUID(),points:Number.MAX_SAFE_INTEGER+1},
      {request_id:randomUUID(),amount_fen:1000001},{request_id:randomUUID(),points:2,expected_amount_fen:0},
      {request_id:randomUUID(),amount_fen:1,expected_amount_fen:1}]){
      await assert.rejects(requestPaymentRefund(h.pool,h.owner,order.order_id,input as any,[h.provider]),e=>(e as any).code==='VALIDATION_FAILED');
    }
    assert.equal((await h.send('POST',`/api/v1/commerce/topups/${order.order_id}/refunds`,{request_id:randomUUID(),points:2,amount_fen:1})).statusCode,422);
    h.setMode('success');let points=0,cash=0;
    for(const q of [2,...Array(19).fill(1),52479]){
      const expected=Number(BigInt(50000)*BigInt(points+q)/BigInt(52500))-cash;
      const response=await h.requestPoints(order.order_id,q,randomUUID(),expected);assert.equal(response.statusCode,202,response.body);
      assert.equal(response.json().state,'succeeded');assert.equal(response.json().amount_fen,String(expected));points+=q;cash+=expected;
      const current=(await h.eligibility(order.order_id)).json();assert.equal(current.refunded_points,String(points));assert.equal(current.refunded_fen,String(cash));
    }
    assert.equal(points,52500);assert.equal(cash,50000);assert.equal((await h.readLot(order.order_id)).remaining,'0');
    const report=await auditCredits(h.pool);assert.equal(report.consistent,true,JSON.stringify(report));
  }finally{await h.close();}
});

test('cash refunds allocate only authenticated original-source family and serialize races with consumption',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const order=await createRecharge(h.pool,h.owner,{request_id:randomUUID(),provider:'wechat',pack_id:'cny500'},[h.provider]);await h.paymentCallback(order);
    const lot=await h.readLot(order.order_id);
    const unrelated=await transaction(h.pool,c=>grantCredits(c,{owner:h.owner,source:'existing_grant',key:'synthetic-refund-unrelated-'+order.order_id,points:100000,expiresAt:null,actor:'synthetic',reason:'Non-cash test credit'}));
    const race=await Promise.allSettled([h.requestPoints(order.order_id,40000),syntheticTask(h.pool,h.owner,lot.id,40000)]);
    assert.equal(race[0].status,'fulfilled');const response=(race[0] as PromiseFulfilledResult<any>).value;
    assert.equal(response.statusCode===202,race[1].status==='rejected');assert.ok([202,409].includes(response.statusCode),response.body);
    assert.equal((await h.readLot(order.order_id)).frozen,'40000');
    if(race[1].status==='fulfilled')await h.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[race[1].value]);
    else{h.channel.get(response.json().refund_id).status='CLOSED';await h.send('POST',`/api/v1/commerce/refunds/${response.json().refund_id}/refresh`,{});}
    const valid=await h.requestPoints(order.order_id,2),row=(await h.pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1',[valid.json().refund_id])).rows[0];
    assert.equal(valid.statusCode,202,valid.body);
    await assert.rejects(()=>h.pool.query('UPDATE bb_payment_refund_allocations SET points=points+1 WHERE refund_id=$1',[row.id]),/append only/);
    await assert.rejects(()=>h.pool.query('INSERT INTO bb_payment_refund_allocations(refund_id,owner_user_id,lot_id,points) VALUES($1,$2,$3,1)',[row.id,h.owner,unrelated]),/original-payment source rights/);
    assert.equal((await h.pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[unrelated])).rows[0].remaining,'100000');
    h.channel.get(row.id).status='CLOSED';await h.send('POST',`/api/v1/commerce/refunds/${row.id}/refresh`,{});
    const consumed=await syntheticTask(h.pool,h.owner,lot.id,10500,'settled');
    const restored=await correctSettlement(h.pool,{runId:consumed,actor:'synthetic',reason:'Synthetic simultaneous original and restored rights'});
    h.setMode('success');const combined=await h.requestPoints(order.order_id,52500,randomUUID(),50000);assert.equal(combined.statusCode,202,combined.body);
    const split=(await h.pool.query('SELECT lot_id,points FROM bb_payment_refund_allocations WHERE refund_id=$1 ORDER BY lot_id',[combined.json().refund_id])).rows;
    assert.equal(split.length,2);assert.equal(split.find(a=>a.lot_id===lot.id).points,'42000');assert.equal(split.find(a=>a.lot_id===restored[0]).points,'10500');
    assert.equal((await h.readLot(order.order_id)).remaining,'0');assert.equal((await h.pool.query('SELECT remaining FROM bb_credit_lots WHERE id=$1',[unrelated])).rows[0].remaining,'100000');
    // A cash statement must reconcile the whole 52,500-point source allocation,
    // including the quality-restored lot, while keeping cash at 50,000 fen.
    const refundId=combined.json().refund_id,channelReceipt=h.channel.get(refundId);
    const csv=syntheticTradeStatement({merchant:h.provider.merchantId,appId:h.f.options.appId,orderId:order.order_id,transactionId:'txn_'+order.order_id,
      refund:true,refundId,providerRefundId:channelReceipt.refund_id,refundStatus:'PROCESSING'})
      .replaceAll('100.00','500.00').replaceAll('25.00','500.00').replaceAll('0.60','3.00').replaceAll('-0.15','-3.00').replaceAll('0.45','0.00');
    const statementProvider:PaymentProvider={...h.provider,downloadStatements:async request=>parsePaymentStatement(Buffer.from(csv),{
      ...request,merchantId:h.provider.merchantId,appId:h.f.options.appId,sha1:createHash('sha1').update(csv).digest('hex'),verifiedAt:'2026-10-28T04:00:00Z'})};
    const balanceBefore=await creditBalance(h.pool,h.owner),ledgerBefore=(await h.pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[h.owner])).rows[0].n;
    const statementJob=await enqueuePaymentStatement(h.pool,statementProvider,{billDate:statementFixtureDate,kind:'trade'});assert.ok(statementJob);
    assert.equal((await reconcileDailyStatements(h.pool,[statementProvider],{now:new Date('2026-10-28T01:00:00Z')})).completed,1);
    const checks=(await h.pool.query('SELECT difference_count FROM bb_payment_statement_checks WHERE job_id=$1',[statementJob])).rows;
    const differences=(await h.pool.query(`SELECT d.kind,d.line_no,d.reference_id,d.unit,d.expected_value::text,d.observed_value::text
      FROM bb_payment_statement_differences d JOIN bb_payment_statement_checks c ON c.id=d.check_id WHERE c.job_id=$1
      ORDER BY d.kind,d.line_no,d.reference_id`,[statementJob])).rows;
    assert.deepEqual(checks,[{difference_count:0}],JSON.stringify(differences));
    assert.deepEqual(await creditBalance(h.pool,h.owner),balanceBefore);assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[h.owner])).rows[0].n,ledgerBefore);
    const originalRefund=(await h.pool.query('SELECT amount_fen,credit_points FROM bb_payment_refunds WHERE id=$1',[refundId])).rows[0];
    assert.deepEqual(originalRefund,{amount_fen:'50000',credit_points:'52500'});
    const report=await auditCredits(h.pool);assert.equal(report.consistent,true,JSON.stringify(report));
  }finally{await h.close();}
});
