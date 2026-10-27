import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  AUTHORING_BILLING_TASKS, M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_FIXED_PRICE, M4_DOCUMENT_LABELS,
  RunSupplementQuoteRequestSchema, RunSupplementQuoteConfirmRequestSchema, RunSupplementQuoteResponseSchema,
  type RunSupplementQuoteRequest, type RunSupplementQuoteConfirmRequest, type RunSupplementQuoteResponse,
  type RunSupplementQuoteItem,
} from '@bondbuddy/contracts';
import { date, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { activePrice } from './billing.js';
import { classifyFixedPrice } from './billing-classification.js';
import { canonicalInputManifest, inputManifestHash } from './production-rule-pin.js';
import { assertTestChannelReadable } from './non-production-test.js';
import { readRunExecutionInput } from './run-execution-input.js';
import { type RunSupplementProcessingBasis, type RunSupplementProcessingKind } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlanWithBasis, readRunSupplementProcessingPlan,
  recheckRunSupplementProcessingBasis } from './run-supplement-processing-plan.js';

type Db = Pool | PoolClient;
type Scope = { pool: Pool; owner: string; runId: string };
type Create = Scope & { blobs: PrivateBlobs; request: RunSupplementQuoteRequest; validForSeconds?: number };
type Confirm = Scope & { blobs: PrivateBlobs; quoteId: string; request: RunSupplementQuoteConfirmRequest };
type Item = RunSupplementQuoteItem & { price_source: 'none'|'fixed_catalog'|'m4_document_fixed';
  billing_unit: 'm1_word_pair'|'m3_review_outputs'|'m4_document_and_note' };
const same = (left: unknown, right: unknown) => inputManifestHash(left) === inputManifestHash(right);
const changed = () => new Problem(409, 'QUOTE_CHANGED', '补料、已保存工作或价格已变化，请重新核对追加费用。');
const billingUnavailable = () => new Problem(503, 'BILLING_NOT_READY', '原任务的计价依据或现行价格暂时无法核对，请保留补料稍后重试。');
const conflict = () => new Problem(409, 'IDEMPOTENCY_CONFLICT', '同一请求已绑定其他补料报价或确认记录。');
const columns = ['owner_user_id','project_id','run_id','job_id','kind','source_execution_version','source_input_revision',
  'source_input_hash','supplement_revision','receipt_request_id','receipt_request_hash','processing_plan_id',
  'processing_plan_hash','checkpoint_hash','basis_hash','candidate_input_hash','source_quote_id','items','total_points'] as const;

async function visibleRun(db: Db, owner: string, runId: string) {
  const row = (await db.query(`SELECT r.*,j.id AS job_id,j.subtype AS job_subtype,j.checkpoint AS live_checkpoint
    FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    JOIN bb_users u ON u.id=r.owner_user_id WHERE r.owner_user_id=$1 AND r.id=$2
      AND p.deleted_at IS NULL AND p.archived_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'`, [owner,runId])).rows[0];
  if (!row) throw missing();
  assertTestChannelReadable(row.channel);
  return row;
}

function quoteBody(row: any) {
  const fields = Object.fromEntries(columns.map(name => [name, typeof row[name] === 'string' && name.endsWith('_hash') ? row[name].trim() : row[name]]));
  fields.total_points = Number(fields.total_points);
  return { version: 'run-supplement-rework-b1-v1', pricing_rule: 'b1_full_document_v1', ...fields };
}

function checkedQuote(row: any) {
  if (!row || row.pricing_rule !== 'b1_full_document_v1' || row.source_execution_version !== 1
    || !Array.isArray(row.items) || row.items.length !== 1) throw changed();
  const body = quoteBody(row);
  if (canonicalInputManifest(body) !== row.canonical_snapshot_text || inputManifestHash(body) !== row.quote_hash.trim()
    || inputManifestHash({ request_id: row.request_id, supplement_revision: row.supplement_revision,
      saved_request_id: row.receipt_request_id, candidate_input_hash: row.candidate_input_hash.trim() }) !== row.request_hash.trim()) throw changed();
  return row;
}

