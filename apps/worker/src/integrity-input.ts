import type { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  IntegrityInputSchema,
  INTEGRITY_PRICE,
  integrityPricingScope,
  integrityLockedScopeValid,
  isOutcomePriceVersion,
  isAutomaticPriceVersion,
  type IntegrityInput,
} from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readProjectFileAsset } from '@bondbuddy/api/project-file-storage';
import type { InputRevisionRow, RunRow, StageOutcome, StageContext } from './run-pipeline.js';

export const isIntegrityInput = (v: unknown): v is IntegrityInput =>
  Value.Check(IntegrityInputSchema, v);
/** Execute the accepted quote, including historical prices; never reprice queued or resumed work. */
export async function integrityPriceValid(
  pool: Pool,
  run: RunRow,
  m: IntegrityInput,
): Promise<boolean> {
  const q = (
    await pool.query(
      `SELECT q.*,c.state reservation_state,c.points reservation_points,c.billing_policy,c.quote_id reservation_quote_id
  FROM bb_integrity_quotes q JOIN bb_runs r ON r.owner_user_id=q.owner_user_id AND r.id=q.run_id
  JOIN bb_credit_reservations c ON c.owner_user_id=r.owner_user_id AND c.run_id=r.id AND c.id=r.reservation_id
  WHERE q.owner_user_id=$1 AND q.run_id=$2 AND r.project_id=$3 AND q.input_hash=$4`,
      [run.owner_user_id, run.id, run.project_id, run.input_hash],
    )
  ).rows[0];
  if (
    !q ||
    !Number.isSafeInteger(m.points) ||
    m.points <= 0 ||
    Number(q.points) !== m.points ||
    q.price_version !== m.price_version ||
    q.reservation_state !== 'held' ||
    q.reservation_quote_id !== q.id ||
    Number(q.reservation_points) !== m.points ||
    q.billing_policy !== 'on_delivery'
  )
    return false;
  if (!isOutcomePriceVersion(m.price_version))
    return (
      m.price_version === INTEGRITY_PRICE.version &&
      m.points === INTEGRITY_PRICE.points &&
      !m.pricing_mode &&
      !m.scope_quote_id &&
      q.scope_quote_id === null
    );
  if (
    m.pricing_mode !== 'outcome_cny_v1' ||
    m.currency !== 'CNY' ||
    m.amount_fen !== m.points ||
    m.quote_status !== 'ready' ||
    inputManifestHash(q.scope_lines) !== inputManifestHash(m.scope_lines)
  )
    return false;
  if (m.scope_round_id && m.scope_round_id !== m.round_id) return false;
  if (m.scope_measurement && !integrityLockedScopeValid(m.draft, m.scope_measurement)) return false;
  const scopeHash = inputManifestHash(
    integrityPricingScope(
      m.draft,
      m.scope_round_id,
      m.scope_round_id ? m.scope_measurement : undefined,
    ),
  );
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
   AND s.action='integrity_round' AND s.input_hash=$4 AND s.price_version=$5`,
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
  // Reviewed historical quotes predate coverage plans; newer contractual work must be bound to this run.
  return scope.work_plan !== null ? scope.commerce_bound : true;
}
export async function integrityInputGate(
  pool: Pool,
  run: RunRow,
  input: InputRevisionRow,
): Promise<Extract<StageOutcome, { kind: 'fail' }> | null> {
  const fail = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' } as const,
    m = input.manifest;
  if (
    !isIntegrityInput(m) ||
    run.task_kind !== 'generation' ||
    inputManifestHash(m) !== run.input_hash.trim() ||
    input.input_hash.trim() !== run.input_hash.trim()
  )
    return fail;
  const stored = (
    await pool.query(
      `SELECT i.*,j.subtype FROM bb_integrity_runs i JOIN bb_jobs j ON j.owner_user_id=i.owner_user_id AND j.run_id=i.run_id
 WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.run_id=$3`,
      [run.owner_user_id, run.project_id, run.id],
    )
  ).rows[0];
  if (
    !stored ||
    stored.input_hash.trim() !== run.input_hash.trim() ||
    inputManifestHash(stored.manifest) !== run.input_hash.trim() ||
    stored.subtype !== 'integrity_v1' ||
    stored.round_id !== m.round_id ||
    stored.operation !== m.operation
  )
    return fail;
  if (m.operation === 'check') {
    if (
      m.round_id !== run.id ||
      m.records.length ||
      m.evidence_ids.length ||
      !(await integrityPriceValid(pool, run, m))
    )
      return fail;
  } else {
    if (m.points !== 0 || new Set(m.evidence_ids).size !== m.evidence_ids.length) return fail;
    const parent = (
      await pool.query(
        `SELECT * FROM bb_integrity_runs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND operation='check'`,
        [run.owner_user_id, run.project_id, m.round_id],
      )
    ).rows[0];
    if (
      !parent?.result ||
      inputManifestHash(parent.result) !== parent.result_hash.trim() ||
      inputManifestHash(parent.result.records) !== inputManifestHash(m.records) ||
      inputManifestHash(parent.manifest.draft) !== inputManifestHash(m.draft) ||
      parent.manifest.project_name !== m.project_name
    )
      return fail;
    const evidence = (
      await pool.query(
        'SELECT * FROM bb_integrity_evidence WHERE owner_user_id=$1 AND project_id=$2 AND round_id=$3 AND id=ANY($4::text[])',
        [run.owner_user_id, run.project_id, m.round_id, m.evidence_ids],
      )
    ).rows;
    if (evidence.length !== m.evidence_ids.length) return fail;
    try {
      for (const e of evidence) {
        if (
          inputManifestHash({ id: run.project_id, run_id: m.round_id, ...e.record }) !==
            e.request_hash.trim() ||
          e.record.material.source_project_id !== run.project_id
        )
          return fail;
        await readProjectFileAsset(pool, run.owner_user_id, {
          kind: 'material',
          pin: e.record.material,
        });
      }
    } catch {
      return fail;
    }
  }
  return null;
}
export async function loadIntegrityInput(ctx: StageContext) {
  const input = (
    await ctx.pool.query(
      'SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision],
    )
  ).rows[0];
  if (!input || (await integrityInputGate(ctx.pool, ctx.run, input)))
    throw Error('INPUT_REVISION_CONFLICT');
  return input.manifest as IntegrityInput;
}
