import {isAutomaticPriceVersion,int64,serializeInt64,safeBillingNumber,addInt64,subtractInt64,minInt64,shortageInt64,formatFen} from '@bondbuddy/contracts';
import type { Pool, PoolClient } from 'pg';
import { BILLING_TASKS, AUTHORING_BILLING_TASKS, DYNAMIC_REVIEW_BILLING_TASKS, isOutcomePriceVersion, type BillingTask, type CreditBalance, type FixedQuote } from '@bondbuddy/contracts';
import { date, digest, missing, Problem, project, transaction, uid } from './data.js';
import { classifyFixedPrice } from './billing-classification.js';
import { assertAuthoringSourceInformation, isUnifiedInput } from './unified-authoring.js';
import {OUTCOME_MODE,outcomeMetadata,outcomePriceVersion} from './outcome-pricing.js';
import {requestScope,assertScopeQuote} from './scope-quotations.js';
import {bindCommerceScopeRun} from './commerce-coverage.js';
import {assertWalletWritable,lockWalletSafetyForControl} from './billing-safety.js';

type Db = Pool | PoolClient;
export async function lockCreditAccount(client: PoolClient, owner: string) {
  await assertWalletWritable(client,owner);
  await lockCreditAccountRow(client,owner);
}
/** Only cancellation/receipt control state. This does not authorize any credit mutation. */
export async function lockCreditAccountForControl(client:PoolClient,owner:string){
  await lockWalletSafetyForControl(client,owner);
  await lockCreditAccountRow(client,owner);
}
async function lockCreditAccountRow(client:PoolClient,owner:string){
  await client.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
  await client.query('SELECT owner_user_id FROM bb_credit_accounts WHERE owner_user_id=$1 FOR UPDATE', [owner]);
}
export type ExactCreditBalance={available:bigint;frozen:bigint};
export async function creditBalanceExact(db: Db, owner: string): Promise<ExactCreditBalance> {
  const r = (await db.query(`SELECT COALESCE(sum(remaining-frozen) FILTER(WHERE expires_at IS NULL OR expires_at>now()),0)::text AS available,
    COALESCE(sum(frozen),0)::text AS frozen FROM bb_credit_lots WHERE owner_user_id=$1`, [owner])).rows[0];
  try{
    const balance={available:int64(r.available),frozen:int64(r.frozen)};addInt64(balance.available,balance.frozen);return balance;
  }catch{throw new Problem(503,'DATA_UNAVAILABLE','Credit balance exceeds int64 or violates the ledger invariant');}
}
/** Explicit numeric-v1 compatibility adapter. New wire and ledger operations use creditBalanceExact. */
export function legacyCreditBalance(balance:ExactCreditBalance):CreditBalance{
  try{return {available:safeBillingNumber(balance.available),frozen:safeBillingNumber(balance.frozen)};}
  catch{throw new Problem(503,'DATA_UNAVAILABLE','Legacy numeric client cannot represent this balance; use the int64 billing protocol');}
}
/** @deprecated Numeric-v1 only; do not use for new allocation, aggregation or string-wire responses. */
export async function creditBalance(db:Db,owner:string):Promise<CreditBalance>{
  return legacyCreditBalance(await creditBalanceExact(db,owner));
}