async function response(db: Db, row: any): Promise<RunSupplementQuoteResponse> {
  checkedQuote(row);
  const confirmation = (await db.query(`SELECT * FROM bb_run_supplement_quote_confirmations
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND quote_id=$4`,
  [row.owner_user_id,row.project_id,row.run_id,row.id])).rows[0];
  const result: RunSupplementQuoteResponse = {
    quote: { quote_id: row.id, project_id: row.project_id, run_id: row.run_id,
      supplement_revision: row.supplement_revision, saved_request_id: row.receipt_request_id,
      pricing_rule: 'b1_full_document_v1', items: row.items.map(({price_source: _source,billing_unit: _unit,...item}: Item) => item),
      total_points: Number(row.total_points), quote_hash: row.quote_hash.trim(), created_at: date(row.created_at), expires_at: date(row.expires_at) },
    confirmation: confirmation ? { confirmation_id: confirmation.id, quote_id: row.id, project_id: row.project_id,
      run_id: row.run_id, request_id: confirmation.request_id, quote_hash: confirmation.quote_hash.trim(),
      total_points: Number(confirmation.total_points), confirmed_at: date(confirmation.created_at) } : null,
  };
  if (confirmation && (confirmation.confirmed_by !== row.owner_user_id || confirmation.quote_hash.trim() !== row.quote_hash.trim()
    || Number(confirmation.total_points) !== Number(row.total_points)
    || inputManifestHash({request_id:confirmation.request_id,quote_hash:row.quote_hash.trim()}) !== confirmation.request_hash.trim())) throw changed();
  if (!Value.Check(RunSupplementQuoteResponseSchema,result)) throw changed();
  return result;
}

async function latestReceipt(db: Db, owner: string, runId: string, revision: number, requestId: string) {
  const latest = (await db.query(`SELECT * FROM bb_run_supplement_drafts
    WHERE owner_user_id=$1 AND run_id=$2 ORDER BY revision DESC LIMIT 1`, [owner,runId])).rows[0];
  if (!latest || latest.revision !== revision || latest.request_id !== requestId) throw changed();
  return latest;
}

/** Use the original business category; a saved clean baseline is not a new interim task. */
async function pricedItem(db: PoolClient, run: any, basis: RunSupplementProcessingBasis) {
  const kind = basis.kind, manifest = (await readRunExecutionInput(db,run.owner_user_id,run.id,basis.sourceExecution)).input.manifest as Record<string,any>;
  let sourceQuote: any = null;
  if (run.reservation_id) {
    const table = kind === 'm4' ? 'bb_m4_quotes' : 'bb_credit_quotes';
    sourceQuote = (await db.query(`SELECT q.*,c.points AS reservation_points FROM bb_credit_reservations c
      JOIN ${table} q ON q.id=c.quote_id AND q.owner_user_id=c.owner_user_id
      WHERE c.id=$1 AND c.owner_user_id=$2 AND c.run_id=$3`, [run.reservation_id,run.owner_user_id,run.id])).rows[0];
    if (!sourceQuote) throw billingUnavailable();
  } else if (['fixed_credits','metered_credits'].includes(run.billing_mode)) throw billingUnavailable();
  let task: string | null = null, name: string;
  if (kind === 'authoring') {
    if (sourceQuote) {
      if (sourceQuote.project_id !== run.project_id || sourceQuote.intent_hash !== null
        || sourceQuote.input_revision !== run.input_revision || sourceQuote.input_hash.trim() !== run.input_hash.trim()
        || !Object.hasOwn(AUTHORING_BILLING_TASKS,sourceQuote.task_type)) throw billingUnavailable();
      task = sourceQuote.task_type;
    } else task = classifyFixedPrice(manifest).task;
    name = '募集说明书';
  } else if (kind === 'review') {
    task = manifest.review?.operation;
    if (!['full_review','differential_review'].includes(task ?? '') || sourceQuote && (sourceQuote.project_id !== run.project_id
      || sourceQuote.task_type !== task || !sourceQuote.intent_hash || sourceQuote.input_hash.trim() !== sourceQuote.intent_hash.trim()
      || sourceQuote.input_revision !== manifest.draft_revision)) throw billingUnavailable();
    const pin = manifest.review.input.source_material_ref;
    name = basis.materials.find(value => value.pin.material_id === pin.material_id && value.pin.material_version === pin.material_version)?.filename
      ?? (task === 'full_review' ? '完整复核' : '差异复核');
  } else {
    const type = manifest.input?.document_type as keyof typeof M4_DOCUMENT_BILLING_TASKS;
    task = M4_DOCUMENT_BILLING_TASKS[type];
    if (!task || manifest.billing_task !== task || sourceQuote && (sourceQuote.task_type !== task
      || sourceQuote.topic_id !== manifest.topic_id || sourceQuote.intent_hash.trim() !== inputManifestHash(manifest)
      || !same(sourceQuote.snapshot,manifest))) throw billingUnavailable();
    name = M4_DOCUMENT_LABELS[type];
  }
  const common = {target_id:run.id,document_name:name.slice(0,500),task_type:task,
    billing_unit:kind === 'authoring' ? 'm1_word_pair' as const : kind === 'review' ? 'm3_review_outputs' as const : 'm4_document_and_note' as const};
  if (basis.priorWorkStatus === 'no_prior_work') return { sourceQuoteId: sourceQuote?.id ?? null,
    item: {...common,task_type:null,needs_redo:false,price_source:'none',price_version:null,full_price_points:null,points:0} as Item };
  if (basis.priorWorkStatus !== 'captured_complete' || !basis.priorWork || !task) throw billingUnavailable();
  const price = kind === 'm4' ? null : await activePrice(db);
  const points = kind === 'm4' ? M4_DOCUMENT_FIXED_PRICE.points : price.prices[task];
  if (!Number.isSafeInteger(points) || points < 1 || points > 1e9) throw billingUnavailable();
  return { sourceQuoteId:sourceQuote?.id ?? null, item:{...common,needs_redo:true,
    price_source:kind === 'm4' ? 'm4_document_fixed' : 'fixed_catalog',
    price_version:kind === 'm4' ? M4_DOCUMENT_FIXED_PRICE.version : price.id,full_price_points:points,points} as Item };
}

