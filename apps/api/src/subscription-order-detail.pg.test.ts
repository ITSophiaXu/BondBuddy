import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {subscriptionOrderDetailSchemas} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {Problem,publicProblem,transaction,uid} from './data.js';
import {createSubscriptionCheckout,subscriptionAccount} from './subscriptions.js';
import {applyVerifiedPayment,createServiceTopup,type PaymentProvider} from './payments.js';
import {installSubscriptionOrderDetail,subscriptionOrderPeriod} from './subscription-order-detail.js';

const database=await isolatedTestDatabase(undefined,'subscription-order-detail');
test('selected original order identifies its period beyond the latest 50 and keeps unknown or foreign orders private',{skip:!database,timeout:60000},async t=>{
  const pool=new Pool({connectionString:database});
  const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
  app.setErrorHandler((e,r,reply)=>e instanceof Problem?reply.code(e.status).send(publicProblem(e,r.id)):reply.code((e as any).statusCode??500).send({message:e instanceof Error?e.message:String(e)}));
  installSubscriptionOrderDetail(app,{db:()=>pool,owner:async r=>String(r.headers['x-synthetic-user'])});
  const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-order-detail',acknowledgement:{code:'SUCCESS'},
    create:async()=>({checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-period-read'}),
    query:async()=>{throw Error('No real channel');},verifyCallback:async()=>{throw Error('No real channel');}};
  const person=async()=>{const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synth_period_'+id.slice(0,8)]);return id;};
  const owner=await person(),outsider=await person();
  const get=(who:string,id:string)=>app.inject({method:'GET',url:'/api/v1/subscriptions/orders/'+id+'/period',headers:{'x-synthetic-user':who}});
  try{
    const checkout=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:'light',provider:'wechat'},[provider]);
    await applyVerifiedPayment(pool,provider,{orderId:checkout.order.order_id,merchantId:provider.merchantId,amountFen:19900,currency:'CNY',state:'paid',transactionId:'synthetic-'+checkout.order.order_id,payerCash:{amountFen:19900,currency:'CNY'}});
    const original=await subscriptionOrderPeriod(pool,owner,checkout.order.order_id);assert.ok(original.period);
    await t.test('the 51st record remains the original subscription with string-valued money and original dates',async()=>{
      // Fifty newer synthetic failed cycles hide the paid original from the
      // account summary. These insert-only fixtures do not alter purchase terms.
      await transaction(pool,async c=>{
        for(let cycle=2;cycle<=51;cycle++){
          const orderId=uid().replaceAll('-','');
          await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind,state)
            SELECT $1,owner_user_id,$2,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind,'expired'
            FROM bb_recharge_orders WHERE id=$3`,[orderId,uid(),checkout.order.order_id]);
          await c.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,status)
            SELECT $1,owner_user_id,subscription_id,$2,$3,plan_id,catalog_version,amount_fen,points,task_price_version,'failed'
            FROM bb_subscription_periods WHERE order_id=$4`,[uid(),cycle,orderId,checkout.order.order_id]);
        }
      });
      const account=await subscriptionAccount(pool,owner);assert.equal(account.periods.length,50);assert.ok(account.periods.every(p=>p.order_id!==checkout.order.order_id));
      const response=await get(owner,checkout.order.order_id);assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'private, no-store');
      assert.deepEqual(response.json(),original);assert.ok(Value.Check(subscriptionOrderDetailSchemas.SubscriptionOrderPeriodResponse,response.json()));
      for(const key of ['amount_fen','points','available_points','held_points','task_held_points','refund_held_points'])assert.equal(typeof response.json().period[key],'string',key);
      assert.equal(response.json().period.amount_fen,'19900');assert.equal(response.json().period.available_points,'21000');
    });
    await t.test('only a verified owner recharge order returns period null; foreign and nonexistent orders return identical 404',async()=>{
      const topup=await createServiceTopup(pool,owner,{request_id:uid(),provider:'wechat',amount_fen:5000},[provider]);
      const response=await get(owner,topup.order_id);assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{order_id:topup.order_id,period:null});
      for(const id of [checkout.order.order_id,topup.order_id]){const foreign=await get(outsider,id);assert.equal(foreign.statusCode,404);assert.equal(foreign.json().code,'NOT_FOUND');}
      const absent=await get(owner,'nonexistent-order');assert.equal(absent.statusCode,404);assert.equal(absent.json().code,'NOT_FOUND');
    });
    await t.test('missing or inconsistent original subscription records stay unavailable instead of becoming a permanent topup',async()=>{
      const orphan=uid().replaceAll('-','');
      await pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind)
        SELECT $1,owner_user_id,$2,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind
        FROM bb_recharge_orders WHERE id=$3`,[orphan,uid(),checkout.order.order_id]);
      const response=await get(owner,orphan);assert.equal(response.statusCode,503,response.body);assert.equal(response.json().code,'DATA_UNAVAILABLE');assert.equal(response.json().period,undefined);
      const mismatch=uid().replaceAll('-','');
      await pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind,state)
        SELECT $1,owner_user_id,$2,request_hash,provider,pack_id,pack_version,amount_fen+1,points,currency,merchant_id,expires_at,order_kind,'expired'
        FROM bb_recharge_orders WHERE id=$3`,[mismatch,uid(),checkout.order.order_id]);
      await pool.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,status)
        SELECT $1,owner_user_id,subscription_id,52,$2,plan_id,catalog_version,amount_fen,points,task_price_version,'failed'
        FROM bb_subscription_periods WHERE order_id=$3`,[uid(),mismatch,checkout.order.order_id]);
      const inconsistent=await get(owner,mismatch);assert.equal(inconsistent.statusCode,503,inconsistent.body);assert.equal(inconsistent.json().code,'DATA_UNAVAILABLE');
    });
  }finally{await app.close();await pool.end();}
});
