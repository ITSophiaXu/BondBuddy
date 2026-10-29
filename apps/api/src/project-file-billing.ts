import type {PoolClient} from 'pg';
import {AUTOMATIC_PRICE_VERSION,PROJECT_FILE_UPDATE_PRICE,LEGACY_OUTCOME_PRICE_VERSION,isOutcomePriceVersion,type OutcomeWorkPlan,type ProjectFileOperation} from '@bondbuddy/contracts';
import {creditBalance,lockCreditAccount} from './billing.js';
import {Problem,uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {requestScope,assertScopeQuote,assertAcceptedScope} from './scope-quotations.js';
import {bindCommerceScopeRun} from './commerce-coverage.js';

type Check=Extract<ProjectFileOperation,{operation:'check'}>;
export const fileCheckFingerprint=(input:Check)=>inputManifestHash({version_id:input.source.version_id,asset:input.source.asset});
/** One pinned source and target file define the comparison goal, independent of check/quote/retry ids. */
export const fileConsistencyCoverageKey=(source:Check['source'],fileVersion:string)=>'file-consistency:'+inputManifestHash({project_id:source.project_id,source_fingerprint:fileCheckFingerprint({operation:'check',version:'project-file-operation-v1',source,files:[]}),file_version_id:fileVersion,target_scope:'whole_file_source_consistency'});
// Price-version inspection must not change the historical exact-evidence scope hash.
const quotedCheckEvidence=(row:any)=>{const {price_version:_,...evidence}=row;return evidence;};

/** A settled quote proves which exact target versions were paid for. Free legacy checks do not. */
export async function paidFileCheckEvidence(c:PoolClient,owner:string,source:Check['source']){
  const rows=(await c.query(`SELECT q.id AS quote_id,q.run_id,q.scope_quote_id,q.price_version,q.charged_file_versions,q.points,q.source_fingerprint FROM bb_project_file_check_quotes q
    JOIN bb_credit_reservations r ON r.quote_id=q.id AND r.owner_user_id=q.owner_user_id AND r.run_id=q.run_id
    JOIN bb_runs run ON run.id=q.run_id AND run.owner_user_id=q.owner_user_id
    WHERE q.owner_user_id=$1 AND q.source_fingerprint=$2 AND r.state='settled' AND r.charged_points=q.points AND run.state='succeeded'
      AND NOT EXISTS(SELECT 1 FROM bb_credit_events e WHERE e.owner_user_id=q.owner_user_id AND e.reservation_id=r.id AND e.kind='correction')
    ORDER BY q.created_at,q.id`,
    [owner,fileCheckFingerprint({operation:'check',version:'project-file-operation-v1',source,files:[]})])).rows;
  if(!automaticBillingEnabled(c))return rows;
  // Revalidation follows only platform-produced repairs from this paid maintenance round.
  // User uploads and edits have no such lineage, so they create a new paid scope.
  for(const row of rows.filter(r=>r.price_version===AUTOMATIC_PRICE_VERSION)){
    const covered=(await c.query(`WITH RECURSIVE covered(version_id) AS (
      SELECT jsonb_array_elements_text($2::jsonb)
      UNION
      SELECT v.id FROM covered parent
      JOIN bb_project_file_operations op ON op.owner_user_id=$1 AND op.operation='patch' AND op.manifest->>'file_version_id'=parent.version_id
      JOIN bb_runs run ON run.owner_user_id=op.owner_user_id AND run.id=op.run_id AND run.state='succeeded'
      JOIN bb_project_file_update_quotes q ON q.owner_user_id=op.owner_user_id AND q.run_id=op.run_id AND q.points=0 AND q.price_version=$5
      JOIN bb_scope_quotations scope ON scope.owner_user_id=q.owner_user_id AND scope.id=q.scope_quote_id AND scope.automatic_price->'source_quote_ids' ? $6
      JOIN bb_project_file_versions v ON v.owner_user_id=op.owner_user_id AND v.run_id=op.run_id AND v.file_id=op.manifest->>'file_id'
      WHERE op.manifest->'source'->>'version_id'=$3 AND op.manifest->'source'->'asset'=$4::jsonb
    ) SELECT version_id FROM covered ORDER BY version_id`,[owner,JSON.stringify(row.charged_file_versions),source.version_id,JSON.stringify(source.asset),AUTOMATIC_PRICE_VERSION,row.quote_id])).rows;
    const original=new Set<string>(row.charged_file_versions);
    row.charged_file_versions=[...row.charged_file_versions,...covered.map(r=>r.version_id).filter(id=>!original.has(id))];
  }
  return rows;
}
export async function paidFileChecks(c:PoolClient,owner:string,source:Check['source']):Promise<Set<string>>{
  const rows=await paidFileCheckEvidence(c,owner,source);
  return new Set(rows.flatMap(r=>r.charged_file_versions as string[]));
}
export async function fileCheckPrice(c:PoolClient,owner:string,input:Check,projectId=input.source.project_id){
  const evidence=await paidFileCheckEvidence(c,owner,input.source),paid=new Set(evidence.flatMap(r=>r.charged_file_versions as string[])),charged=input.files.map(f=>f.file_version_id).filter(id=>!paid.has(id));
  const snapshot={manifest:input,charged_file_versions:charged,paid_checks:evidence.filter(e=>(e.charged_file_versions as string[]).some(id=>input.files.some(f=>f.file_version_id===id))).map(quotedCheckEvidence)};
  // Historical paid results can be reused, but are never converted into new contractual rights.
  const legacyPaid=new Set(evidence.filter(e=>e.price_version===LEGACY_OUTCOME_PRICE_VERSION).flatMap(e=>e.charged_file_versions as string[]));
  const workPlan:OutcomeWorkPlan={scope_status:'confirmed',items:input.files.filter(f=>!legacyPaid.has(f.file_version_id)).map(f=>({key:f.file_version_id,coverage_key:fileConsistencyCoverageKey(input.source,f.file_version_id),family:'goal_upgrade',price_key:'check',label:`一致性检查：${f.filename}`.slice(0,200),evidence:[`固定募集书版本 ${input.source.version_id} 与关联文件版本 ${f.file_version_id}，检查整份文件与该来源的一致性；不作独立实质复核。`]}))};
  const scope=workPlan.items.length?await requestScope(c,owner,projectId,'project_file_check',inputManifestHash(snapshot),snapshot,workPlan):null;
  return {points:scope?.amount_fen??0,price_version:scope?.price_version??LEGACY_OUTCOME_PRICE_VERSION,scope_quote_id:scope?.scope_quote_id,quote_status:scope?.quote_status??'ready' as const,scope_expires_at:scope?.scope_expires_at??null,scope_lines:scope?.scope_lines??[],scope_hash:inputManifestHash(snapshot),charged_file_versions:charged,source_fingerprint:fileCheckFingerprint(input)};
}
async function hold(c:PoolClient,owner:string,run:any,quote:string,points:number,reason:string){
  await requireFileUpdateCredits(c,owner,points,true);
  const reservation=uid();
  await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,$5,'on_delivery')`,[reservation,owner,run.id,quote,points]);
  const lots=(await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now())
    ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`,[owner])).rows;
  let left=points;
  for(const lot of lots){const take=Math.min(left,Number(lot.remaining)-Number(lot.frozen));
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lot.id,take]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservation,lot.id,take]);left-=take;if(!left)break;}
  if(left)throw new Problem(503,'DATA_UNAVAILABLE','File credit allocation mismatch');
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,$7)`,[uid(),owner,'reserve:'+reservation,points,reservation,run.id,reason]);
  await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run.id,reservation]);
  run.billing_mode='fixed_credits';run.reservation_id=reservation;
}
export async function reserveFileCheck(c:PoolClient,owner:string,run:any,input:Check,expectedPoints:number,scopeQuoteId?:string){
  const price=await fileCheckPrice(c,owner,input,run.project_id);
  if(price.scope_quote_id){const scope=await assertScopeQuote(c,scopeQuoteId,owner,run.project_id,'project_file_check',price.scope_hash,expectedPoints);if(scope.price_version!==price.price_version)throw new Problem(409,'QUOTE_CHANGED','人民币检查规则版本已变化。');}
  if(price.points!==expectedPoints)throw new Problem(409,'QUOTE_CHANGED','已付检查范围已变化，请刷新人民币报价。');
  const quote=uid();
  await c.query(`INSERT INTO bb_project_file_check_quotes(id,owner_user_id,project_id,run_id,input_hash,source_fingerprint,file_versions,charged_file_versions,points,price_version,scope_quote_id,scope_lines,scope_work_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[quote,owner,run.project_id,run.id,run.input_hash,price.source_fingerprint,JSON.stringify(input.files.map(f=>f.file_version_id)),JSON.stringify(price.charged_file_versions),price.points,price.price_version,price.scope_quote_id??null,JSON.stringify(price.scope_lines),price.scope_quote_id?price.scope_hash:null]);
  // An all-reused scope has no new sale or hold. Its previous paid evidence remains authoritative.
  if(price.points)await hold(c,owner,run,quote,price.points,'outcome_file_check_confirmed');
  if(price.scope_quote_id)await bindCommerceScopeRun(c,owner,price.scope_quote_id,run.id);
}
export async function fileUpdatePrice(c:PoolClient,owner:string,input:Extract<ProjectFileOperation,{operation:'patch'}>,commercial=false,projectId=input.source.project_id){
  if(!commercial)return {points:PROJECT_FILE_UPDATE_PRICE.points,version:PROJECT_FILE_UPDATE_PRICE.version,scope_quote_id:undefined,quote_status:'ready' as const,scope_lines:[],scope_hash:inputManifestHash({manifest:input})};
  // Select the earliest owned settled proof, so later checks cannot change an accepted/retried quote.
  const evidence=(await paidFileCheckEvidence(c,owner,input.source)).find(e=>(e.charged_file_versions as string[]).includes(input.file_version_id))??null;
  const snapshot={manifest:input,paid_check:evidence?{...quotedCheckEvidence(evidence),...(automaticBillingEnabled(c)?{price_version:evidence.price_version}:{})}:null};
  // A legacy payment needs reviewed exact evidence; it must not silently become a full-price v2 purchase.
  const workPlan:OutcomeWorkPlan|undefined=evidence?.price_version===LEGACY_OUTCOME_PRICE_VERSION?undefined:{scope_status:'confirmed',items:[{key:input.file_version_id,coverage_key:fileConsistencyCoverageKey(input.source,input.file_version_id),family:'goal_upgrade',price_key:'sync',label:`检查并修订：${input.filename}`.slice(0,200),evidence:[`固定募集书版本 ${input.source.version_id} 与关联文件版本 ${input.file_version_id}，仅落实已定位且有依据的差异；人工待确认事项不包含。`]}]};
  const scope=await requestScope(c,owner,projectId,'project_file_patch',inputManifestHash(snapshot),snapshot,workPlan);
  return {points:scope.amount_fen,version:scope.price_version,...scope,scope_hash:inputManifestHash(snapshot)};
}

