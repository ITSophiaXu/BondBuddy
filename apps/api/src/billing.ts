import type { Pool, PoolClient } from 'pg';
import { BILLING_TASKS, AUTHORING_BILLING_TASKS, type BillingTask, type CreditBalance, type FixedQuote } from '@bondbuddy/contracts';
import { date, digest, missing, Problem, project, transaction, uid } from './data.js';
import { classifyFixedPrice } from './billing-classification.js';
import { assertAuthoringSourceInformation, isUnifiedInput } from './unified-authoring.js';

type Db = Pool | PoolClient;
export async function lockCreditAccount(client: PoolClient, owner: string) {
  await client.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
  await client.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE', [owner]);
}
export async function creditBalance(db: Db, owner: string): Promise<CreditBalance> {
  const r = (await db.query(`SELECT COALESCE(sum(remaining-frozen) FILTER(WHERE expires_at IS NULL OR expires_at>now()),0)::text AS available,
    COALESCE(sum(frozen),0)::text AS frozen FROM bb_credit_lots WHERE owner_user_id=$1`, [owner])).rows[0];
  const balance = { available: Number(r.available), frozen: Number(r.frozen) };
  if (!Number.isSafeInteger(balance.available) || !Number.isSafeInteger(balance.frozen)) throw new Problem(503, 'DATA_UNAVAILABLE', 'Credit balance exceeds supported range');
  return balance;
}
export function validatePrices(prices: unknown): asserts prices is Record<BillingTask, number> {
  if (!prices || typeof prices !== 'object' || Array.isArray(prices) || Object.keys(prices).some(k => !(k in BILLING_TASKS)) ||
    !Object.keys(AUTHORING_BILLING_TASKS).every(k => k in prices) ||
    !Object.keys(prices).every(k => Number.isSafeInteger((prices as any)[k]) && (prices as any)[k] > 0 && (prices as any)[k] <= 1000000000))
    throw new Problem(422, 'VALIDATION_FAILED', 'All authoring prices and configured review prices must be positive integers');
}
export async function publishPrices(pool: Pool, input: { id: string; prices: unknown; effectiveAt: string; actor: string; reason: string }) {
  validatePrices(input.prices);
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.id) || !input.actor.trim() || !input.reason.trim() || !Number.isFinite(Date.parse(input.effectiveAt)))
    throw new Problem(422, 'VALIDATION_FAILED', 'Price version, date, actor and reason required');
  return transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('bb-fixed-prices',0))");
    const old = (await c.query('SELECT * FROM bb_credit_price_versions WHERE id=$1', [input.id])).rows[0];
    if (old) {
      if (digest(JSON.stringify(Object.entries(old.prices).sort())) !== digest(JSON.stringify(Object.entries(input.prices as object).sort())) || date(old.effective_at) !== date(input.effectiveAt) || old.actor !== input.actor || old.reason !== input.reason)
        throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Price version is immutable');
      return;
    }
    await c.query('INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason) VALUES($1,$2,$3,$4,$5)',
      [input.id, input.prices, input.effectiveAt, input.actor, input.reason]);
  });
}
export async function activePrice(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('bb-fixed-prices',0))");
  const p = (await client.query('SELECT * FROM bb_credit_price_versions WHERE effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1')).rows[0];
  if (!p) throw new Problem(503, 'BILLING_NOT_READY', 'Fixed prices are not configured');
  validatePrices(p.prices); return p;
}
export const quoteDto = (q: any): FixedQuote => ({ quote_id: q.id, project_id: q.project_id, input_revision: q.input_revision,
  input_hash: q.input_hash.trim(), task_type: q.task_type, points: Number(q.points), price_version: q.price_version, reason: q.reason, created_at: date(q.created_at) });

