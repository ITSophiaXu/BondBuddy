import type { Pool, PoolClient } from 'pg';
import { M4_BILLING_TASKS, M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_FIXED_PRICE, type M4BillingTask, type M4Quote } from '@bondbuddy/contracts';
import { creditBalance, lockCreditAccount } from './billing.js';
import { date, Problem, transaction, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';

type Db = Pool | PoolClient;
const isDocumentTask = (task:string) => (Object.values(M4_DOCUMENT_BILLING_TASKS) as string[]).includes(task);
const isPaidQaTask = (task:string) => task in M4_BILLING_TASKS && !isDocumentTask(task);
/** Immutable, trusted operational publication; never accepts a price from a chat request. */
export async function publishM4QaPrice(pool:Pool,input:{id:string;points:number;effective_at:string;actor:string;reason:string}) {
  if(!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.id)||!Number.isSafeInteger(input.points)||input.points<1||input.points>1e9
    ||!Number.isFinite(Date.parse(input.effective_at))||!input.actor.trim()||!input.reason.trim())
    throw new Problem(422,'VALIDATION_FAILED','QA price version, positive points, effective time and approval evidence required');
  return transaction(pool,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('bb-m4-qa-price',0))");
    const old=(await c.query('SELECT * FROM bb_m4_qa_price_versions WHERE id=$1',[input.id])).rows[0];
    if(old){
      if(Number(old.points)!==input.points||date(old.effective_at)!==date(input.effective_at)||old.actor!==input.actor||old.reason!==input.reason)
        throw new Problem(409,'IDEMPOTENCY_CONFLICT','QA price version is immutable');
      return;
    }
    await c.query('INSERT INTO bb_m4_qa_price_versions(id,points,effective_at,actor,reason) VALUES($1,$2,$3,$4,$5)',
      [input.id,input.points,input.effective_at,input.actor,input.reason]);
  });
}
async function activeQaPrice(c:PoolClient){
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('bb-m4-qa-price',0))");
  return (await c.query('SELECT * FROM bb_m4_qa_price_versions WHERE effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1')).rows[0];
}
export const M4_MULTIPLIERS: Record<M4BillingTask, number> = { m4_G01: 8, m4_G02: 12, m4_G03: 15, m4_G05: 6, m4_Q01: 2, m4_Q02: 2.5, m4_Q03: 3, m4_Q04: 4, m4_Q05: 5 };
export type M4CostRate = { input_microyuan_per_million: number; cached_microyuan_per_million: number; output_microyuan_per_million: number };
export type M4BillingConfig = { model_id: string; rates: Record<string, M4CostRate>; budgets: Record<M4BillingTask, {input_tokens: number; output_tokens: number; reserve_factor: number}> };
const invalid = () => { throw new Problem(422, 'VALIDATION_FAILED', 'M4 requires published cost rates and task estimation budgets'); };
export function validateM4BillingConfig(value: unknown): asserts value is M4BillingConfig {
  const c = value as M4BillingConfig;
  if (!c || typeof c.model_id !== 'string' || !c.rates || !c.rates[c.model_id] || !c.budgets) invalid();
  for (const r of Object.values(c.rates)) if (!r || !Object.values(r).every(n => Number.isSafeInteger(n) && n > 0)
    || !['input_microyuan_per_million','cached_microyuan_per_million','output_microyuan_per_million'].every(k => k in r)) invalid();
  for (const task of Object.keys(M4_BILLING_TASKS) as M4BillingTask[]) {
    const b = c.budgets[task];
    // Existing published configurations need not price newly introduced document types.
    if (!b && (task==='m4_G02'||task==='m4_G03')) continue;
    if (!b || !Number.isSafeInteger(b.input_tokens) || b.input_tokens < 1 || !Number.isSafeInteger(b.output_tokens) || b.output_tokens < 1
      || !Number.isFinite(b.reserve_factor) || b.reserve_factor < 1 || b.reserve_factor > 10) invalid();
  }
}
/** Trusted operational publishing only; no arbitrary public price setter. */
export async function publishM4BillingConfig(pool: Pool, input: {id:string;config:unknown;effective_at:string;actor:string;reason:string}) {
  validateM4BillingConfig(input.config);
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.id) || !input.actor.trim() || !input.reason.trim() || !Number.isFinite(Date.parse(input.effective_at))) invalid();
  return transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('bb-m4-billing',0))");
    const old = (await c.query('SELECT * FROM bb_m4_billing_configs WHERE id=$1', [input.id])).rows[0];
    if (old) {
      if (inputManifestHash(old.config) !== inputManifestHash(input.config) || old.actor !== input.actor || old.reason !== input.reason || date(old.effective_at) !== date(input.effective_at))
        throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'M4 billing configuration is immutable');
      return;
    }
    await c.query('INSERT INTO bb_m4_billing_configs(id,config,effective_at,actor,reason) VALUES($1,$2,$3,$4,$5)', [input.id,input.config,input.effective_at,input.actor,input.reason]);
  });
}
// Integer micro-yuan rates and tenths of K avoid floating point ledger rounding.
const costNumerator=(input:number,cached:number,output:number,rate:M4CostRate,multiplier:number)=>
  (BigInt(input-cached)*BigInt(rate.input_microyuan_per_million)+BigInt(cached)*BigInt(rate.cached_microyuan_per_million)+BigInt(output)*BigInt(rate.output_microyuan_per_million))*BigInt(Math.round(multiplier*10));
