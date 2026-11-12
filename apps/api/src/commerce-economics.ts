import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import type {Pool,PoolClient} from 'pg';
import {missing,Problem,transaction,uid} from './data.js';
import {ZERO,add,subtract,divide,ratio,ratioJson,unsignedInteger,nonnegativeDecimal,exactDecimal,roundedDecimal,type ExactRatio,type IntegerInput} from './commerce-economics-math.js';
import {lotFundingEvidenceSql,lotFundingMatches,type LotFundingEvidence} from './subscription-funding-evidence.js';

export const ECONOMICS_REPORT_VERSION='commerce-economics-exact-v2' as const;
export const EXPENSE_CATEGORIES=['parsing_ocr','extra_compute_storage','payment_fee','original_scope_rework','support_extra','presale_quote'] as const;
export type ExpenseCategory=typeof EXPENSE_CATEGORIES[number];
type Attempt={attempt_id:string;billable:boolean;pricing_status:string;usage_status:string;currency:string|null;cost_amount:string|number|null;cached_input_tokens:number|null;reasoning_tokens:number|null;input_per_million?:string;cached_input_per_million?:string;output_per_million?:string;reasoning_output_per_million?:string;[key:string]:unknown};
type Expense={id:string;category:ExpenseCategory;amount_fen:IntegerInput;within_fixed_budget:boolean;[key:string]:unknown};
type Review={snapshot_hash:string;model_required:boolean;[key:string]:unknown};
export type ConsiderationSlice={points:IntegerInput;numerator_fen:IntegerInput|null;denominator_points:IntegerInput|null;funding_required?:boolean;funding_slices?:LotFundingEvidence[];[key:string]:unknown};
export type RunCostInput={run_id:string;state:string;revenue_fen:IntegerInput;compensation_fen:IntegerInput;
  consideration_slices?:ConsiderationSlice[];compensation_slices?:ConsiderationSlice[];attempts:Attempt[];expenses:Expense[];reviews?:Review[]};
const canonical=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const invalid=(message:string)=>new Problem(422,'VALIDATION_FAILED',message);
const requiredText=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;

function sliceConsideration(slices:ConsiderationSlice[]|undefined,expected:bigint):ExactRatio|null{
  if(!slices)return null;
  let points=0n,total=ZERO;
  try{
    for(const slice of slices){
      const p=unsignedInteger(slice.points),A=unsignedInteger(slice.numerator_fen),Q=unsignedInteger(slice.denominator_points);
      if(p===0n||Q===0n||!lotFundingMatches({required:slice.funding_required,funding:slice.funding_slices,numerator:slice.numerator_fen,denominator:slice.denominator_points}))return null;
      points+=p;total=add(total,ratio(A*p,Q));
    }
    return points===expected?total:null;
  }catch{return null;}
}
const sortedSlices=(slices:ConsiderationSlice[]|undefined)=>slices?[...slices].sort((a,b)=>canonical(a).localeCompare(canonical(b))):undefined;