/** Creation, confirmation and adoption share the same business price rules.
 * Adoption revalidates the accepted quote; it never silently reprices consent. */
async function recheckQuotePrice(db: PoolClient, scope: Scope, quote: any, basis: RunSupplementProcessingBasis) {
  const run = await visibleRun(db,scope.owner,scope.runId), price = await pricedItem(db,run,basis);
  if (!same(quote.items,[price.item]) || quote.source_quote_id !== price.sourceQuoteId
    || !(await db.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[quote.expires_at])).rowCount) throw changed();
}

async function preparation(input: Create) {
  const run = await visibleRun(input.pool,input.owner,input.runId);
  await latestReceipt(input.pool,input.owner,input.runId,input.request.supplement_revision,input.request.saved_request_id);
  const frozen = await readRunExecutionInput(input.pool,input.owner,input.runId,
    {executionVersion:1,inputRevision:run.input_revision,inputHash:run.input_hash.trim()});
  const manifest = frozen.input.manifest as Record<string,any>;
  const kind: RunSupplementProcessingKind = run.job_subtype === 'm4_document_v1' ? 'm4' : manifest.review ? 'review' : 'authoring';
  const args = {db:input.pool,blobs:input.blobs,owner:input.owner,projectId:run.project_id,runId:run.id,
    revision:input.request.supplement_revision,expectedCheckpointHash:inputManifestHash(run.live_checkpoint),
    expectedCandidateInputHash:input.request.candidate_input_hash};
  const saved = await createRunSupplementProcessingPlanWithBasis({...args,kind,
    requestId:`supplement-quote-${inputManifestHash(input.request.request_id)}`});
  return {...saved,args};
}