const roundedNumerator=(value:bigint)=>{const points=Number((value+100000000000n-1n)/100000000000n);
  if(!Number.isSafeInteger(points)||points<0||points>1e9)throw new Problem(503,'BILLING_NOT_READY','M4 amount outside supported range');return points;};
const roundedPoints=(input:number,cached:number,output:number,rate:M4CostRate,multiplier:number)=>roundedNumerator(costNumerator(input,cached,output,rate,multiplier));
export const m4QuoteDto = (q:any):M4Quote => ({ quote_id:q.id,topic_id:q.topic_id,input_hash:q.intent_hash.trim(),task_type:q.task_type,
  points:Number(q.reserve_points),price_version:q.fixed_price_version??q.config_id,reason:q.task_type==='m4_Q00'?'产品帮助免费':q.task_type==='m4_task_assistance'?'任务澄清与要求整理免费':q.billing_method==='fixed'?(isDocumentTask(q.task_type)?'每份材料固定 4,500 积分，包含正文 Word 和编制说明；成功交付后扣款，失败或取消全额释放。':`本次独立问题 ${Number(q.reserve_points)} 积分；回答成功后扣费，失败或取消不扣费。`):'本次预留上限 B；交付后按真实成本 × 100 × K 结算，最多扣 B。',
  created_at:date(q.created_at),expires_at:date(q.expires_at),billing_method:Number(q.reserve_points)===0?'free':q.billing_method==='fixed'?'fixed':'metered_capped',
  multiplier:Number(q.multiplier),amount_semantics:q.billing_method==='fixed'?'fixed_price':'reservation_cap' });