/** Native supplier currency stays native. Missing FX, rate or usage never becomes a zero cost. */
export function summarizeRunCosts(input:RunCostInput){
  const attempts=[...input.attempts].sort((a,b)=>a.attempt_id.localeCompare(b.attempt_id));
  const expenses=[...input.expenses].sort((a,b)=>a.id.localeCompare(b.id));
  const charge=unsignedInteger(input.revenue_fen),compensation=unsignedInteger(input.compensation_fen);
  const consideration_slices=sortedSlices(input.consideration_slices),compensation_slices=sortedSlices(input.compensation_slices);
  // Versioning changes the reviewed fact set without rewriting any previous review or evidence hash.
  const snapshot_hash=hash({report_version:ECONOMICS_REPORT_VERSION,run_id:input.run_id,state:input.state,
    delivered_service_charge_points:charge.toString(),service_compensation_points:compensation.toString(),
    consideration_slices:consideration_slices??null,compensation_slices:compensation_slices??null,attempts,expenses});
  const problems:string[]=[],native:Record<string,ExactRatio>=Object.create(null);
  let billable=0,unpriced=0;
  for(const a of attempts){
    if(!a.billable)continue;
    billable++;
    const cacheUnknown=a.cached_input_tokens===null&&a.input_per_million!==a.cached_input_per_million;
    const reasoningUnknown=a.reasoning_tokens===null&&a.output_per_million!==a.reasoning_output_per_million;
    let amount:ExactRatio|null=null;try{amount=nonnegativeDecimal(a.cost_amount);}catch{/* Unknown is not zero. */}
    const currency=a.currency?.trim();
    if(a.usage_status!=='measured'||a.pricing_status!=='priced'||!currency||amount===null||cacheUnknown||reasoningUnknown){unpriced++;continue;}
    native[currency]=add(native[currency]??ZERO,amount);
  }
  if(unpriced)problems.push('model_usage_or_rate_incomplete');
  if(Object.keys(native).some(c=>c!=='CNY'))problems.push('supplier_currency_requires_verified_conversion');
  const missing_categories=EXPENSE_CATEGORIES.filter(c=>!expenses.some(e=>e.category===c));
  if(missing_categories.length)problems.push('non_model_cost_evidence_incomplete');
  const review=input.reviews?.find(r=>r.snapshot_hash===snapshot_hash);
  if(!review)problems.push('cost_review_missing_or_stale');
  if(review?.model_required&&billable===0)problems.push('expected_model_attempts_missing');
  if(review&&!review.model_required&&billable>0)problems.push('model_not_applicable_conflicts_with_attempts');
  if(!['succeeded','failed','cancelled','rejected'].includes(input.state))problems.push('run_not_terminal');
  let extra=0n,budget=0n,expenses_valid=true;
  for(const expense of expenses){
    try{
      if(!EXPENSE_CATEGORIES.includes(expense.category)||typeof expense.within_fixed_budget!=='boolean')throw Error('Invalid expense');
      const amount=unsignedInteger(expense.amount_fen);if(expense.within_fixed_budget)budget+=amount;else extra+=amount;
    }catch{expenses_valid=false;}
  }
  if(!expenses_valid)problems.push('non_model_cost_evidence_invalid');
  const complete=problems.length===0;
  const variable=complete?add(native.CNY??ZERO,ratio(extra,100n)):null;
  const cash=sliceConsideration(consideration_slices,charge),reversal=sliceConsideration(compensation_slices,compensation);
  const consideration_problems:string[]=[];
  if(cash===null)consideration_problems.push('delivery_cash_basis_or_allocation_incomplete');
  if(reversal===null)consideration_problems.push('compensation_cash_basis_or_allocation_incomplete');
  if(compensation>charge)consideration_problems.push('compensation_exceeds_delivered_points');
  const net=cash!==null&&reversal!==null?subtract(cash,reversal):null;
  if(net!==null&&net.numerator<0n)consideration_problems.push('compensation_exceeds_original_consideration');
  const consideration_complete=consideration_problems.length===0;
  const netConsideration=consideration_complete?net:null;
  const netCny=netConsideration===null?null:divide(netConsideration,ratio(100n));
  const contribution=variable===null||netCny===null?null:subtract(netCny,variable);
  const margin=contribution===null||netCny===null||netCny.numerator<=0n?null:divide(contribution,netCny);
  return {report_version:ECONOMICS_REPORT_VERSION,run_id:input.run_id,snapshot_hash,cost_complete:complete,problems,
    model_attempts:String(attempts.length),billable_attempts:String(billable),unpriced_attempts:String(unpriced),
    review_history:{current_snapshot_reviewed:!!review,stale_snapshot_hashes:[...new Set((input.reviews??[]).filter(r=>r.snapshot_hash!==snapshot_hash).map(r=>r.snapshot_hash))].sort()},
    known_model_cost_native:Object.fromEntries(Object.entries(native).sort(([a],[b])=>a.localeCompare(b)).map(([currency,cost])=>[currency,exactDecimal(cost)!])),
    missing_categories,extra_cost_fen:expenses_valid?extra.toString():null,fixed_budget_allocation_fen:expenses_valid?budget.toString():null,
    delivered_service_charge_points:charge.toString(),service_compensation_points:compensation.toString(),net_service_points:(charge-compensation).toString(),
    // Deprecated names are retained as exact nominal-point aliases, never cash revenue.
    delivered_service_charge_fen:charge.toString(),service_compensation_fen:compensation.toString(),net_service_fen:(charge-compensation).toString(),
    consideration_complete,consideration_problems,cash_consideration_fen:ratioJson(cash),cash_compensation_fen:ratioJson(reversal),
    consideration_slices:consideration_slices??null,compensation_slices:compensation_slices??null,net_consideration_fen:ratioJson(netConsideration),
    variable_cost_cny:variable===null?null:exactDecimal(variable),contribution_cny:ratioJson(contribution),contribution_margin:ratioJson(margin),
    display_only:{authoritative:false,rounding:'nearest_ties_away_from_zero',cash_fen_decimal_places:6,cny_decimal_places:6,margin_decimal_places:8,
      cash_consideration_fen:roundedDecimal(cash,6),cash_compensation_fen:roundedDecimal(reversal,6),net_consideration_fen:roundedDecimal(netConsideration,6),
      variable_cost_cny:roundedDecimal(variable,6),contribution_cny:roundedDecimal(contribution,6),contribution_margin:roundedDecimal(margin,8)},
    actual_supplier_invoice_cost:null,after_tax_net_profit:null,after_tax_net_margin:null,
    accounting_notice:'Exact-v2 management contribution, not statutory revenue, supplier cash paid or company net profit. All money arithmetic uses exact decimal/rational values; only display_only is rounded. Service-charge *_fen aliases are deprecated nominal points. Cash consideration and reversals use each immutable original-lot A*p/Q; absent basis/allocation evidence stays unknown. Measured usage times a rate is not a supplier invoice. Company fixed costs, idle capacity, other conversations, unsuccessful quotations, tax and unallocated costs require separate company-period reconciliation.'};
}

