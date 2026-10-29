import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {createWechatPayProvider} from './wechat-pay.js';
import {syntheticWechatFixture} from './test-wechat-pay-fixtures.js';
import {creditBalance,grantCredits,lockCreditAccount,publishPrices} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {createRecharge} from './payments.js';
import {digest,Problem,transaction,type PrivateBlobs} from './data.js';
import type {RefundOrder} from './payment-refunds.js';
import {enqueue,claim,promoteWordArtifact,checkpointStage,finish} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';

const database=await isolatedTestDatabase(undefined,'original-cash-refunds');

async function setup(){
  const pool=new Pool({connectionString:database}),f=syntheticWechatFixture(Date.now()),owner=randomUUID();let actor:string=owner,creates=0,queries=0;
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_refund_'+owner.slice(0,8)]);
  await publishPrices(pool,{id:'synthetic-refund-price',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'Synthetic isolated refund-allocation price fixture'});
  const channel=new Map<string,any>(),orders=new Map<string,any>();let mode:'processing'|'timeout'|'success'|'closed'='processing';
  const provider=createWechatPayProvider({...f.options,refundNotifyUrl:'https://bondbuddy.example/api/v1/payments/wechat/refund-callback'},
    {now:()=>f.now,fetch:async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v3/pay/transactions/native')return f.response({code_url:'weixin://wxpay/bizpayurl?pr=synthetic-refund-payment'});
      if(init?.method==='POST'){
        assert.equal(path,'/v3/refund/domestic/refunds');creates++;
        const body=JSON.parse(String(init.body)),original=orders.get(body.transaction_id);assert.ok(original);
        const stored=(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1',[body.out_refund_no])).rows[0];assert.equal(stored.state,'processing');assert.ok(stored.dispatch_started_at);
        const lot=(await pool.query('SELECT * FROM bb_credit_lots WHERE id=$1',[stored.lot_id])).rows[0];assert.ok(Number(lot.frozen)>=body.amount.refund,'Freeze commits before any external request');
        assert.equal(body.amount.total,original.amount_fen);assert.equal(body.amount.currency,'CNY');
        const receipt={out_refund_no:body.out_refund_no,out_trade_no:original.order_id,transaction_id:body.transaction_id,refund_id:'wx_'+body.out_refund_no.slice(0,27),
          channel:'ORIGINAL',status:mode==='success'?'SUCCESS':mode==='closed'?'CLOSED':'PROCESSING',
          amount:{total:original.amount_fen,refund:body.amount.refund,payer_total:original.amount_fen,payer_refund:body.amount.refund,currency:'CNY'}};
        channel.set(body.out_refund_no,receipt);if(mode==='timeout')throw Error('Synthetic accepted request with lost response');return f.response(receipt);
      }
      assert.match(path,/^\/v3\/refund\/domestic\/refunds\//);queries++;
      const id=decodeURIComponent(path.split('/').at(-1)!),receipt=channel.get(id);if(!receipt)return new Response('synthetic not found',{status:404});return f.response(receipt);
    }});
  const app=createServer({pool,enableOutcomePricing:true,paymentProviders:[provider],allowedOrigin:'http://refund.test',principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin:'http://refund.test',...headers}});
  const paymentCallback=async(order:any,payer:number|null=order.amount_fen)=>{
    const transactionId='txn_'+order.order_id,amount={total:order.amount_fen,currency:'CNY',...(payer===null?{}:{payer_total:payer,payer_currency:'CNY'})};
    orders.set(transactionId,order);
    const envelope=f.envelope({...f.paid,out_trade_no:order.order_id,transaction_id:transactionId,amount});
    const response=await send('POST','/api/v1/payments/wechat/callback',envelope.raw,{'content-type':'application/json',...envelope.headers as Record<string,string>});assert.equal(response.statusCode,200,response.body);return envelope;
  };
  const topup=async(amount:number,payer:number|null=amount)=>{
    const response=await send('POST','/api/v1/commerce/topups',{request_id:randomUUID(),provider:'wechat',amount_fen:amount});assert.equal(response.statusCode,201,response.body);
    const order=response.json(),envelope=await paymentCallback(order,payer);return {...order,envelope};
  };
  const refundCallback=(id:string,changes:Record<string,unknown>={},valid=true)=>{
    const receipt=channel.get(id);assert.ok(receipt);
    const value={...receipt,mchid:f.options.merchantId,refund_status:receipt.status,...changes};
    const envelope=f.envelope(value,{event_type:`REFUND.${value.refund_status}`},{original_type:'refund'});
    return send('POST','/api/v1/payments/wechat/refund-callback',envelope.raw,{'content-type':'application/json',...envelope.headers as Record<string,string>,...(!valid?{'wechatpay-signature':'invalid'}:{})});
  };
  const request=(order:string,amount:number,key=randomUUID())=>send('POST',`/api/v1/commerce/topups/${order}/refunds`,{request_id:key,amount_fen:amount});
  const eligibility=(id:string)=>send('GET',`/api/v1/commerce/topups/${id}/refund-eligibility`);
  const readLot=async(id:string)=>(await pool.query("SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key='recharge:'||$2",[owner,id])).rows[0];
  return {pool,f,owner,provider,app,send,topup,paymentCallback,refundCallback,request,eligibility,readLot,channel,orders,
    setActor:(value:string)=>{actor=value;},setMode:(value:typeof mode)=>{mode=value;},counts:()=>({creates,queries}),close:async()=>{await app.close();await pool.end();}};
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

test('synthetic signed cash refunds bind original payment/lot, exclude consumed/held/bonus money and settle once under callback/query concurrency',{skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const first=await h.topup(10000),second=await h.topup(5000),discount=await h.topup(2000,1),unknown=await h.topup(1000,null);
    const grantLot=await transaction(h.pool,c=>grantCredits(c,{owner:h.owner,source:'existing_grant',key:'synthetic-noncash-grant',points:777,expiresAt:null,actor:'synthetic',reason:'Synthetic noncash money'}));
    const old=await createRecharge(h.pool,h.owner,{request_id:randomUUID(),provider:'wechat',pack_id:'cny500'},[h.provider]);await h.paymentCallback(old);
    const firstLot=await h.readLot(first.order_id),secondLot=await h.readLot(second.order_id);
    await syntheticTask(h.pool,h.owner,firstLot.id,2000,'settled');const held=await syntheticTask(h.pool,h.owner,firstLot.id,3000);
    assert.equal((await h.eligibility(first.order_id)).json().refundable_fen,5000);
    assert.equal((await h.eligibility(discount.order_id)).json().enabled,false);assert.equal((await h.eligibility(discount.order_id)).json().paid_amount_fen,1);
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
    await h.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[held]);assert.equal((await h.eligibility(first.order_id)).json().refundable_fen,4000);
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
    receipt.status='SUCCESS';const recovered=await h.send('POST',`/api/v1/commerce/refunds/${row.id}/refresh`,{});assert.equal(recovered.json().state,'succeeded',recovered.body);assert.deepEqual(await creditBalance(h.pool,h.owner),{available:400,frozen:0});assert.equal(h.counts().creates,1);
    h.setMode('closed');const failedKey=randomUUID(),failed=await h.request(order.order_id,300,failedKey);assert.equal(failed.json().state,'failed',failed.body);assert.equal(failed.json().failure_code,'CLOSED');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:400,frozen:0});
    assert.equal((await h.request(order.order_id,300,failedKey)).json().refund_id,failed.json().refund_id);assert.equal(h.counts().creates,2);
    assert.equal((await h.request(order.order_id,301,failedKey)).statusCode,409);
    h.setMode('success');const explicit=await h.request(order.order_id,300);assert.equal(explicit.json().state,'succeeded',explicit.body);assert.equal(h.counts().creates,3);assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100,frozen:0});
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