export async function quoteCredits(pool: Pool, owner: string, projectId: string, revision: number, hash: string) {
  return transaction(pool, async c => {
    const p = await project(c, owner, projectId, true);
    const i = (await c.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3', [owner, projectId, revision])).rows[0];
    if (!i) throw missing();
    if (i.input_hash.trim() !== hash || p.latest_input_revision !== revision || p.draft_revision !== i.manifest.draft_revision)
      throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Project inputs changed before quotation');
    if (isUnifiedInput(i.manifest)) assertAuthoringSourceInformation(i.manifest.materials as any[], i.manifest.authoring.source_prospectuses);
    const balance = await creditBalance(c, owner);
    const classification = classifyFixedPrice(i.manifest);
    if (!classification.task) throw new Problem(422, 'INPUT_REQUIRED', `${classification.reason} 请补齐信息并保存当前输入后重新获取报价。`);
    const price = await activePrice(c);
    await c.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_user_id,project_id,input_revision,price_version) WHERE intent_hash IS NULL DO NOTHING`,
      [uid(), owner, projectId, revision, hash, price.id, classification.task, price.prices[classification.task], classification.reason]);
    const row = (await c.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3 AND price_version=$4 AND intent_hash IS NULL', [owner, projectId, revision, price.id])).rows[0];
    const quote = quoteDto(row);
    return { enabled: true, quote, balance, shortage: Math.max(0, quote.points - balance.available), reason: null };
  });
}

/** Called in the same transaction as the new run and queue insertion. No browser price is accepted. */
export async function reserveCredits(c: PoolClient, owner: string, run: any, quoteId: string | undefined, input: any, currentProject: any, reviewIntentHash?: string) {
  if (!quoteId) throw new Problem(409, 'QUOTE_REQUIRED', '请确认本次任务报价后开始。');
  const quote = (await c.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND id=$2', [owner, quoteId])).rows[0];
  if (!quote || quote.project_id !== run.project_id || (reviewIntentHash ? quote.intent_hash !== reviewIntentHash : quote.intent_hash !== null || quote.input_revision !== run.input_revision || quote.input_hash.trim() !== run.input_hash.trim()))
    throw new Problem(409, 'QUOTE_CHANGED', '项目输入已变化，请查看新报价后确认。');
  if (!reviewIntentHash && (currentProject.latest_input_revision !== input.revision || currentProject.draft_revision !== input.manifest.draft_revision))
    throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Project changed after quote');
  const price = await activePrice(c);
  if (price.id !== quote.price_version || price.prices[quote.task_type] !== Number(quote.points))
    throw new Problem(409, 'QUOTE_CHANGED', '价格已更新，请查看新报价后确认。');
  await lockCreditAccount(c, owner);
  const balance = await creditBalance(c, owner), points = Number(quote.points);
  if (balance.available < points) throw new Problem(402, 'CREDITS_INSUFFICIENT', `本次任务需要 ${points} 积分，当前可用 ${balance.available} 积分，还差 ${points - balance.available} 积分，请充值后开始。`);
  if ((await c.query('SELECT 1 FROM bb_credit_reservations WHERE quote_id=$1', [quote.id])).rowCount)
    throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Quote already used by another execution');
  const reservation = uid();
  await c.query('INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,$5,$6)', [reservation, owner, run.id, quote.id, points, !reviewIntentHash && quote.task_type in AUTHORING_BILLING_TASKS ? 'authoring_progress_v1' : 'on_delivery']);
  const lots = await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now())
    ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`, [owner]);
  let remaining = points;
  for (const lot of lots.rows) {
    const take = Math.min(remaining, Number(lot.remaining) - Number(lot.frozen));
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1', [lot.id, take]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)', [reservation, lot.id, take]);
    remaining -= take; if (!remaining) break;
  }
  if (remaining) throw new Problem(503, 'DATA_UNAVAILABLE', 'Credit allocation mismatch');
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
    VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,'user_confirmed_fixed_quote')`, [uid(), owner, `reserve:${reservation}`, points, reservation, run.id]);
  await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1", [run.id, reservation]);
  run.billing_mode = 'fixed_credits'; run.reservation_id = reservation;
}

/** Only trusted payment/operations code calls this; no public arbitrary-credit endpoint. */
export async function grantCredits(c: PoolClient, input: { owner: string; source: 'purchase' | 'existing_grant' | 'correction'; key: string; points: number; expiresAt: string | null; actor: string; reason: string; reservationId?:string; runId?:string }) {
  if (!Number.isSafeInteger(input.points) || input.points < 1 || input.points > 1000000000 || !input.key || !input.actor || !input.reason ||
    input.expiresAt !== null && (!Number.isFinite(Date.parse(input.expiresAt)) || input.source === 'purchase')) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid credit grant');
  await lockCreditAccount(c, input.owner);
  const old = (await c.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2', [input.owner, input.key])).rows[0];
  if (old) {
    if (Number(old.original_points) !== input.points || old.source !== input.source || (old.expires_at ? date(old.expires_at) : null) !== (input.expiresAt ? date(input.expiresAt) : null))
      throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Grant key was already used for different credits');
    return old.id as string;
  }
  const id = uid();
  await c.query('INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at) VALUES($1,$2,$3,$4,$5,$5,$6)',
    [id, input.owner, input.source, input.key, input.points, input.expiresAt]);
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason,reservation_id,run_id) VALUES($1,$2,$3,$8,$4,$5,$6,$7,$9,$10)`,
    [uid(), input.owner, `grant:${input.key}`, input.points, id, input.actor, input.reason,input.reservationId?'correction':'grant',input.reservationId??null,input.runId??null]);
  return id;
}