/** Quotation is consent data only: never changes run inputs, queue, credit lots or execution authority. */
async function createQuote(input: Create): Promise<RunSupplementQuoteResponse> {
  if (!Value.Check(RunSupplementQuoteRequestSchema,input.request) || input.validForSeconds !== undefined
    && (!Number.isSafeInteger(input.validForSeconds) || input.validForSeconds < 1 || input.validForSeconds > 300))
    throw new Problem(422,'VALIDATION_FAILED','补料报价请求无效。');
  await visibleRun(input.pool,input.owner,input.runId);
  const requestHash = inputManifestHash(input.request);
  const prior = (await input.pool.query(`SELECT * FROM bb_run_supplement_quotes
    WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`, [input.owner,input.runId,input.request.request_id])).rows[0];
  if (prior) { if (prior.request_hash.trim() !== requestHash) throw conflict(); return response(input.pool,prior); }
  const {plan,basis,args} = await preparation(input);
  return transaction(input.pool,async db => {
    await recheckRunSupplementProcessingBasis(db,args,basis);
    await latestReceipt(db,input.owner,input.runId,input.request.supplement_revision,input.request.saved_request_id);
    const existing = (await db.query(`SELECT * FROM bb_run_supplement_quotes WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`,
    [input.owner,input.runId,input.request.request_id])).rows[0];
    if (existing) { if (existing.request_hash.trim() !== requestHash) throw conflict(); return response(db,existing); }
    const run = await visibleRun(db,input.owner,input.runId), price = await pricedItem(db,run,basis), source = basis.sourceExecution;
    const fields = {owner_user_id:input.owner,project_id:run.project_id,run_id:run.id,job_id:run.job_id,kind:basis.kind,
      source_execution_version:source.executionVersion,source_input_revision:source.inputRevision,source_input_hash:source.inputHash,
      supplement_revision:basis.revision,receipt_request_id:basis.requestId,receipt_request_hash:basis.requestHash,
      processing_plan_id:plan.id,processing_plan_hash:plan.planHash,checkpoint_hash:basis.checkpointHash,basis_hash:basis.basisHash,
      candidate_input_hash:basis.candidateInputHash,source_quote_id:price.sourceQuoteId,items:[price.item],total_points:price.item.points};
    const body = quoteBody(fields), canonical = canonicalInputManifest(body);
    const row = (await db.query(`INSERT INTO bb_run_supplement_quotes
      (id,${columns.join(',')},pricing_rule,canonical_snapshot_text,quote_hash,request_id,request_hash,valid_for_seconds)
      VALUES(${Array.from({length:columns.length+7},(_,index)=>`$${index+1}`).join(',')}) RETURNING *`,
    [uid(),...columns.map(key => key === 'items' ? JSON.stringify(fields[key]) : fields[key]),'b1_full_document_v1',canonical,
      inputManifestHash(body),input.request.request_id,requestHash,input.validForSeconds ?? 300])).rows[0];
    await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run_supplement_quote',$3,'run.supplement_quote_created',$4::jsonb)`,
    [uid(),input.owner,input.runId,JSON.stringify({quote_id:row.id,supplement_revision:row.supplement_revision,
      quote_hash:row.quote_hash.trim(),total_points:Number(row.total_points)})]);
    return response(db,row);
  });
}

async function readQuote(input: Scope & {quoteId:string}): Promise<RunSupplementQuoteResponse> {
  await visibleRun(input.pool,input.owner,input.runId);
  const row = (await input.pool.query('SELECT * FROM bb_run_supplement_quotes WHERE owner_user_id=$1 AND run_id=$2 AND id=$3',
    [input.owner,input.runId,input.quoteId])).rows[0];
  if (!row) throw missing();
  return response(input.pool,row);
}

