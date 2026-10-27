import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { RunSupplementAdoptRequestSchema, RunSupplementAdoptionQuerySchema, RunSupplementAdoptionResponseSchema,
  type RunSupplementAdoptRequest, type RunSupplementAdoptionResponse } from '@bondbuddy/contracts';
import { date, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { assertRunExecution } from './run-execution.js';
import { readRunBillingSegment } from './run-billing-segment.js';
import { readConfirmedRunSupplementQuoteForAdoption, recheckConfirmedRunSupplementQuoteForAdoption } from './run-supplement-quote.js';

type Scope = { pool: Pool; owner: string; runId: string };
export type AdoptRunSupplementInput = Scope & { blobs: PrivateBlobs; request: RunSupplementAdoptRequest };
const unavailable = () => new Problem(409,'INPUT_REVISION_CONFLICT','补料采用依据或原任务状态已变化，请保留补料并重新核对。');
const conflict = () => new Problem(409,'IDEMPOTENCY_CONFLICT','同一请求已绑定其他补料采用记录。');
const same = (left: unknown, right: unknown) => inputManifestHash(left) === inputManifestHash(right);
const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

/** Receipt recovery is read only and remains valid after a run advances or its
 * project is archived. Deleted/foreign resources retain the ordinary 404. */
async function ownedRun(db: Pool | PoolClient, input: Scope) {
  const run = (await db.query(`SELECT r.* FROM bb_runs r JOIN bb_projects p
    ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id JOIN bb_users u ON u.id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.id=$2 AND p.deleted_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'`,
  [input.owner,input.runId])).rows[0];
  if (!run) throw missing();
  return run;
}
async function ownedProductionRun(db: Pool | PoolClient, input: Scope) {
  const run = await ownedRun(db,input);
  if (run.channel !== 'production') throw unavailable();
  return run;
}
function receipt(row: any): RunSupplementAdoptionResponse {
  if (!row || row.source_execution_version !== 1 || row.input_hash?.trim() !== row.candidate_input_hash?.trim()
    || row.assignment_kind === 'carry' && (!row.source_billing_segment_id || row.target_billing_segment_id !== row.source_billing_segment_id)
    || row.assignment_kind === 'unbilled' && (row.source_billing_segment_id || row.target_billing_segment_id)
    || row.assignment_kind === 'rework' && (!row.target_billing_segment_id || row.target_billing_segment_id === row.source_billing_segment_id)
    || inputManifestHash({ version:'run-supplement-adoption-v1',owner:row.owner_user_id,runId:row.run_id,
      request:{request_id:row.request_id,quote_id:row.quote_id,confirmation_id:row.confirmation_id,quote_hash:row.quote_hash?.trim()} })
      !== row.request_hash?.trim()) throw unavailable();
  const result = { adoption: { adoption_id:row.id,request_id:row.request_id,project_id:row.project_id,
    run_id:row.run_id,job_id:row.job_id,execution_version:row.execution_version,input_revision:row.input_revision,
    input_hash:row.input_hash.trim(),quote_id:row.quote_id,confirmation_id:row.confirmation_id,
    quote_hash:row.quote_hash.trim(),additional_points:Number(row.total_points),assignment_kind:row.assignment_kind,
    billing_segment_id:row.target_billing_segment_id,reservation_id:row.target_billing_segment_id,
    adopted_at:date(row.created_at) } };
  if (!Value.Check(RunSupplementAdoptionResponseSchema,result)) throw unavailable();
  return result as RunSupplementAdoptionResponse;
}
function requestHash(input: AdoptRunSupplementInput) {
  return inputManifestHash({ version:'run-supplement-adoption-v1',owner:input.owner,runId:input.runId,request:input.request });
}
async function replay(db: Pool | PoolClient, input: AdoptRunSupplementInput, hash: string) {
  const row = (await db.query(`SELECT * FROM bb_run_supplement_adoptions
    WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`, [input.owner,input.runId,input.request.request_id])).rows[0];
  if (!row) return null;
  if (row.request_hash.trim() !== hash || row.quote_id !== input.request.quote_id
    || row.confirmation_id !== input.request.confirmation_id || row.quote_hash.trim() !== input.request.quote_hash) throw conflict();
  return receipt(row);
}
async function lockScope(db: PoolClient, input: AdoptRunSupplementInput, projectId: string) {
  // State freshness belongs after receipt replay. These locks also serialize an
  // identical concurrent request whose first transaction just committed.
  const project = (await db.query(`SELECT p.id FROM bb_projects p JOIN bb_users u ON u.id=p.owner_user_id
    WHERE p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL
      AND u.closed_at IS NULL AND u.status<>'closed' FOR UPDATE OF p`, [input.owner,projectId])).rows[0];
  const run = (await db.query(`SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [input.owner,projectId,input.runId])).rows[0];
  const job = (await db.query(`SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.owner,input.runId])).rows[0];
  if (!project || !run || !job) throw missing();
  if (run.channel !== 'production' || job.channel !== 'production' || run.test_grant_id || job.test_grant_id) throw unavailable();
  return {run,job};
}
function manifestMaterials(manifest: Record<string, any>) {
  if (manifest.version === 'm4-document-input-v1') {
    const pins = [...manifest.input.materials,...(manifest.input.source_material ? [manifest.input.source_material] : []),
      ...(manifest.template_material ? [manifest.template_material] : [])];
    return [...new Map(pins.map(pin => [inputManifestHash(pin),pin])).values()];
  }
  return manifest.materials;
}

