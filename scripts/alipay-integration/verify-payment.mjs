import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {join} from 'node:path';
import {client} from './http.mjs';
import {config,databaseURL,username,password,runtime,atomicJson} from './config.mjs';
import {assertDatabase} from './database.mjs';
const pool=new Pool({connectionString:databaseURL}),send=client();
try{
  await assertDatabase(pool,config());
  await send('POST','/api/v1/auth/login',{username,password});
  const order=(await pool.query(`SELECT o.id,o.owner_user_id,o.amount_fen,o.points,o.order_kind FROM bb_recharge_orders o
    JOIN bb_users u ON u.id=o.owner_user_id WHERE u.username=$1 ORDER BY o.created_at DESC LIMIT 1`,[username])).rows[0];
  if(!order)throw Error('No acceptance order has been created by the test user');
  let first;
  try{first=await send('POST','/api/v1/commerce/topups/'+order.id+'/refresh',{});}
  catch(error){
    if(error.status!==503||error.code!=='PAYMENT_UNAVAILABLE')throw error;
    console.log(JSON.stringify({state:'unresolved',creditingVerified:false,message:'The channel query has not established a payment outcome. Keep the original order; no new payment or credit was created.'}));process.exitCode=2;
  }
  if(!first){/* Query failure is not an unpaid or expired receipt. */}
  else if(first.state!=='paid'){console.log(JSON.stringify({state:first.state,buyerPaymentPending:true}));process.exitCode=2;}
  else{
    const before=await send('GET','/api/v1/subscriptions/account');
    const second=await send('POST','/api/v1/commerce/topups/'+order.id+'/refresh',{});
    const after=await send('GET','/api/v1/subscriptions/account');
    assert.equal(second.state,'paid');assert.equal(after.available_points,before.available_points);
    const lots=(await pool.query('SELECT source,original_points,remaining,frozen FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2',[order.owner_user_id,'recharge:'+order.id])).rows;
    assert.equal(lots.length,1);assert.equal(lots[0].original_points,String(first.points));assert.equal(lots[0].frozen,'0');
    if(order.order_kind==='subscription'){
      assert.equal(lots[0].source,'subscription');assert.equal(after.subscription.status,'active');
      assert.equal(after.periods.filter(p=>p.order_id===order.id&&p.status==='active').length,1);
    }
    const proof=(await pool.query('SELECT cash_amount_fen FROM bb_payment_cash_proofs WHERE order_id=$1',[order.id])).rows[0];
    const result={verifiedAt:new Date().toISOString(),channel:'alipay-sandbox',state:'paid',realProductApi:true,realPostgres:true,
      orderKind:order.order_kind,amountFen:String(first.amount_fen),points:String(first.points),accountAvailablePoints:after.available_points,
      matchingCreditLots:1,repeatedQueryDoesNotCreditAgain:true,payerCashFen:proof?.cash_amount_fen??null,publicNotificationsVerified:false};
    atomicJson(join(runtime,'payment-verification.json'),result);console.log(JSON.stringify(result));
  }
}finally{await pool.end();}