export async function requireFileUpdateCredits(c:PoolClient,owner:string,points:number,commercial=false){
  await lockCreditAccount(c,owner);
  const balance=await creditBalance(c,owner);
  if(balance.available<points)throw new Problem(402,'CREDITS_INSUFFICIENT',
    automaticBillingEnabled(c)?`本次任务需要 ${points.toLocaleString('zh-CN')} 积分，当前可用 ${balance.available.toLocaleString('zh-CN')} 积分；补足后继续原任务。`:
    commercial?`本次确认范围需要 ¥${(points/100).toFixed(2)}，当前可用 ¥${(balance.available/100).toFixed(2)}；检查结果与原文件已保留。`:
    `本次更新需要 ${points.toLocaleString('zh-CN')} 积分，当前可用 ${balance.available.toLocaleString('zh-CN')} 积分，请充值后更新；检查结果与原文件已保留。`);
}

/** Pin one file's price and reserve the shared wallet in the run-creation transaction.
 * The existing fixed-credit terminal trigger settles only after both Word files are available,
 * and releases the hold on failure/cancellation. Retries never reuse a settled reservation.
 */
export async function reserveFileUpdate(c:PoolClient,owner:string,run:any,input:Extract<ProjectFileOperation,{operation:'patch'}>,commercial=false,pinnedPoints?:number,scopeQuoteId?:string,acceptanceId?:string){
  const accepted=acceptanceId?(await c.query('SELECT s.* FROM bb_scope_acceptances a JOIN bb_scope_quotations s ON s.id=a.scope_quote_id AND s.owner_user_id=a.owner_user_id WHERE a.id=$1 AND a.owner_user_id=$2 AND s.id=$3',[acceptanceId,owner,scopeQuoteId])).rows[0]:null;
  if(acceptanceId&&!accepted)throw new Problem(409,'QUOTE_CHANGED','原批次接受凭据不可用。');
  const price=accepted?{points:Number(accepted.amount_fen),version:accepted.price_version,scope_hash:accepted.input_hash.trim()}:await fileUpdatePrice(c,owner,input,commercial,run.project_id),points=price.points;
  const scope=commercial?(acceptanceId?await assertAcceptedScope(c,acceptanceId,scopeQuoteId,owner,run.project_id,'project_file_patch',price.scope_hash!,pinnedPoints??points,input):await assertScopeQuote(c,scopeQuoteId,owner,run.project_id,'project_file_patch',price.scope_hash!,pinnedPoints??points)):null;
  if(pinnedPoints!==undefined&&pinnedPoints!==points)throw new Problem(409,'QUOTE_CHANGED','检查抵扣范围已变化，请重新核对费用。');
  if(commercial&&(!isOutcomePriceVersion(price.version)||scope?.price_version!==price.version))throw new Problem(409,'QUOTE_CHANGED','人民币更新规则版本已变化。');
  const quote=uid();
  await c.query(`INSERT INTO bb_project_file_update_quotes(id,owner_user_id,project_id,run_id,check_run_id,file_version_id,input_hash,points,price_version,scope_quote_id,scope_lines,scope_work_hash,scope_acceptance_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[quote,owner,run.project_id,run.id,input.check_run_id,input.file_version_id,run.input_hash,points,price.version,scope?.scope_quote_id??null,JSON.stringify(scope?.scope_lines??[]),scope?price.scope_hash:null,acceptanceId??null]);
  if(commercial&&points===0){await bindCommerceScopeRun(c,owner,scope!.scope_quote_id,run.id);return;}
  await requireFileUpdateCredits(c,owner,points,commercial);
  const reservation=uid();
  await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy)
    VALUES($1,$2,$3,$4,$5,'on_delivery')`,[reservation,owner,run.id,quote,points]);
  const lots=(await c.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen AND (expires_at IS NULL OR expires_at>now())
    ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`,[owner])).rows;
  let left:number=points;
  for(const lot of lots){
    const take=Math.min(left,Number(lot.remaining)-Number(lot.frozen));
    await c.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1',[lot.id,take]);
    await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)',[reservation,lot.id,take]);
    left-=take;if(!left)break;
  }
  if(left)throw new Problem(503,'DATA_UNAVAILABLE','File update credit allocation mismatch');
  await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
    VALUES($1,$2,$3,'reserve',$4,$5,$6,$2,'project_file_update_confirmed')`,[uid(),owner,'reserve:'+reservation,points,reservation,run.id]);
  await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run.id,reservation]);
  run.billing_mode='fixed_credits';run.reservation_id=reservation;
  if(scope)await bindCommerceScopeRun(c,owner,scope.scope_quote_id,run.id);
}
import {automaticBillingEnabled} from './automatic-billing-context.js';