/** A confirmed quote is consumed only here: byte-verified preparation, exact
 * fee assignment and the new execution become durable in the same commit.
 * Neither quote creation nor confirmation is execution/debit authority. */
async function adopt(input: AdoptRunSupplementInput): Promise<RunSupplementAdoptionResponse> {
  if (!Value.Check(RunSupplementAdoptRequestSchema,input.request)) throw new Problem(422,'VALIDATION_FAILED','补料采用请求无效。');
  const original = await ownedProductionRun(input.pool,input), hash = requestHash(input);
  const previous = await replay(input.pool,input,hash);
  if (previous) return previous;
  const quoteInput = { ...input,quoteId:input.request.quote_id,confirmationId:input.request.confirmation_id,quoteHash:input.request.quote_hash };
  // Independent Blob reads and purge checks finish before scope/account locks.
  let prepared: Awaited<ReturnType<typeof readConfirmedRunSupplementQuoteForAdoption>>;
  try { prepared = await readConfirmedRunSupplementQuoteForAdoption(quoteInput); }
  catch (error) {
    // Another exact request can commit while this caller is doing independent
    // preparation reads. A resulting stale-basis error is then a lost response.
    const committed = await replay(input.pool,input,hash);
    if (committed) return committed;
    throw error;
  }
  if (prepared.quote.project_id !== original.project_id) throw unavailable();
  return transaction(input.pool,async db => {
    const {run,job} = await lockScope(db,input,original.project_id);
    const existing = await replay(db,input,hash);
    if (existing) return existing;
    const {quote} = await recheckConfirmedRunSupplementQuoteForAdoption(db,quoteInput,prepared);
    const basis = prepared.basis, source = basis.sourceExecution;
    if (source.executionVersion !== 1 || source.inputRevision !== run.input_revision || source.inputHash !== run.input_hash.trim()) throw unavailable();
    const sourceFee = await readRunBillingSegment(db,run,source);
    const originInput = (await db.query(`SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2
      AND revision=$3 AND input_hash=$4`, [input.owner,run.project_id,source.inputRevision,source.inputHash])).rows[0];
    if (!originInput) throw unavailable();
    const candidates = (await db.query(`SELECT revision,manifest FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND input_hash=$3 ORDER BY revision`,
    [input.owner,run.project_id,basis.candidateInputHash])).rows;
    let revision = candidates.find(row => same(row.manifest,basis.manifest))?.revision;
    if (!revision) {
      revision = (await db.query(`SELECT COALESCE(max(revision),0)+1 AS revision FROM bb_input_revisions
        WHERE owner_user_id=$1 AND project_id=$2`, [input.owner,run.project_id])).rows[0].revision;
      await db.query(`INSERT INTO bb_input_revisions(owner_user_id,project_id,revision,draft_revision,input_hash,manifest,
        material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.owner,run.project_id,revision,originInput.draft_revision,basis.candidateInputHash,basis.manifest,
        JSON.stringify(manifestMaterials(basis.manifest)),JSON.stringify(originInput.requirement_message_ids),
        originInput.rule_pack_version,originInput.template_version,originInput.reference_release]);
    }
    const target = {executionVersion:2,inputRevision:revision,inputHash:basis.candidateInputHash};
    await db.query('SELECT bb_assert_material_lifecycle_available($1,$2,$3)', [input.owner,run.project_id,revision]);
    const points = Number(quote.total_points), assignment = points > 0 ? 'rework' : sourceFee ? 'carry' : 'unbilled';
    const targetFeeId = points > 0 ? uid() : sourceFee?.id ?? null;
    const adopted = (await db.query(`INSERT INTO bb_run_supplement_adoptions
      (id,owner_user_id,project_id,run_id,job_id,kind,source_execution_version,source_input_revision,source_input_hash,
       execution_version,input_revision,input_hash,supplement_revision,receipt_request_id,receipt_request_hash,
       processing_plan_id,processing_plan_hash,checkpoint_hash,basis_hash,candidate_input_hash,
       quote_id,quote_hash,confirmation_id,total_points,assignment_kind,source_billing_segment_id,target_billing_segment_id,request_id,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING *`,
    [uid(),input.owner,run.project_id,run.id,job.id,basis.kind,source.executionVersion,source.inputRevision,source.inputHash,
      revision,basis.candidateInputHash,basis.revision,basis.requestId,basis.requestHash,prepared.plan.id,prepared.plan.planHash,
      basis.checkpointHash,basis.basisHash,basis.candidateInputHash,quote.id,quote.quote_hash.trim(),input.request.confirmation_id,
      points,assignment,sourceFee?.id ?? null,targetFeeId,input.request.request_id,hash])).rows[0];
    await db.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,created_at)
      VALUES($1,$2,$3,2,$4,$5,(SELECT created_at FROM bb_run_supplement_adoptions WHERE id=$6))`,
    [input.owner,run.project_id,run.id,revision,basis.candidateInputHash,adopted.id]);
    const manifest = basis.manifest;
    if (manifest.review) {
      const review = manifest.review;
      await db.query(`INSERT INTO bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,
        input_hash,version,operation,source_report_id,snapshot,created_at)
        VALUES($1,$2,$3,2,$4,$5,$6,$7,$8,$9,(SELECT created_at FROM bb_run_supplement_adoptions WHERE id=$10))`,
      [input.owner,run.project_id,run.id,revision,basis.candidateInputHash,review.version_number,review.operation,
        review.source_report_id,basis.reviewSnapshot,adopted.id]);
    } else if (manifest.version === 'm4-document-input-v1') {
      await db.query(`INSERT INTO bb_m4_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,
        input_hash,topic_id,manifest,created_at)
        VALUES($1,$2,$3,2,$4,$5,$6,$7,(SELECT created_at FROM bb_run_supplement_adoptions WHERE id=$8))`,
      [input.owner,run.project_id,run.id,revision,basis.candidateInputHash,manifest.topic_id,manifest,adopted.id]);
    }
    // This SQL function owns source closure, funds checks, the independently
    // capped new fee or explicit carry, and the exact execution assignment.
    await db.query('SELECT bb_adopt_run_supplement_billing($1)', [adopted.id]);
    const moved = await db.query(`UPDATE bb_run_execution_heads SET execution_version=2,input_revision=$4,input_hash=$5,
      activated_at=(SELECT created_at FROM bb_run_supplement_adoptions WHERE id=$6)
      WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$7 AND input_revision=$8 AND input_hash=$9`,
    [input.owner,run.project_id,run.id,revision,basis.candidateInputHash,adopted.id,source.executionVersion,source.inputRevision,source.inputHash]);
    if (moved.rowCount !== 1) throw unavailable();
    const checkpoint = { ...(Object.hasOwn(job.checkpoint,'provider_results') ? {provider_results:job.checkpoint.provider_results} : {}),
      ...(Object.hasOwn(job.checkpoint,'operator_reconciliations') ? {operator_reconciliations:job.checkpoint.operator_reconciliations} : {}),
      stage_execution:{execution_version:2,input_revision:revision,input_hash:basis.candidateInputHash},stages:{} };
    await db.query(`UPDATE bb_jobs SET state='queued',stage='queued',checkpoint=$2,user_pause_requested=false,
      credit_pause_requested=false,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id,checkpoint]);
    const seq = run.event_cursor + 1, eventId = uid(), payload = {reason:'supplement_adopted',adoption_id:adopted.id,
      quote_id:quote.id,confirmation_id:input.request.confirmation_id,processing_plan_id:prepared.plan.id,
      execution_version:2,input_revision:revision,input_hash:basis.candidateInputHash,additional_points:points,
      assignment_kind:assignment,channel:'production'};
    await db.query(`UPDATE bb_runs SET state='queued',stage='queued',event_cursor=$2,updated_at=now() WHERE id=$1`, [run.id,seq]);
    await db.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
      VALUES($1,$2,$3,$4,$3,'run.state_changed','queued','queued',$5)`, [eventId,input.owner,run.id,seq,payload]);
    await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run',$3,'run.state_changed',$4)`, [uid(),input.owner,run.id,{run_id:run.id,event_id:eventId,seq,state:'queued',stage:'queued',...payload}]);
    await assertRunExecution(db,run,target);
    return receipt(adopted);
  });
}
async function adoptionBoundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const sql = error as {code?:string;constraint?:string};
    if (sql.code === '23514' && sql.constraint === 'bb_supplement_adoption_insufficient_credits')
      throw new Problem(402,'CREDITS_INSUFFICIENT','可用积分不足，请充值后使用同一补料请求继续；材料与报价确认已保留。');
    if (sql.code === '23505' && sql.constraint?.includes('supplement_adoption')) throw conflict();
    if (sql.code === '23514' && sql.constraint?.startsWith('bb_supplement_quote'))
      throw new Problem(409,'QUOTE_CHANGED','补料、已保存工作或价格已变化，请重新核对追加费用。');
    if (['55P03','40001','40P01'].includes(sql.code ?? '') || sql.code === '23514'
      && (sql.constraint?.includes('supplement_adoption') || sql.constraint?.includes('production_successor'))) throw unavailable();
    throw error;
  }
}
export async function adoptRunSupplement(input: AdoptRunSupplementInput): Promise<RunSupplementAdoptionResponse> {
  return adoptionBoundary(() => adopt(input));
}
export async function readRunSupplementAdoption(input: Scope & {requestId: string}): Promise<RunSupplementAdoptionResponse> {
  if (!key(input.requestId)) throw new Problem(422,'VALIDATION_FAILED','补料采用请求标识无效。');
  await ownedProductionRun(input.pool,input);
  const row = (await input.pool.query(`SELECT * FROM bb_run_supplement_adoptions
    WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`, [input.owner,input.runId,input.requestId])).rows[0];
  if (!row) throw missing();
  return receipt(row);
}
/** Recover the current execution's immutable adoption on a fresh browser, where
 * no local request journal exists. This grants no new execution or charge. */
