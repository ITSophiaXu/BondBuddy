import type { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  QaInputSchema,
  qaProspectusIssue,
  PROJECT_QA_PRICE,
  isOutcomePriceVersion,
  isAutomaticPriceVersion,
  type QaInput,
} from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readProjectFileAsset } from '@bondbuddy/api/project-file-storage';
import {
  validateQaQuestions,
  validateIncludedQaFollowup,
  qaAnswerScope,
} from '@bondbuddy/api/project-qa';
import type { RunRow, InputRevisionRow, StageContext, StageOutcome } from './run-pipeline.js';
export const isProjectQaInput = (v: unknown): v is QaInput => Value.Check(QaInputSchema, v);
/** Execute the accepted quote, without repricing a queued/resumed task against today's tariff or expiry. */
export async function projectQaPriceValid(pool: Pool, run: RunRow, m: QaInput): Promise<boolean> {
  const commercial = isOutcomePriceVersion(m.price_version);
  const q = (
    await pool.query(
      `SELECT q.*,r.reservation_id,c.state reservation_state,c.points reservation_points,c.billing_policy,
   c.quote_id reservation_quote_id
  FROM bb_project_qa_quotes q JOIN bb_runs r ON r.owner_user_id=q.owner_user_id AND r.id=q.run_id
  LEFT JOIN bb_credit_reservations c ON c.owner_user_id=r.owner_user_id AND c.run_id=r.id AND c.id=r.reservation_id
  WHERE q.owner_user_id=$1 AND q.run_id=$2 AND r.project_id=$3 AND q.input_hash=$4`,
      [run.owner_user_id, run.id, run.project_id, run.input_hash],
    )
  ).rows[0];
  if (
    !q ||
    Number(q.points) !== m.points ||
    q.price_version !== m.price_version ||
    q.question_count !== m.questions.length ||
    q.unit_points !== (commercial ? 0 : PROJECT_QA_PRICE.points)
  )
    return false;
  if (m.points > 0) {
    if (
      q.reservation_state !== 'held' ||
      q.reservation_quote_id !== q.id ||
      Number(q.reservation_points) !== m.points ||
      q.billing_policy !== 'on_delivery'
    )
      return false;
  } else if (q.reservation_id !== null) return false;
  if (!commercial)
    return (
      m.price_version === PROJECT_QA_PRICE.version &&
      m.points === m.questions.length * PROJECT_QA_PRICE.points &&
      !m.included_followup_of &&
      !m.scope_quote_id &&
      q.scope_quote_id === null
    );
  if (
    m.pricing_mode !== 'outcome_cny_v1' ||
    m.amount_fen !== m.points ||
    m.quote_status !== 'ready' ||
    inputManifestHash(q.scope_lines) !== inputManifestHash(m.scope_lines)
  )
    return false;
  if (m.included_followup_of) {
    if (m.points !== 0 || m.scope_quote_id || q.scope_quote_id !== null) return false;
    return (
      (await validateIncludedQaFollowup(
        pool,
        run.owner_user_id,
        run.project_id,
        m.included_followup_of,
        m.questions,
        m.requirements,
        m.source,
      )) === m.price_version
    );
  }
  const scopeHash = inputManifestHash(qaAnswerScope(m));
  if (
    !m.scope_quote_id ||
    q.scope_quote_id !== m.scope_quote_id ||
    q.scope_work_hash?.trim() !== scopeHash
  )
    return false;
  const scope = (
    await pool.query(
      `SELECT s.*,
   EXISTS(SELECT 1 FROM bb_automatic_scope_runs b WHERE b.owner_user_id=s.owner_user_id AND b.scope_quote_id=s.id AND b.run_id=$6) automatic_bound,
   EXISTS(SELECT 1 FROM bb_commerce_scope_runs b WHERE b.owner_user_id=s.owner_user_id AND b.scope_quote_id=s.id AND b.run_id=$6
     AND b.plan=s.work_plan AND b.pricing_items=s.pricing_items) commerce_bound
  FROM bb_scope_quotations s WHERE s.id=$1 AND s.owner_user_id=$2 AND s.project_id=$3
   AND s.action='project_qa_answer' AND s.input_hash=$4 AND s.price_version=$5`,
      [m.scope_quote_id, run.owner_user_id, run.project_id, scopeHash, m.price_version, run.id],
    )
  ).rows[0];
  if (
    !scope ||
    !scope.published_at ||
    Number(scope.amount_fen) !== m.points ||
    inputManifestHash(scope.snapshot) !== scopeHash ||
    inputManifestHash(scope.lines) !== inputManifestHash(m.scope_lines)
  )
    return false;
  if (isAutomaticPriceVersion(m.price_version)) return scope.automatic_bound;
  // Reviewed historical quotes have no coverage plan. Zero-price work always needs a bound entitlement.
  return scope.work_plan !== null || m.points === 0 ? scope.commerce_bound : true;
}
export async function projectQaInputGate(
  pool: Pool,
  run: RunRow,
  input: InputRevisionRow,
): Promise<Extract<StageOutcome, { kind: 'fail' }> | null> {
  const fail = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' } as const,
    m = input.manifest;
  if (
    !isProjectQaInput(m) ||
    run.task_kind !== 'generation' ||
    inputManifestHash(m) !== run.input_hash.trim() ||
    input.input_hash.trim() !== run.input_hash.trim()
  )
    return fail;
  const row = (
    await pool.query(
      'SELECT q.*,j.subtype FROM bb_project_qa_runs q JOIN bb_jobs j ON j.owner_user_id=q.owner_user_id AND j.run_id=q.run_id WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id=$3',
      [run.owner_user_id, run.project_id, run.id],
    )
  ).rows[0];
  if (
    !row ||
    row.subtype !== 'project_qa_v1' ||
    row.input_hash.trim() !== run.input_hash.trim() ||
    inputManifestHash(row.manifest) !== run.input_hash.trim()
  )
    return fail;
  try {
    await readProjectFileAsset(pool, run.owner_user_id, m.source.asset);
    for (const material of m.materials)
      await readProjectFileAsset(pool, run.owner_user_id, material.asset);
    if (m.operation === 'prepare') {
      if (
        m.points !== 0 ||
        m.questions.length ||
        m.materials.length ||
        m.cases.length ||
        m.preparation_id
      )
        return fail;
    } else {
      if (
        m.prospectus &&
        qaProspectusIssue(
          m.prospectus,
          m.materials.map((x) => x.asset),
          m.source.asset,
        )
      )
        return fail;
      if (!m.questions.length) return fail;
      const parent = (
        await pool.query(
          "SELECT q.* FROM bb_project_qa_runs q JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id=$3 AND q.operation='prepare' AND r.state='succeeded'",
          [run.owner_user_id, run.project_id, m.preparation_id],
        )
      ).rows[0];
      if (
        !parent?.result ||
        inputManifestHash(parent.result) !== parent.result_hash.trim() ||
        inputManifestHash(parent.manifest.source) !== inputManifestHash(m.source)
      )
        return fail;
      validateQaQuestions(m.questions, parent.result);
      if (!(await projectQaPriceValid(pool, run, m))) return fail;
      if (m.cases.some((c) => c.status !== 'approved' || inputManifestHash(c.content) !== c.sha256))
        return fail;
    }
  } catch {
    return fail;
  }
  return null;
}
export async function loadProjectQaInput(ctx: StageContext) {
  const input = (
    await ctx.pool.query(
      'SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision],
    )
  ).rows[0];
  if (!input || (await projectQaInputGate(ctx.pool, ctx.run, input)))
    throw Error('INPUT_REVISION_CONFLICT');
  return input.manifest as QaInput;
}
