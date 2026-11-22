import type { PoolClient } from 'pg';
import { creditBalanceExact, lockCreditAccount } from './billing.js';
import {int64,minInt64,shortageInt64,subtractInt64,serializeInt64} from '@bondbuddy/contracts';
import { uid } from './data.js';

export const DYNAMIC_AUTHORING_POLICY = 'authoring_balance_v2';

/** Caller holds run then job locks. Account serialization prevents concurrent runs overdrawing. */
export async function debitAuthoringCredits(c: PoolClient, run: any, target: number) {
  if (!run.reservation_id) return null;
  await lockCreditAccount(c, run.owner_user_id);
  const reservation = (await c.query('SELECT * FROM bb_credit_reservations WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
    [run.reservation_id, run.owner_user_id])).rows[0];
  if (!reservation || reservation.billing_policy !== DYNAMIC_AUTHORING_POLICY) return null;
  const previous = int64(reservation.charged_points ?? 0), ceiling = int64(reservation.points);
  if (reservation.state !== 'held') return { charged: previous, available: (await creditBalanceExact(c, run.owner_user_id)).available, ceiling };
  const balance = await creditBalanceExact(c, run.owner_user_id);
  // The host has accepted an explanation for this exact authoring attempt. The
  // terminal transaction refunds prior progress debits; never charge the balance.
  if((await c.query("SELECT 1 FROM bb_workpaper_item_results WHERE owner_user_id=$1 AND run_id=$2 AND decision->>'status'<>'generate'",[run.owner_user_id,run.id])).rowCount)
    return {charged:previous,available:balance.available,ceiling:previous};
  const amount = minInt64(shortageInt64(minInt64(ceiling,target),previous),balance.available);
  if (amount > 0n) {
    const lots = await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen
      AND (expires_at IS NULL OR expires_at>now())
      ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`, [run.owner_user_id]);
    let remaining = amount;
    for (const lot of lots.rows) {
      const take = minInt64(remaining, subtractInt64(lot.remaining,lot.frozen));
      if (!take) continue;
      await c.query('UPDATE bb_credit_lots SET remaining=remaining-$2 WHERE id=$1', [lot.id, serializeInt64(take)]);
      await c.query(`INSERT INTO bb_credit_allocations(reservation_id,lot_id,points,charged_points) VALUES($1,$2,$3,$3)
        ON CONFLICT(reservation_id,lot_id) DO UPDATE SET points=bb_credit_allocations.points+EXCLUDED.points,
        charged_points=bb_credit_allocations.charged_points+EXCLUDED.charged_points`, [reservation.id, lot.id, serializeInt64(take)]);
      remaining -= take;
      if (!remaining) break;
    }
    if (remaining) throw Error('Dynamic credit allocation mismatch');
    await c.query('UPDATE bb_credit_reservations SET charged_points=$2 WHERE id=$1', [reservation.id, serializeInt64(previous + amount)]);
    await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
      VALUES($1,$2,$3,'settle',$4,$5,$6,'system','authoring_progress_debit')`,
      [uid(), run.owner_user_id, `progress:${reservation.id}:${previous + amount}`, serializeInt64(amount), reservation.id, run.id]);
  }
  return { charged: previous + amount, available: balance.available - amount, ceiling };
}