/** Freeze exact source slices in the existing ledger. The caller creates the reservation and owns its event. */
export async function reserveCreditLots(c:PoolClient,owner:string,reservationId:string,quantity:bigint):Promise<void>{
  const points=int64(quantity);if(points===0n)throw new Problem(422,'VALIDATION_FAILED','A credit reservation must be positive');
  await lockCreditAccount(c,owner);
  const lots=(await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now())
    ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`,[owner])).rows;
  let left=points;
  for(const lot of lots){
    const take=minInt64(left,subtractInt64(lot.remaining,lot.frozen));if(take===0n)continue;
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lot.id,serializeInt64(take)]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservationId,lot.id,serializeInt64(take)]);
    left-=take;if(left===0n)break;
  }
  if(left!==0n)throw new Problem(503,'DATA_UNAVAILABLE','Exact credit allocation mismatch');
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
export async function activePrice(client: PoolClient, commercial=false) {
  if(commercial)return outcomePriceVersion(client);
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('bb-fixed-prices',0))");
  const p = (await client.query("SELECT * FROM bb_credit_price_versions WHERE pricing_mode='legacy_credit' AND effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1")).rows[0];
  if (!p) throw new Problem(503, 'BILLING_NOT_READY', 'Fixed prices are not configured');
  validatePrices(p.prices); return p;
}
export const quoteDto = (q: any): FixedQuote => ({ quote_id: q.id, project_id: q.project_id, input_revision: q.input_revision,
  input_hash: q.input_hash.trim(), task_type: q.task_type, points: Number(q.points), price_version: q.price_version, reason: q.reason, created_at: date(q.created_at),...(q.pricing_mode===OUTCOME_MODE?{...outcomeMetadata(Number(q.points),Number(q.points),1,q.price_version),scope_quote_id:q.scope_quote_id,quote_status:q.quote_status??'ready',scope_expires_at:q.scope_expires_at??null,scope_lines:q.scope_lines??[]}:{}) });

export async function quoteCreditsExact(pool: Pool, owner: string, projectId: string, revision: number, hash: string, commercial=false) {
  return transaction(pool, async c => {
    const p = await project(c, owner, projectId, true);
    const i = (await c.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3', [owner, projectId, revision])).rows[0];
    if (!i) throw missing();
    if (i.input_hash.trim() !== hash || p.latest_input_revision !== revision || p.draft_revision !== i.manifest.draft_revision)
      throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Project inputs changed before quotation');
    if (isUnifiedInput(i.manifest)) assertAuthoringSourceInformation(i.manifest.materials as any[], i.manifest.authoring.source_prospectuses);
    const balance = await creditBalanceExact(c, owner);
    const classification = classifyFixedPrice(i.manifest);
    if (!commercial&&!classification.task) throw new Problem(422, 'INPUT_REQUIRED', `${classification.reason} 请补齐信息并保存当前输入后重新获取报价。`);
    const price = await activePrice(c,commercial),scope=commercial?await requestScope(c,owner,projectId,'authoring',hash,i.manifest):null;
    const task=classification.task??'new_authoring';
    if(scope&&scope.quote_status!=='ready')return {enabled:true,quote:{quote_id:scope.scope_quote_id,project_id:projectId,input_revision:revision,input_hash:hash,task_type:task,points:0,
       reason:'本次范围待核实；确认实际编制范围并给出明细后，才能确认费用并执行。',created_at:new Date().toISOString(),...outcomeMetadata(0),...scope},balance,shortage:0n,reason:'本次范围待核实，尚未形成可执行报价。'};
    const points=scope?.amount_fen??price.prices[task],priceVersion=scope?.price_version??price.id,reason=isAutomaticPriceVersion(priceVersion)?'按已保存材料和业务目标锁定积分，开始自动预留，成功交付后结算。':commercial?'按本次输入和已核定的范围明细锁定人民币总价，成功交付后结算。':classification.reason;
    await c.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason,pricing_mode,outcome_key,scope_quote_id,scope_lines)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [uid(), owner, projectId, revision, hash, priceVersion, task, points, reason,commercial?OUTCOME_MODE:'legacy_credit',commercial?'scoped_authoring':null,scope?.scope_quote_id??null,JSON.stringify(scope?.scope_lines??[])]);
    const row = (await c.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3 AND price_version=$4 AND intent_hash IS NULL AND scope_quote_id IS NOT DISTINCT FROM $5::text', [owner, projectId, revision, priceVersion,scope?.scope_quote_id??null])).rows[0];
    const quote = quoteDto({...row,...scope});
    return { enabled: true, quote, balance, shortage: shortageInt64(quote.points,balance.available), reason: null };
  });
}
/** @deprecated Numeric-v1 compatibility; new wire callers use quoteCreditsExact. */
export async function quoteCredits(pool:Pool,owner:string,projectId:string,revision:number,hash:string,commercial=false){
  const result=await quoteCreditsExact(pool,owner,projectId,revision,hash,commercial);
  return {...result,balance:legacyCreditBalance(result.balance),shortage:safeBillingNumber(result.shortage)};
}

/** Called in the same transaction as the new run and queue insertion. No browser price is accepted. */
export async function reserveCredits(c: PoolClient, owner: string, run: any, quoteId: string | undefined, input: any, currentProject: any, reviewIntentHash?: string, commercial=false) {
  if (!quoteId) throw new Problem(409, 'QUOTE_REQUIRED', '请确认本次任务报价后开始。');
  const quote = (await c.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND id=$2', [owner, quoteId])).rows[0];
  if (!quote || quote.project_id !== run.project_id || (reviewIntentHash ? quote.intent_hash !== reviewIntentHash : quote.intent_hash !== null || quote.input_revision !== run.input_revision || quote.input_hash.trim() !== run.input_hash.trim()))
    throw new Problem(409, 'QUOTE_CHANGED', '项目输入已变化，请查看新报价后确认。');
  if (!reviewIntentHash && (currentProject.latest_input_revision !== input.revision || currentProject.draft_revision !== input.manifest.draft_revision))
    throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Project changed after quote');
  // The quotation pins the policy. A later feature-flag change cannot reinterpret it.
  const outcome=quote.pricing_mode===OUTCOME_MODE;
  if(outcome){
    const scope=await assertScopeQuote(c,quote.scope_quote_id,owner,run.project_id,reviewIntentHash?'review':'authoring',(reviewIntentHash??quote.input_hash).trim(),safeBillingNumber(quote.points));
    if(!isOutcomePriceVersion(quote.price_version)||scope.price_version!==quote.price_version)throw new Problem(409,'QUOTE_CHANGED','人民币报价规则版本已变化，请重新核对。');
    if(int64(quote.points)===0n){await bindCommerceScopeRun(c,owner,scope.scope_quote_id,run.id);return;}
  }
  const price = outcome?null:await activePrice(c,false);
  if (!outcome&&(price!.id !== quote.price_version || int64(price!.prices[quote.task_type]) !== int64(quote.points)))
    throw new Problem(409, 'QUOTE_CHANGED', '价格已更新，请查看新报价后确认。');
  await lockCreditAccount(c, owner);
  const balance = await creditBalanceExact(c, owner), points = int64(quote.points);
  const dynamic = !outcome&&((!reviewIntentHash && quote.task_type in AUTHORING_BILLING_TASKS) || (!!reviewIntentHash && quote.task_type in DYNAMIC_REVIEW_BILLING_TASKS));
  if (balance.available < (dynamic ? 1n : points)) throw new Problem(402, 'CREDITS_INSUFFICIENT', isAutomaticPriceVersion(quote.price_version)?`本次任务需要 ${points.toLocaleString('zh-CN')} 积分，当前可用 ${balance.available.toLocaleString('zh-CN')} 积分，还差 ${(points-balance.available).toLocaleString('zh-CN')} 积分；通过原任务入口补足后自动继续。`:outcome?`本次任务需要 ${formatFen(points)}，当前可用 ${formatFen(balance.available)}，请充值后开始。`:dynamic ? '可用积分为 0，请充值后开始；项目材料与补充要求已保留。' : `本次任务需要 ${points} 积分，当前可用 ${balance.available} 积分，还差 ${points - balance.available} 积分，请充值后开始。`);
  if ((await c.query('SELECT 1 FROM bb_credit_reservations WHERE quote_id=$1', [quote.id])).rowCount)
    throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Quote already used by another execution');
  const reservation = uid();
  await c.query('INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,$5,$6)', [reservation, owner, run.id, quote.id,serializeInt64(points), dynamic ? 'authoring_balance_v2' : 'on_delivery']);
  if (dynamic) {
    await c.query('UPDATE bb_credit_reservations SET charged_points=0 WHERE id=$1', [reservation]);
    await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1", [run.id, reservation]);
    run.billing_mode = 'fixed_credits'; run.reservation_id = reservation;
    return;
  }
  await reserveCreditLots(c,owner,reservation,points);
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
    VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,'user_confirmed_fixed_quote')`, [uid(), owner, `reserve:${reservation}`,serializeInt64(points), reservation, run.id]);
  await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1", [run.id, reservation]);
  run.billing_mode = 'fixed_credits'; run.reservation_id = reservation;
  if(outcome)await bindCommerceScopeRun(c,owner,quote.scope_quote_id,run.id);
}

