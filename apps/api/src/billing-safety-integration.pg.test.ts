import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID as uid} from 'node:crypto';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {transaction} from './data.js';
import {creditBalanceExact,grantCredits} from './billing.js';
import {inspectAndIsolateBillingScope} from './billing-safety.js';
import {createServiceTopup,installPayments,openCheckout,refreshRecharge,closeRecharge,type PaymentProvider} from './payments.js';
import {cancelSubscription,createSubscriptionCheckout,subscriptionAccount} from './subscriptions.js';
import {reconcilePendingPayments} from './payment-reconciliation.js';

const database=await isolatedTestDatabase(undefined,'billing-safety-integration');
async function user(pool:Pool){const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'safety_integration_'+id.slice(0,8)]);return id;}
function provider(merchantId:string):PaymentProvider{return{name:'wechat',merchantId,acknowledgement:{code:'SUCCESS'},
  create:async()=>({checkoutUrl:'https://synthetic.invalid/checkout'}),
  query:async order=>({orderId:order.id,merchantId,amountFen:order.amount_fen,currency:'CNY',transactionId:null,state:'pending'}),
  verifyCallback:async()=>{throw Error('Synthetic fixture does not accept callbacks');}};}
async function damageWallet(pool:Pool,owner:string){
  const id=await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000,expiresAt:null,actor:'synthetic',reason:'Synthetic quarantine fixture'}));
  await pool.query('UPDATE bb_credit_lots SET remaining=999 WHERE id=$1',[id]);
  return id;
}

test('wallet quarantine fences new credit and subscriptions while preserving account reads and cancellation',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const owner=await user(pool),p=provider(uid());
    const checkout=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:'light',provider:'wechat'},[p]);
    await damageWallet(pool,owner);
    assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner})).status,'isolated');
    await assert.rejects(transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1,expiresAt:null,actor:'synthetic',reason:'Blocked grant'})),{code:'BILLING_NOT_READY'});
    await assert.rejects(createServiceTopup(pool,owner,{request_id:uid(),provider:'wechat',amount_fen:100},[p]),{code:'BILLING_NOT_READY'});
    await assert.rejects(createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:'light',provider:'wechat'},[p]),{code:'BILLING_NOT_READY'});
    assert.equal((await creditBalanceExact(pool,owner)).available,999n);
    assert.ok(await subscriptionAccount(pool,owner));
    assert.equal((await cancelSubscription(pool,owner,checkout.subscription.id,uid(),[p])).status,'cancelled');
    assert.equal((await pool.query('SELECT count(*) FROM bb_recharge_orders WHERE owner_user_id=$1',[owner])).rows[0].count,'1');
  }finally{await pool.end();}
});

test('merchant quarantine prevents checkout dispatch but original order queries remain available',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database}),app=Fastify();
  try{
    const owner=await user(pool),p=provider(uid());let creates=0,queries=0;
    p.create=async()=>{creates++;throw Error('Synthetic response lost before URL persisted');};
    p.query=async order=>{queries++;return{orderId:order.id,merchantId:p.merchantId,amountFen:order.amount_fen,currency:'CNY',transactionId:null,state:'pending'};};
    const input={request_id:uid(),provider:'wechat' as const,amount_fen:100};
    await assert.rejects(createServiceTopup(pool,owner,input,[p]),{code:'PAYMENT_UNAVAILABLE'});
    const original=(await pool.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1',[owner])).rows[0];
    assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'channel',provider:p.name,merchantId:p.merchantId},async()=>({status:'verified',evidenceIds:['synthetic-channel-proof'],differences:[{kind:'synthetic_mismatch'}]}))).status,'isolated');
    await assert.rejects(openCheckout(pool,owner,original,[p]),{code:'BILLING_NOT_READY'});
    await assert.rejects(createServiceTopup(pool,owner,{...input,request_id:uid()},[p]),{code:'BILLING_NOT_READY'});
    assert.equal((await refreshRecharge(pool,owner,original.id,[p])).state,'pending');
    assert.equal(creates,1);assert.equal(queries,1,'authenticated read of original channel order remains possible');
    installPayments(app,pool,async()=>owner,true,[p]);
    const response=await app.inject({method:'GET',url:'/api/v1/credits/recharge-orders/'+original.id});
    assert.equal(response.statusCode,200);assert.equal(response.json().order_id,original.id);assert.equal(response.json().state,'pending');
    assert.equal((await pool.query('SELECT count(*) FROM bb_recharge_orders WHERE owner_user_id=$1',[owner])).rows[0].count,'1');
    p.closePayment=async order=>({orderId:order.id,merchantId:p.merchantId,amountFen:order.amount_fen,currency:'CNY',transactionId:null,state:'expired'});
    assert.equal((await closeRecharge(pool,owner,original.id,[p])).state,'expired','verified closure is control state, not new money');
  }finally{await app.close();await pool.end();}
});

test('reconciliation isolates committed wallet drift even without a configured payment provider',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  try{
    const owner=await user(pool);await damageWallet(pool,owner);
    const result=await reconcilePendingPayments(pool,[]);assert.equal(result.alert_failures,0);
    assert.equal((await pool.query('SELECT count(*) FROM bb_billing_safety_blocks WHERE scope_key=$1 AND resume_event_id IS NULL',['wallet:'+owner])).rows[0].count,'1');
    assert.equal((await pool.query("SELECT count(*) FROM bb_ops_alerts WHERE kind='billing_safety_isolated' AND detail->>'scope_kind'='wallet'")).rows[0].count!=='0',true);
  }finally{await pool.end();}
});