async function load(c:PoolClient,runId:string){
  const run=(await c.query('SELECT id,owner_user_id,project_id,state FROM bb_runs WHERE id=$1',[runId])).rows[0];if(!run)throw missing();
  const attempts=(await c.query(`SELECT l.*,l.cost_amount::text cost_amount,r.input_per_million::text,r.cached_input_per_million::text,r.output_per_million::text,r.reasoning_output_per_million::text
    FROM bb_platform_cost_ledger l LEFT JOIN bb_model_cost_rates r ON r.rate_ref=l.rate_ref
    WHERE l.run_id=$1 AND l.owner_user_id=$2 ORDER BY l.attempt_id`,[runId,run.owner_user_id])).rows;
  const expenses=(await c.query('SELECT e.*,e.amount_fen::text amount_fen FROM bb_commerce_expense_evidence e WHERE run_id=$1 AND owner_user_id=$2 ORDER BY id',[runId,run.owner_user_id])).rows;
  const reviews=(await c.query('SELECT * FROM bb_commerce_cost_reviews WHERE run_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC,id DESC',[runId,run.owner_user_id])).rows;
  // All quote families settle through this one reservation table. Never sum history DTOs again.
  const money=(await c.query(`SELECT COALESCE(sum(COALESCE(charged_points,points)) FILTER(WHERE state='settled'),0)::text charge
    FROM bb_credit_reservations WHERE run_id=$1 AND owner_user_id=$2 AND billing_policy='on_delivery'`,[runId,run.owner_user_id])).rows[0];
  const tagged=(await c.query(`SELECT EXISTS(
    SELECT 1 FROM bb_commerce_scope_runs WHERE owner_user_id=$2 AND run_id=$1
    UNION ALL SELECT 1 FROM bb_automatic_scope_runs WHERE owner_user_id=$2 AND run_id=$1
    UNION ALL SELECT 1 FROM bb_credit_quotes WHERE owner_user_id=$2 AND scope_quote_id IS NOT NULL AND id IN(SELECT quote_id FROM bb_credit_reservations WHERE run_id=$1)
    UNION ALL SELECT 1 FROM bb_m4_quotes WHERE owner_user_id=$2 AND scope_quote_id IS NOT NULL AND id IN(SELECT quote_id FROM bb_credit_reservations WHERE run_id=$1)
    UNION ALL SELECT 1 FROM bb_project_qa_quotes WHERE owner_user_id=$2 AND run_id=$1 AND price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3','bb-task-price-scope-20261111-v4')
    UNION ALL SELECT 1 FROM bb_project_file_check_quotes WHERE owner_user_id=$2 AND run_id=$1
    UNION ALL SELECT 1 FROM bb_project_file_update_quotes WHERE owner_user_id=$2 AND run_id=$1 AND scope_quote_id IS NOT NULL
    UNION ALL SELECT 1 FROM bb_integrity_quotes WHERE owner_user_id=$2 AND run_id=$1 AND scope_quote_id IS NOT NULL) ok`,[runId,run.owner_user_id])).rows[0].ok;
  if(!tagged)throw invalid('Only explicitly tagged CNY service runs can be interpreted as fen; legacy credits are not money');
  const correction=(await c.query("SELECT COALESCE(sum(points),0)::text amount FROM bb_credit_events WHERE run_id=$1 AND owner_user_id=$2 AND kind='correction'",[runId,run.owner_user_id])).rows[0];
  const slices=(await c.query(`SELECT a.reservation_id,l.id lot_id,bb_credit_allocation_charge(a.reservation_id,a.lot_id)::text points,l.cash_basis_fen::text numerator_fen,l.cash_basis_points::text denominator_points,
    l.cash_order_id,l.cash_origin_lot_id,(l.cash_order_id IS NULL AND l.cash_basis_fen>0) funding_required,${lotFundingEvidenceSql()} funding_slices
    FROM bb_credit_reservations r JOIN bb_credit_allocations a ON a.reservation_id=r.id
    JOIN bb_credit_lots l ON l.id=a.lot_id AND l.owner_user_id=r.owner_user_id
    WHERE r.run_id=$1 AND r.owner_user_id=$2 AND r.billing_policy='on_delivery' AND r.state='settled' AND bb_credit_allocation_charge(a.reservation_id,a.lot_id)>0 ORDER BY l.id`,[runId,run.owner_user_id])).rows;
  // A correction lot carries the immutable original payment basis. Retrieve each
  // event rather than rounding PostgreSQL division before summing repeating ratios.
  const reversals=(await c.query(`SELECT e.id event_id,e.reservation_id,e.lot_id,e.points::text points,
    l.cash_basis_fen::text numerator_fen,l.cash_basis_points::text denominator_points,l.cash_order_id,l.cash_origin_lot_id,
    (l.cash_order_id IS NULL AND l.cash_basis_fen>0) funding_required,${lotFundingEvidenceSql()} funding_slices
    FROM bb_credit_events e LEFT JOIN bb_credit_lots l ON l.id=e.lot_id AND l.owner_user_id=e.owner_user_id
    WHERE e.run_id=$1 AND e.owner_user_id=$2 AND e.kind='correction' ORDER BY e.id`,[runId,run.owner_user_id])).rows;
  return {run,reportInput:{run_id:run.id,state:run.state,revenue_fen:money.charge,compensation_fen:correction.amount,
    consideration_slices:slices,compensation_slices:reversals,attempts,expenses,reviews}};
}
export async function readRunEconomics(pool:Pool,runId:string){
  return transaction(pool,async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');const data=await load(c,runId);return summarizeRunCosts(data.reportInput);});
}
export async function recordExpenseEvidence(pool:Pool,input:{run_id:string;event_key:string;category:ExpenseCategory;amount_fen:number;within_fixed_budget:boolean;incurred_at:string;source_ref:string;evidence_sha256:string;actor:string;reason:string}){
  if(!requiredText(input.run_id,128)||!requiredText(input.event_key,128)||!EXPENSE_CATEGORIES.includes(input.category)||!Number.isSafeInteger(input.amount_fen)||input.amount_fen<0||input.amount_fen>1e9||typeof input.within_fixed_budget!=='boolean'||!Number.isFinite(Date.parse(input.incurred_at))||!requiredText(input.source_ref,512)||!/^[a-f0-9]{64}$/.test(input.evidence_sha256)||!requiredText(input.actor,200)||!requiredText(input.reason,2000))throw invalid('Cost amount, category, dated evidence and attribution are required');
  const fingerprint=hash({...input,incurred_at:new Date(input.incurred_at).toISOString()});
  return transaction(pool,async c=>{
    const run=(await c.query('SELECT owner_user_id,project_id FROM bb_runs WHERE id=$1',[input.run_id])).rows[0];if(!run)throw missing();
    const inserted=(await c.query(`INSERT INTO bb_commerce_expense_evidence(id,owner_user_id,run_id,event_key,category,amount_fen,within_fixed_budget,incurred_at,source_ref,evidence_sha256,actor,reason,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(owner_user_id,run_id,event_key) DO NOTHING RETURNING *`,[uid(),run.owner_user_id,input.run_id,input.event_key,input.category,input.amount_fen,input.within_fixed_budget,input.incurred_at,input.source_ref,input.evidence_sha256,input.actor,input.reason,fingerprint])).rows[0];
    const row=inserted??(await c.query('SELECT * FROM bb_commerce_expense_evidence WHERE owner_user_id=$1 AND run_id=$2 AND event_key=$3',[run.owner_user_id,input.run_id,input.event_key])).rows[0];
    if(inserted)await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'commerce.cost_evidence_recorded',$4)",[uid(),run.owner_user_id,run.project_id,{run_id:input.run_id,evidence_id:row.id,category:input.category}]);
    if(row.request_hash.trim()!==fingerprint)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Expense evidence key already used');return row.id as string;
  });
}
export async function reviewRunCosts(pool:Pool,input:{run_id:string;expected_snapshot_hash:string;model_required:boolean;actor:string;reason:string;source_ref:string}){
  if(typeof input.model_required!=='boolean'||!requiredText(input.actor,200)||!requiredText(input.reason,2000)||!requiredText(input.source_ref,512))throw invalid('Cost reviewer and evidence source are required');
  return transaction(pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const {run,reportInput}=await load(c,input.run_id),initial=summarizeRunCosts(reportInput);
    if(initial.snapshot_hash!==input.expected_snapshot_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Cost evidence changed; review the current snapshot');
    const reviewed=summarizeRunCosts({...reportInput,reviews:[{snapshot_hash:initial.snapshot_hash,model_required:input.model_required},...reportInput.reviews]});
    if(!reviewed.cost_complete)throw invalid('Unresolved cost evidence: '+reviewed.problems.join(','));
    const inserted=(await c.query(`INSERT INTO bb_commerce_cost_reviews(id,owner_user_id,run_id,snapshot_hash,model_required,actor,reason,source_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_user_id,run_id,snapshot_hash) DO NOTHING RETURNING *`,[uid(),run.owner_user_id,run.id,initial.snapshot_hash,input.model_required,input.actor,input.reason,input.source_ref])).rows[0];
    const row=inserted??(await c.query('SELECT * FROM bb_commerce_cost_reviews WHERE owner_user_id=$1 AND run_id=$2 AND snapshot_hash=$3',[run.owner_user_id,run.id,initial.snapshot_hash])).rows[0];
    if(inserted)await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'commerce.cost_reviewed',$4)",[uid(),run.owner_user_id,run.project_id,{run_id:run.id,snapshot_hash:initial.snapshot_hash}]);
    if(row.model_required!==input.model_required||row.actor!==input.actor||row.reason!==input.reason||row.source_ref!==input.source_ref)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Cost review is immutable');return reviewed;
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
  const {Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{
    const [command,file]=process.argv.slice(2);
    if(command==='report'&&file)process.stdout.write(JSON.stringify(await readRunEconomics(pool,file),null,2)+'\n');
    else if(command==='expense'&&file)process.stdout.write(JSON.stringify({id:await recordExpenseEvidence(pool,JSON.parse(readFileSync(file,'utf8')))})+'\n');
    else if(command==='review'&&file)process.stdout.write(JSON.stringify(await reviewRunCosts(pool,JSON.parse(readFileSync(file,'utf8'))),null,2)+'\n');
    else throw Error('Use report RUN_ID, expense FILE or review FILE; trusted internal operations only. No supplier requests or customer charges are made.');
  }finally{await pool.end();}
}
