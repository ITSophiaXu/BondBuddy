import {int64,serializeInt64,subscriptionOrderDetailSchemas,type SubscriptionOrderPeriodDetail} from '@bondbuddy/contracts';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {date,missing,Problem,transaction} from './data.js';
import {subscriptionPeriodQuery} from './subscriptions.js';

const unavailable=()=>new Problem(503,'DATA_UNAVAILABLE','原支付订单的类型或周期数据仍在核对，请稍后读取。');

/** Order history is unbounded; the account's latest 50 periods are not a type lookup. */
export async function subscriptionOrderPeriod(pool:Pool,owner:string,orderId:string):Promise<SubscriptionOrderPeriodDetail>{
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const order=(await c.query('SELECT order_kind,state,amount_fen,points FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2',[orderId,owner])).rows[0];
    if(!order)throw missing();
    if(order.order_kind==='recharge')return{order_id:orderId,period:null};
    if(order.order_kind!=='subscription')throw unavailable();
    const p=(await c.query(subscriptionPeriodQuery('p.order_id=$1 AND p.owner_user_id=$2'),[orderId,owner])).rows[0];
    if(!p)throw unavailable();
    try{
      if(int64(p.amount_fen)!==int64(order.amount_fen)||int64(p.points)!==int64(order.points)||
        order.state==='paid'&&(!['active','refunded','superseded'].includes(p.status)||!p.lot_id||p.remaining==null||p.frozen==null||!p.starts_at||!p.ends_at||!p.credits_expires_at))throw unavailable();
      const frozen=int64(p.frozen??0),refundHeld=int64(p.refund_held),changeHeld=int64(p.change_held??0);
      return{order_id:orderId,period:{id:p.id,order_id:p.order_id,plan_id:p.plan_id,status:p.status,
        amount_fen:serializeInt64(p.amount_fen),points:serializeInt64(p.points),face_amount_fen:serializeInt64(p.face_amount_fen),funding_kind:p.funding_kind,
        billing_cycle:p.billing_cycle,monthly_points:serializeInt64(p.monthly_points),release_count:p.billing_cycle==='annual'?12:1,
        released_count:Number(p.released_count),next_release_at:p.next_release_at?date(p.next_release_at):null,
        available_points:serializeInt64(p.available??0),held_points:serializeInt64(frozen),
        task_held_points:serializeInt64(frozen-refundHeld-changeHeld),refund_held_points:serializeInt64(refundHeld),change_held_points:serializeInt64(changeHeld),
        starts_at:p.starts_at?date(p.starts_at):null,ends_at:p.ends_at?date(p.ends_at):null,
        credits_expires_at:p.credits_expires_at?date(p.credits_expires_at):null,
        refundable_until:p.starts_at?new Date(new Date(p.starts_at).getTime()+7*86400000).toISOString():null}};
    }catch{throw unavailable();}
  });
}

export function installSubscriptionOrderDetail(app:FastifyInstance,deps:{db:()=>Pool;owner:(request:FastifyRequest)=>Promise<string>}){
  app.get<{Params:{order_id:string}}>('/api/v1/subscriptions/orders/:order_id/period',{
    schema:{response:{200:subscriptionOrderDetailSchemas.SubscriptionOrderPeriodResponse}},
  },async(request,reply)=>{const owner=await deps.owner(request);reply.header('cache-control','private, no-store');return subscriptionOrderPeriod(deps.db(),owner,request.params.order_id);});
}
