import {int64,serializeInt64,subscriptionOrderDetailSchemas,type SubscriptionOrderPeriodDetail} from '@bondbuddy/contracts';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {date,missing,Problem,transaction} from './data.js';

const unavailable=()=>new Problem(503,'DATA_UNAVAILABLE','原支付订单的类型或周期数据仍在核对，请稍后读取。');

/** Order history is unbounded; the account's latest 50 periods are not a type lookup. */
export async function subscriptionOrderPeriod(pool:Pool,owner:string,orderId:string):Promise<SubscriptionOrderPeriodDetail>{
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const order=(await c.query('SELECT order_kind,state,amount_fen,points FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2',[orderId,owner])).rows[0];
    if(!order)throw missing();
    if(order.order_kind==='recharge')return{order_id:orderId,period:null};
    if(order.order_kind!=='subscription')throw unavailable();
    const p=(await c.query(`SELECT p.*,l.remaining,l.frozen,(l.expires_at>now()) unexpired,
      (SELECT COALESCE(sum(a.points),0)::text FROM bb_payment_refund_allocations a
        JOIN bb_payment_refunds r ON r.id=a.refund_id AND r.owner_user_id=a.owner_user_id
        WHERE a.lot_id=l.id AND a.owner_user_id=p.owner_user_id AND r.state IN ('requested','processing')) refund_held
      FROM bb_subscription_periods p LEFT JOIN bb_credit_lots l ON l.id=p.lot_id AND l.owner_user_id=p.owner_user_id
      WHERE p.order_id=$1 AND p.owner_user_id=$2`,[orderId,owner])).rows[0];
    if(!p)throw unavailable();
    try{
      if(int64(p.amount_fen)!==int64(order.amount_fen)||int64(p.points)!==int64(order.points)||
        order.state==='paid'&&(!['active','refunded'].includes(p.status)||!p.lot_id||p.remaining==null||p.frozen==null||!p.starts_at||!p.ends_at||!p.credits_expires_at))throw unavailable();
      const frozen=int64(p.frozen??0),refundHeld=int64(p.refund_held);
      return{order_id:orderId,period:{id:p.id,order_id:p.order_id,plan_id:p.plan_id,status:p.status,
        amount_fen:serializeInt64(p.amount_fen),points:serializeInt64(p.points),
        available_points:serializeInt64(p.unexpired?int64(p.remaining??0)-frozen:0),held_points:serializeInt64(frozen),
        task_held_points:serializeInt64(frozen-refundHeld),refund_held_points:serializeInt64(refundHeld),
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