export async function readCurrentRunSupplementAdoption(input: Scope): Promise<RunSupplementAdoptionResponse> {
  return transaction(input.pool,async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const run = await ownedRun(db,input);
    // Internal test runs have their separate authority. A common desktop read
    // must not turn a valid unadopted/internal run into an unknown blocker.
    if (run.channel !== 'production') throw missing();
    const current = await assertRunExecution(db,run);
    if (current.executionVersion === 1) throw missing();
    const row = (await db.query(`SELECT a.* FROM bb_run_execution_heads h
      JOIN bb_run_supplement_adoptions a ON a.owner_user_id=h.owner_user_id AND a.project_id=h.project_id
        AND a.run_id=h.run_id AND a.execution_version=h.execution_version AND a.input_revision=h.input_revision
        AND a.input_hash=h.input_hash AND a.created_at=h.activated_at
      WHERE h.owner_user_id=$1 AND h.project_id=$2 AND h.run_id=$3 AND h.execution_version=$4
        AND h.input_revision=$5 AND h.input_hash=$6`,
    [input.owner,run.project_id,input.runId,current.executionVersion,current.inputRevision,current.inputHash])).rows[0];
    if (!row) throw unavailable();
    return receipt(row);
  });
}
export function registerRunSupplementAdoptionRoutes(app: FastifyInstance, pool: () => Pool, blobs: () => PrivateBlobs,
  owner: (request: FastifyRequest) => Promise<string>) {
  app.post('/api/v1/runs/:run_id/supplement-adoptions', {schema:{body:RunSupplementAdoptRequestSchema,response:{200:RunSupplementAdoptionResponseSchema}}}, async request =>
    adoptRunSupplement({pool:pool(),blobs:blobs(),owner:await owner(request),runId:(request.params as {run_id:string}).run_id,
      request:request.body as RunSupplementAdoptRequest}));
  app.get('/api/v1/runs/:run_id/supplement-adoptions', {schema:{querystring:RunSupplementAdoptionQuerySchema,response:{200:RunSupplementAdoptionResponseSchema}}}, async request =>
    readRunSupplementAdoption({pool:pool(),owner:await owner(request),runId:(request.params as {run_id:string}).run_id,
      requestId:(request.query as {request_id:string}).request_id}));
  app.get('/api/v1/runs/:run_id/supplement-adoptions/current', {schema:{response:{200:RunSupplementAdoptionResponseSchema}}}, async request =>
    readCurrentRunSupplementAdoption({pool:pool(),owner:await owner(request),runId:(request.params as {run_id:string}).run_id}));
}