async function confirmQuote(input: Confirm): Promise<RunSupplementQuoteResponse> {
  if (!Value.Check(RunSupplementQuoteConfirmRequestSchema,input.request)) throw new Problem(422,'VALIDATION_FAILED','报价确认请求无效。');
  const current = await readRunSupplementQuote(input), requestHash = inputManifestHash(input.request);
  const existing = (await input.pool.query(`SELECT * FROM bb_run_supplement_quote_confirmations
    WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`, [input.owner,input.runId,input.request.request_id])).rows[0];
  if (existing) {
    if (existing.quote_id !== input.quoteId || existing.request_hash.trim() !== requestHash) throw conflict();
    return readRunSupplementQuote(input);
  }
  if (current.confirmation) throw conflict();
  if (current.quote.quote_hash !== input.request.quote_hash) throw changed();
  const quote = checkedQuote((await input.pool.query('SELECT * FROM bb_run_supplement_quotes WHERE owner_user_id=$1 AND run_id=$2 AND id=$3',
    [input.owner,input.runId,input.quoteId])).rows[0]);
  const args = {db:input.pool,blobs:input.blobs,owner:input.owner,projectId:quote.project_id,runId:input.runId,
    revision:quote.supplement_revision,expectedCheckpointHash:quote.checkpoint_hash.trim(),expectedCandidateInputHash:quote.candidate_input_hash.trim()};
  const {plan,basis} = await readRunSupplementProcessingPlan({...args,kind:quote.kind,planId:quote.processing_plan_id});
  if (plan.planHash !== quote.processing_plan_hash.trim()) throw changed();
  return transaction(input.pool,async db => {
    await recheckRunSupplementProcessingBasis(db,args,basis);
    await latestReceipt(db,input.owner,input.runId,quote.supplement_revision,quote.receipt_request_id);
    const replay = (await db.query(`SELECT * FROM bb_run_supplement_quote_confirmations
      WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`,[input.owner,input.runId,input.request.request_id])).rows[0];
    if (replay) { if (replay.quote_id !== input.quoteId || replay.request_hash.trim() !== requestHash) throw conflict(); return response(db,quote); }
    await recheckQuotePrice(db,input,quote,basis);
    const confirmationId = uid();
    await db.query(`INSERT INTO bb_run_supplement_quote_confirmations
      (id,owner_user_id,project_id,run_id,quote_id,quote_hash,total_points,request_id,request_hash,confirmed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$2)`,[confirmationId,input.owner,quote.project_id,input.runId,input.quoteId,
      quote.quote_hash.trim(),Number(quote.total_points),input.request.request_id,requestHash]);
    await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run_supplement_quote',$3,'run.supplement_quote_confirmed',$4::jsonb)`,
    [uid(),input.owner,input.runId,JSON.stringify({quote_id:quote.id,confirmation_id:confirmationId,
      quote_hash:quote.quote_hash.trim(),total_points:Number(quote.total_points)})]);
    return response(db,quote);
  });
}

async function quoteBoundary<T>(work:()=>Promise<T>):Promise<T> {
  try { return await work(); }
  catch (error) {
    const sql = error as {code?:string;constraint?:string};
    if (sql.code === '23505' && (sql.constraint?.startsWith('bb_run_supplement_quote')
      || sql.constraint?.startsWith('bb_supplement_quote'))) throw conflict();
    if (sql.code === '55P03' || sql.code === '23514' && sql.constraint?.startsWith('bb_supplement_quote')) throw changed();
    throw error;
  }
}

export async function createRunSupplementQuote(input:Create):Promise<RunSupplementQuoteResponse> {
  return quoteBoundary(()=>createQuote(input));
}
export async function readRunSupplementQuote(input:Scope & {quoteId:string}):Promise<RunSupplementQuoteResponse> {
  return quoteBoundary(()=>readQuote(input));
}
export async function confirmRunSupplementQuote(input:Confirm):Promise<RunSupplementQuoteResponse> {
  return quoteBoundary(()=>confirmQuote(input));
}

export type ConfirmedRunSupplementQuoteInput = Scope & { blobs: PrivateBlobs; quoteId: string; confirmationId: string; quoteHash: string };
/** This verified preparation remains data, not debit/execution authority. Only
 * the separate atomic adoption transaction may consume it. */
