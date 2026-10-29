import type {Pool,PoolClient} from 'pg';
import {transaction} from './data.js';

/** One authoritative invariant query set. Call with a stable snapshot, or after
 * acquiring the relevant exclusive safety lock in READ COMMITTED. Held tasks
 * are observations and never make an otherwise consistent wallet fail. */
export async function auditCreditClient(c:PoolClient,owner?:string){
    const lotDrift=(await c.query(`WITH allocations AS (
      SELECT a.*,r.state,r.billing_policy,EXISTS(SELECT 1 FROM bb_credit_lots compensation
        WHERE compensation.source_key='failure:'||r.id||':'||a.lot_id AND compensation.owner_user_id=r.owner_user_id) AS compensated
      FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id), refunds AS (
      SELECT a.lot_id,COALESCE(sum(a.points) FILTER(WHERE r.state IN ('requested','processing')),0) held,
        COALESCE(sum(a.points) FILTER(WHERE r.state='succeeded'),0) refunded FROM bb_payment_refund_allocations a
        JOIN bb_payment_refunds r ON r.id=a.refund_id GROUP BY a.lot_id)
      SELECT l.id,l.owner_user_id,l.remaining::text,l.frozen::text,
        (COALESCE(sum(a.points) FILTER(WHERE a.state='held' AND a.billing_policy<>'authoring_balance_v2'),0)+COALESCE(refunds.held,0))::text AS expected_frozen,
        (l.original_points-COALESCE(sum(CASE WHEN a.compensated THEN a.points ELSE COALESCE(a.charged_points,CASE WHEN a.state='settled' THEN a.points ELSE 0 END) END),0)-COALESCE(refunds.refunded,0))::text AS expected_remaining
      FROM bb_credit_lots l LEFT JOIN allocations a ON a.lot_id=l.id LEFT JOIN refunds ON refunds.lot_id=l.id
      WHERE ($1::text IS NULL OR l.owner_user_id=$1)
      GROUP BY l.id,refunds.held,refunds.refunded HAVING l.frozen<>COALESCE(sum(a.points) FILTER(WHERE a.state='held' AND a.billing_policy<>'authoring_balance_v2'),0)+COALESCE(refunds.held,0)
      OR l.remaining<>l.original_points-COALESCE(sum(CASE WHEN a.compensated THEN a.points ELSE COALESCE(a.charged_points,CASE WHEN a.state='settled' THEN a.points ELSE 0 END) END),0)-COALESCE(refunds.refunded,0)`,[owner??null])).rows;
    const reservationDrift=(await c.query(`SELECT r.id,r.owner_user_id,r.run_id,r.state,r.points::text FROM bb_credit_reservations r
      JOIN bb_runs run ON run.id=r.run_id JOIN bb_credit_quotes q ON q.id=r.quote_id
      WHERE ($1::text IS NULL OR r.owner_user_id=$1) AND (r.points<>q.points OR r.owner_user_id<>run.owner_user_id OR run.reservation_id IS DISTINCT FROM r.id
      OR (r.billing_policy<>'authoring_balance_v2' AND (r.points<>(SELECT COALESCE(sum(points),0) FROM bb_credit_allocations WHERE reservation_id=r.id)
      OR NOT EXISTS(SELECT 1 FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='reserve' AND e.points=r.points)
      OR (r.state<>'held' AND (r.points<>(SELECT COALESCE(sum(e.points),0) FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind IN ('settle','release')) OR COALESCE(r.charged_points,CASE WHEN r.state='settled' THEN r.points ELSE 0 END)<>(SELECT COALESCE(sum(e.points),0) FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='settle')))))
      OR (r.billing_policy='authoring_balance_v2' AND (
        COALESCE(r.charged_points,0)<>(SELECT COALESCE(sum(points),0) FROM bb_credit_allocations WHERE reservation_id=r.id)
        OR COALESCE(r.charged_points,0)<>(SELECT COALESCE(sum(points),0) FROM bb_credit_events WHERE reservation_id=r.id AND kind='settle')
        OR EXISTS(SELECT 1 FROM bb_credit_events WHERE reservation_id=r.id AND kind IN ('reserve','release')))))`,[owner??null])).rows;
    const paymentDrift=(await c.query(`SELECT o.id,o.owner_user_id,o.provider,o.merchant_id,o.state FROM bb_recharge_orders o LEFT JOIN bb_credit_lots l
      ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
      LEFT JOIN bb_subscription_periods sp ON sp.owner_user_id=o.owner_user_id AND sp.order_id=o.id
      WHERE ($1::text IS NULL OR o.owner_user_id=$1) AND ((o.state='paid' AND (l.id IS NULL OR l.original_points IS DISTINCT FROM o.points
        OR (o.order_kind='recharge' AND (l.source IS DISTINCT FROM 'purchase' OR l.expires_at IS NOT NULL))
        OR (o.order_kind='subscription' AND (sp.id IS NULL OR sp.status NOT IN ('active','refunded')
          OR sp.lot_id IS DISTINCT FROM l.id OR sp.points IS DISTINCT FROM o.points OR sp.amount_fen IS DISTINCT FROM o.amount_fen
          OR l.source IS DISTINCT FROM 'subscription' OR sp.credits_expires_at IS NULL
          OR l.expires_at IS DISTINCT FROM sp.credits_expires_at))))
      OR (o.state<>'paid' AND l.id IS NOT NULL))`,[owner??null])).rows;
    const refundDrift=(await c.query(`SELECT r.id,r.owner_user_id,r.provider,r.merchant_id,r.state FROM bb_payment_refunds r WHERE ($1::text IS NULL OR r.owner_user_id=$1) AND (
      r.credit_points<>(SELECT COALESCE(sum(a.points),0) FROM bb_payment_refund_allocations a WHERE a.refund_id=r.id)
      OR
      NOT EXISTS(SELECT 1 FROM bb_payment_refund_events e WHERE e.refund_id=r.id AND e.kind='requested' AND e.amount_fen=r.amount_fen)
      OR (r.dispatch_started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bb_payment_refund_events e WHERE e.refund_id=r.id AND e.kind='dispatch'))
      OR (r.state='succeeded' AND r.amount_fen<>(SELECT COALESCE(sum(e.cash_refunded_fen),0) FROM bb_payment_refund_events e WHERE e.refund_id=r.id))
      OR (r.state='failed' AND NOT EXISTS(SELECT 1 FROM bb_payment_refund_events e WHERE e.refund_id=r.id AND e.kind='failed'))
      OR (r.state<>'succeeded' AND EXISTS(SELECT 1 FROM bb_payment_refund_events e WHERE e.refund_id=r.id AND e.cash_refunded_fen<>0)))`,[owner??null])).rows;
    const heldTasks=(await c.query(`SELECT r.owner_user_id,r.run_id,r.points::text,run.state,run.stage,r.created_at FROM bb_credit_reservations r
      JOIN bb_runs run ON run.id=r.run_id WHERE ($1::text IS NULL OR r.owner_user_id=$1) AND r.state='held' AND r.created_at<now()-interval '24 hours'`,[owner??null])).rows;
    return {consistent:![lotDrift,reservationDrift,paymentDrift,refundDrift].some(v=>v.length),lotDrift,reservationDrift,paymentDrift,refundDrift,heldTasks};
}

export async function auditCredits(pool:Pool,owner?:string){
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return auditCreditClient(c,owner);
  });
}
export type CreditAudit=Awaited<ReturnType<typeof auditCreditClient>>;
