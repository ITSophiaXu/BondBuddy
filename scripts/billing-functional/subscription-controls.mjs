// Imported only by the loopback functional harness. No production route or
// production clock definition imports this file.
export async function localSubscriptionState(pool,owner){
  const clock=(await pool.query('SELECT bb_subscription_clock($1) now_at,EXISTS(SELECT 1 FROM bb_local_billing_clock WHERE owner_user_id=$1) simulated',[owner])).rows[0];
  const next=(await pool.query(`SELECT at,event_kind FROM (
      SELECT r.due_at at,'release'::text event_kind FROM bb_subscription_credit_releases r
        JOIN bb_subscription_periods p ON p.id=r.period_id WHERE r.owner_user_id=$1 AND r.state='scheduled' AND p.status='active'
      UNION ALL SELECT current_period_end,'renewal'::text FROM bb_subscriptions
        WHERE owner_user_id=$1 AND current_period_end>bb_subscription_clock($1)
    ) events ORDER BY at,event_kind LIMIT 1`,[owner])).rows[0]??null;
  // Use the product's verified orders, including payments made before this
  // recurring adapter existed. Replacing an adapter never resets paid history.
  const charges=(await pool.query(`SELECT count(*) FILTER(WHERE o.state='paid')::int paid_orders,
      count(*) FILTER(WHERE o.state='paid' AND p.automatic)::int recurring_paid_orders,
      count(*) FILTER(WHERE o.state='pending' AND p.automatic)::int recurring_pending_orders,
      count(*) FILTER(WHERE o.state='failed' AND p.automatic)::int recurring_failed_orders,
      COALESCE(sum(o.amount_fen) FILTER(WHERE o.state='paid'),0)::text simulated_paid_fen
      FROM bb_recharge_orders o LEFT JOIN bb_subscription_periods p ON p.order_id=o.id
      WHERE o.owner_user_id=$1`,[owner])).rows[0];
  return{clock_at:clock.now_at,simulated:clock.simulated,next_event:next,charges};
}

export async function advanceLocalSubscription(pool,owner,requestId,{processDueSubscriptionRenewals,processDueSubscriptionCreditReleases,providers,expectedEvent,replayOnly=false}){
  const c=await pool.connect();let target,replayed=false;
  try{
    await c.query('BEGIN');
    // Serialize this owner's test clock, including retries after a lost reply.
    await c.query('SELECT id FROM bb_users WHERE id=$1 FOR UPDATE',[owner]);
    const prior=(await c.query('SELECT * FROM bb_local_billing_advances WHERE owner_user_id=$1 AND request_id=$2',[owner,requestId])).rows[0];
    if(prior){target=prior;replayed=true;}
    else{
      const current=await localSubscriptionState(c,owner),event=current.next_event;
      // Bind a new action to the event the user actually saw. A separate tab
      // may already have completed it under another request ID. Never turn its
      // stale click into permission to advance a later month or charge again.
      if(replayOnly||expectedEvent&&(!event||event.event_kind!==expectedEvent.event_kind||new Date(event.at).getTime()!==new Date(expectedEvent.at).getTime())){
        await c.query('COMMIT');
        return {request_id:requestId,advanced:false,replayed:false,event_changed:true,replay_only:replayOnly,expected_event:expectedEvent,current_event:event};
      }
      if(!event)throw Error('当前账号没有下一次订阅续费或额度发放；可在账户页查看订阅状态。');
      const at=new Date(Math.max(new Date(event.at).getTime(),new Date(current.clock_at).getTime())+1000);
      await c.query(`INSERT INTO bb_local_billing_clock(owner_user_id,now_at) VALUES($1,$2)
        ON CONFLICT(owner_user_id) DO UPDATE SET now_at=GREATEST(bb_local_billing_clock.now_at,EXCLUDED.now_at),updated_at=now()`,[owner,at]);
      target=(await c.query('INSERT INTO bb_local_billing_advances(owner_user_id,request_id,target_at,event_kind) VALUES($1,$2,$3,$4) RETURNING *',[owner,requestId,at,event.event_kind])).rows[0];
    }
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  // Owner-scoped production operations: only these may create real orders,
  // subscription credit lots or journals. The helper never changes balances.
  await processDueSubscriptionCreditReleases(pool,100,owner);
  await processDueSubscriptionRenewals(pool,providers,50,owner);
  return{request_id:requestId,advanced:!replayed,replayed,event_changed:false,replay_only:replayOnly,target_at:target.target_at,event_kind:target.event_kind};
}

export async function setLocalNextChargeOutcome(pool,owner,outcome){
  if(!['paid','pending','failed'].includes(outcome))throw Error('Unknown synthetic charge outcome');
  await pool.query(`INSERT INTO bb_local_billing_controls(owner_user_id,next_charge_outcome) VALUES($1,$2)
    ON CONFLICT(owner_user_id) DO UPDATE SET next_charge_outcome=EXCLUDED.next_charge_outcome,updated_at=now()`,[owner,outcome]);
}