export async function readConfirmedRunSupplementQuoteForAdoption(input: ConfirmedRunSupplementQuoteInput) {
  await visibleRun(input.pool,input.owner,input.runId);
  const row = (await input.pool.query(`SELECT * FROM bb_run_supplement_quotes
    WHERE owner_user_id=$1 AND run_id=$2 AND id=$3`, [input.owner,input.runId,input.quoteId])).rows[0];
  if (!row) throw missing();
  const quote = checkedQuote(row);
  await exactConfirmation(input.pool,input,quote);
  const args = { db:input.pool,blobs:input.blobs,owner:input.owner,projectId:quote.project_id,runId:input.runId,
    revision:quote.supplement_revision,expectedCheckpointHash:quote.checkpoint_hash.trim(),
    expectedCandidateInputHash:quote.candidate_input_hash.trim() };
  const {plan,basis} = await readRunSupplementProcessingPlan({...args,kind:quote.kind,planId:quote.processing_plan_id});
  if (plan.planHash !== quote.processing_plan_hash.trim() || basis.basisHash !== quote.basis_hash.trim()) throw changed();
  return { quote,plan,basis,args };
}
export type ConfirmedRunSupplementQuotePreparation = Awaited<ReturnType<typeof readConfirmedRunSupplementQuoteForAdoption>>;
async function exactConfirmation(db: Db, input: ConfirmedRunSupplementQuoteInput, quote: any) {
  const current = await response(db,quote), confirmation = current.confirmation;
  if (quote.id !== input.quoteId || quote.quote_hash.trim() !== input.quoteHash || !confirmation
    || confirmation.confirmation_id !== input.confirmationId || confirmation.quote_id !== input.quoteId
    || confirmation.quote_hash !== input.quoteHash || confirmation.total_points !== Number(quote.total_points)) throw changed();
  return confirmation;
}
/** Recheck under project -> run -> job locks after byte I/O has completed. An
 * existing adoption must be replayed before calling this freshness validator. */
export async function recheckConfirmedRunSupplementQuoteForAdoption(db: PoolClient,
  input: ConfirmedRunSupplementQuoteInput, prepared: ConfirmedRunSupplementQuotePreparation) {
  await recheckRunSupplementProcessingBasis(db,prepared.args,prepared.basis);
  const quote = checkedQuote((await db.query(`SELECT * FROM bb_run_supplement_quotes
    WHERE owner_user_id=$1 AND run_id=$2 AND id=$3 FOR SHARE`, [input.owner,input.runId,input.quoteId])).rows[0]);
  if (quote.canonical_snapshot_text !== prepared.quote.canonical_snapshot_text
    || quote.request_hash.trim() !== prepared.quote.request_hash.trim()
    || date(quote.created_at) !== date(prepared.quote.created_at) || date(quote.expires_at) !== date(prepared.quote.expires_at)) throw changed();
  await db.query(`SELECT id FROM bb_run_supplement_quote_confirmations
    WHERE owner_user_id=$1 AND run_id=$2 AND id=$3 AND quote_id=$4 FOR SHARE`,
  [input.owner,input.runId,input.confirmationId,input.quoteId]);
  const confirmation = await exactConfirmation(db,input,quote);
  await latestReceipt(db,input.owner,input.runId,quote.supplement_revision,quote.receipt_request_id);
  await recheckQuotePrice(db,input,quote,prepared.basis);
  return { quote,confirmation };
}

export function registerRunSupplementQuoteRoutes(app: FastifyInstance, pool:()=>Pool, blobs:()=>PrivateBlobs,
  owner:(request:FastifyRequest)=>Promise<string>) {
  app.post('/api/v1/runs/:run_id/supplement-quotes',{schema:{body:RunSupplementQuoteRequestSchema,response:{200:RunSupplementQuoteResponseSchema}}},async request =>
    createRunSupplementQuote({pool:pool(),blobs:blobs(),owner:await owner(request),runId:(request.params as {run_id:string}).run_id,request:request.body as RunSupplementQuoteRequest}));
  app.get('/api/v1/runs/:run_id/supplement-quotes/:quote_id',{schema:{response:{200:RunSupplementQuoteResponseSchema}}},async request =>
    readRunSupplementQuote({pool:pool(),owner:await owner(request),runId:(request.params as {run_id:string}).run_id,quoteId:(request.params as {quote_id:string}).quote_id}));
  app.post('/api/v1/runs/:run_id/supplement-quotes/:quote_id/confirm',{schema:{body:RunSupplementQuoteConfirmRequestSchema,response:{200:RunSupplementQuoteResponseSchema}}},async request =>
    confirmRunSupplementQuote({pool:pool(),blobs:blobs(),owner:await owner(request),runId:(request.params as {run_id:string}).run_id,
      quoteId:(request.params as {quote_id:string}).quote_id,request:request.body as RunSupplementQuoteConfirmRequest}));
}