export async function quoteM4(c:PoolClient,owner:string,topic:string,task:M4BillingTask|'m4_Q00'|'m4_task_assistance',intentHash:string,snapshot:unknown) {
  let config:any=null,points=0,multiplier=0;
  const qaPrice=isPaidQaTask(task)?await activeQaPrice(c):null;
  const fixed=isDocumentTask(task)||!!qaPrice;
  const fixedVersion=isDocumentTask(task)?M4_DOCUMENT_FIXED_PRICE.version:qaPrice?.id??null;
  if(fixed) { points=qaPrice?Number(qaPrice.points):M4_DOCUMENT_FIXED_PRICE.points; multiplier=1; }
  else if(task!=='m4_Q00'&&task!=='m4_task_assistance') {
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('bb-m4-billing',0))");
    config=(await c.query('SELECT * FROM bb_m4_billing_configs WHERE effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1')).rows[0];
    if(!config)throw new Problem(503,'BILLING_NOT_READY','M4 成本率与预留预算尚未发布；当前输入已保存，可以继续讨论。');
    validateM4BillingConfig(config.config);
    multiplier=M4_MULTIPLIERS[task];const b=config.config.budgets[task],r=config.config.rates[config.config.model_id];
    if(!b)throw new Problem(503,'BILLING_NOT_READY','该材料的预留预算尚未发布；当前输入已保存，可以继续准备材料。');
    points=Math.max(1,Math.ceil(roundedPoints(b.input_tokens,0,b.output_tokens,r,multiplier)*b.reserve_factor));
  }
  const row=(await c.query(`INSERT INTO bb_m4_quotes(id,owner_user_id,topic_id,intent_hash,task_type,config_id,reserve_points,multiplier,snapshot,expires_at,billing_method,fixed_price_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes',$10,$11) RETURNING *`,[uid(),owner,topic,intentHash,task,config?.id??null,points,multiplier,snapshot,fixed?'fixed':'metered_capped',fixedVersion])).rows[0];
  const balance=await creditBalance(c,owner);return {quote:m4QuoteDto(row),balance,shortage:Math.max(0,points-balance.available)};
}
export async function reserveM4(c:PoolClient,owner:string,run:any,quoteId:string|undefined,topicId:string,intentHash:string) {
  if(!quoteId)throw new Problem(409,'QUOTE_REQUIRED','请先查看本次费用，再明确执行。');
  const q=(await c.query('SELECT * FROM bb_m4_quotes WHERE owner_user_id=$1 AND id=$2 AND topic_id=$3',[owner,quoteId,topicId])).rows[0];
  if(!q || q.intent_hash.trim()!==intentHash || new Date(q.expires_at).getTime()<=Date.now())throw new Problem(409,'QUOTE_CHANGED','任务输入或报价已变化，请重新核对后明确执行。');
  if(q.task_type==='m4_Q00'||q.task_type==='m4_task_assistance')return;
  const fixed=q.billing_method==='fixed';
  if(isDocumentTask(q.task_type)) {
    if(!fixed||q.fixed_price_version!==M4_DOCUMENT_FIXED_PRICE.version||Number(q.reserve_points)!==M4_DOCUMENT_FIXED_PRICE.points)
      throw new Problem(409,'QUOTE_CHANGED','材料生成已采用固定价，请重新查看费用后确认。');
  } else {
    const qaPrice=await activeQaPrice(c);
    if(fixed){
      if(!isPaidQaTask(q.task_type)||qaPrice?.id!==q.fixed_price_version||Number(qaPrice.points)!==Number(q.reserve_points))
        throw new Problem(409,'QUOTE_CHANGED','问答价格已更新，请重新查看费用后确认。');
    }else{
      if(qaPrice)throw new Problem(409,'QUOTE_CHANGED','问答已采用固定积分，请重新查看费用后确认。');
      await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('bb-m4-billing',0))");
      const config=(await c.query('SELECT id FROM bb_m4_billing_configs WHERE effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1')).rows[0];
      if(config?.id!==q.config_id)throw new Problem(409,'QUOTE_CHANGED','M4成本配置已更新，请重新查看预留上限。');
    }
  }
  await lockCreditAccount(c,owner);const points=Number(q.reserve_points),balance=await creditBalance(c,owner);
  if(balance.available<points)throw new Problem(402,'CREDITS_INSUFFICIENT',`本次预留 ${points} 积分，当前可用 ${balance.available} 积分，请充值后明确执行。`);
  if((await c.query('SELECT 1 FROM bb_credit_reservations WHERE quote_id=$1',[q.id])).rowCount)throw new Problem(409,'IDEMPOTENCY_CONFLICT','This M4 quotation was already consumed');
  const rid=uid();await c.query('INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points) VALUES($1,$2,$3,$4,$5)',[rid,owner,run.id,q.id,points]);
  const lots=(await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now())
    ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`,[owner])).rows;
  let left=points;for(const l of lots){const take=Math.min(left,Number(l.remaining)-Number(l.frozen));await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[l.id,take]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[rid,l.id,take]);left-=take;if(!left)break;}
  if(left)throw new Problem(503,'DATA_UNAVAILABLE','M4 allocation mismatch');
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,$7)`,[uid(),owner,`reserve:${rid}`,points,rid,run.id,fixed?'m4_confirmed_fixed_price':'m4_confirmed_reservation_cap']);
  run.billing_mode=fixed?'fixed_credits':'metered_credits';run.reservation_id=rid;
  await c.query('UPDATE bb_runs SET billing_mode=$3,reservation_id=$2 WHERE id=$1',[run.id,rid,run.billing_mode]);
}
/** Fixed deliveries settle their pinned price; unknown usage only blocks metered tasks. */
export async function settleM4Metering(db:Db,owner:string,runId:string):Promise<{ready:boolean;charged_points:number|null}> {
  const run=(await db.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[owner,runId])).rows[0];
  if(!run)throw new Problem(404,'NOT_FOUND','Run unavailable');
  if(run.billing_mode==='fixed_credits') {
    const q=(await db.query(`SELECT q.reserve_points FROM bb_credit_reservations r JOIN bb_m4_quotes q ON q.id=r.quote_id AND q.owner_user_id=r.owner_user_id
      WHERE r.owner_user_id=$1 AND r.run_id=$2 AND r.id=$3 AND q.billing_method='fixed'`,[owner,runId,run.reservation_id])).rows[0];
    if(!q)throw new Problem(503,'BILLING_NOT_READY','M4 fixed quotation unavailable');
    return {ready:true,charged_points:Number(q.reserve_points)};
  }
  if(run.billing_mode!=='metered_credits')return {ready:true,charged_points:0};
  const prior=(await db.query('SELECT * FROM bb_m4_metering WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0];
  if(prior)return {ready:true,charged_points:Number(prior.charged_points)};
  const q=(await db.query(`SELECT q.*,c.config FROM bb_credit_reservations r JOIN bb_m4_quotes q ON q.id=r.quote_id AND q.owner_user_id=r.owner_user_id
    JOIN bb_m4_billing_configs c ON c.id=q.config_id WHERE r.owner_user_id=$1 AND r.run_id=$2`,[owner,runId])).rows[0];
  if(!q)throw new Problem(503,'BILLING_NOT_READY','M4 pinned metering configuration unavailable');
  const calls=(await db.query(`SELECT a.id,a.model_id,a.status,u.* FROM bb_model_call_attempts a JOIN bb_call_usage_effective u ON u.attempt_id=a.id
    JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id WHERE a.owner_user_id=$1 AND j.run_id=$2 AND a.status<>'confirmed_not_sent' ORDER BY a.id`,[owner,runId])).rows;
  if(!calls.length || calls.some(a=>a.usage_status!=='measured' || a.input_tokens===null || a.output_tokens===null))return {ready:false,charged_points:null};
  let numerator=0n;for(const a of calls){const r=q.config.rates[a.model_id] as M4CostRate|undefined;
    if(!r || a.cached_input_tokens===null && r.cached_microyuan_per_million!==r.input_microyuan_per_million)return {ready:false,charged_points:null};
    numerator+=costNumerator(a.input_tokens,a.cached_input_tokens??0,a.output_tokens,r,Number(q.multiplier));}
  const cost=roundedNumerator(numerator);
  const charged=Math.min(cost,Number(q.reserve_points));
  await db.query(`INSERT INTO bb_m4_metering(run_id,owner_user_id,status,actual_points,charged_points,evidence) VALUES($1,$2,'verified',$3,$4,$5)
    ON CONFLICT DO NOTHING`,[runId,owner,cost,charged,{config_id:q.config_id,attempt_ids:calls.map(a=>a.id),model_ids:calls.map(a=>a.model_id),formula:'ceil(real_cost_yuan*100*K), min(A,B)',parse_charge:'not_charged_platform_processing'}]);
  return {ready:true,charged_points:charged};
}