/** Only trusted payment/operations code calls this; no public arbitrary-credit endpoint. */
/** Caller holds the account lock. No partial issuance may precede this check. */
export async function assertCreditIssuanceFits(c:PoolClient,owner:string,quantity:bigint){
  const total=(await c.query('SELECT COALESCE(sum(remaining),0)::text amount FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0];
  try{addInt64(total.amount,quantity);}catch{throw new Problem(503,'DATA_UNAVAILABLE','Credit issuance would exceed the int64 account invariant; original request and rights remain unchanged');}
}
export async function grantCredits(c: PoolClient, input: { owner: string; source: 'purchase' | 'subscription' | 'existing_grant' | 'correction'; key: string; points: number|string|bigint; expiresAt: string | null; actor: string; reason: string; reservationId?:string; runId?:string }) {
  let quantity:bigint;try{quantity=int64(input.points);}catch{throw new Problem(422,'VALIDATION_FAILED','Invalid credit grant');}
  if (quantity < 1n || !input.key || !input.actor || !input.reason ||
    input.expiresAt !== null && (!Number.isFinite(Date.parse(input.expiresAt)) || input.source === 'purchase')) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid credit grant');
  await lockCreditAccount(c, input.owner);
  const old = (await c.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2', [input.owner, input.key])).rows[0];
  if (old) {
    if (int64(old.original_points) !== quantity || old.source !== input.source || (old.expires_at ? date(old.expires_at) : null) !== (input.expiresAt ? date(input.expiresAt) : null))
      throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Grant key was already used for different credits');
    return old.id as string;
  }
  // Reject representation overflow before accepting another issuance. This is an
  // int64 invariant, not an invented business cap at JavaScript MAX_SAFE_INTEGER.
  await assertCreditIssuanceFits(c,input.owner,quantity);
  const id = uid();
  await c.query('INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at) VALUES($1,$2,$3,$4,$5,$5,$6)',
    [id, input.owner, input.source, input.key, quantity.toString(), input.expiresAt]);
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason,reservation_id,run_id) VALUES($1,$2,$3,$8,$4,$5,$6,$7,$9,$10)`,
    [uid(), input.owner, `grant:${input.key}`, quantity.toString(), id, input.actor, input.reason,input.reservationId?'correction':'grant',input.reservationId??null,input.runId??null]);
  return id;
}
