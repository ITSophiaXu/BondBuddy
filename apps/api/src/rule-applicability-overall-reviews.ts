import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isMarketOffering, RULE_APPLICABILITY_FEATURE_DIMENSIONS, type Market, type Offering } from '@bondbuddy/contracts';
import { authorizeRuleApplicabilityReviewer, type RuleApplicabilityReviewerPrincipal,
  type RuleApplicabilityReviewerScope } from './rule-applicability-reviewer-grants.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export type RuleApplicabilityFeatureDimension = typeof RULE_APPLICABILITY_FEATURE_DIMENSIONS[number];
export type RuleApplicabilityEvidenceRef = {
  materialId: string; materialVersion: number; materialSha256: string;
  parseSnapshotId: string; recordId: string; recordSha256: string;
};
export type RuleApplicabilityApprovedValues = {
  market: Market; offering: Offering; instrument: string; documentStage: 'registration' | 'issuance';
  issuerScope: string; investorScope: string; industry: string; specialFeatures: readonly string[]; asOf: string;
};
export type RuleApplicabilityFeatureEvidence = {
  dimension: RuleApplicabilityFeatureDimension; outcome: 'present' | 'absent' | 'not_applicable';
  featureCode?: string; reason: string; evidenceRefs: readonly RuleApplicabilityEvidenceRef[];
};
export type AppendRuleApplicabilityOverallReviewInput = {
  principal: RuleApplicabilityReviewerPrincipal; scope: RuleApplicabilityReviewerScope;
  target: { contextId: string; contextVersion: number; contextContentHash: string; sourceInputRevision: number; sourceInputHash: string };
  requestId: string; action: 'approve' | 'request_more_evidence' | 'withdraw'; reason: string;
  approvedValues?: RuleApplicabilityApprovedValues;
  valueEvidence?: Readonly<Record<string, readonly RuleApplicabilityEvidenceRef[]>>;
  featureEvidence?: readonly RuleApplicabilityFeatureEvidence[];
  taxonomyVersion?: string;
};
export type RuleApplicabilityOverallReviewRecord = {
  id: string; sequence: number; requestId: string; ownerUserId: string; projectId: string;
  contextId: string; contextVersion: number; contextContentHash: string;
  sourceInputRevision: number; sourceInputHash: string; action: 'approve' | 'request_more_evidence' | 'withdraw';
  reason: string; approvedValues: RuleApplicabilityApprovedValues | null;
  valueEvidence: Readonly<Record<string, readonly RuleApplicabilityEvidenceRef[]>>;
  featureEvidence: readonly RuleApplicabilityFeatureEvidence[]; taxonomyVersion: string | null;
  reviewerUserId: string; reviewerGrantId: string; reviewedAt: string; replayed: boolean;
};
type Queryable = Pick<Pool | PoolClient, 'query'>;
type Db = Pick<Pool, 'connect'>;
type Row = Record<string, unknown>;
function fail(code: string): Error { const e = new Error(code); e.name = 'RuleApplicabilityOverallReviewError'; return e; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  const out = JSON.stringify(value); if (out === undefined) throw fail('OVERALL_REVIEW_INVALID_JSON'); return out;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function parse(value: unknown): unknown { return value; }
function validDate(value: unknown): value is string {
  return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validateEvidence(ref: RuleApplicabilityEvidenceRef): void {
  if (!ref || ![ref.materialId, ref.parseSnapshotId, ref.recordId].every(v => typeof v === 'string' && ID.test(v)) ||
      !Number.isSafeInteger(ref.materialVersion) || ref.materialVersion < 1 || !SHA.test(ref.materialSha256) || !SHA.test(ref.recordSha256))
    throw fail('OVERALL_REVIEW_EVIDENCE_REFERENCE_INVALID');
}
function validate(input: AppendRuleApplicabilityOverallReviewInput): void {
  if (!input || !input.principal || !ID.test(input.principal.userId) || !input.scope || !ID.test(input.scope.ownerUserId) ||
      !ID.test(input.scope.projectId) || input.principal.userId === input.scope.ownerUserId || !input.target ||
      !ID.test(input.target.contextId) || !Number.isSafeInteger(input.target.contextVersion) || input.target.contextVersion < 1 ||
      !SHA.test(input.target.contextContentHash) || !Number.isSafeInteger(input.target.sourceInputRevision) || input.target.sourceInputRevision < 1 ||
      !SHA.test(input.target.sourceInputHash) || !ID.test(input.requestId) || !['approve', 'request_more_evidence', 'withdraw'].includes(input.action) ||
      typeof input.reason !== 'string' || input.reason.trim().length < 1 || input.reason.trim().length > 2048) throw fail('OVERALL_REVIEW_INVALID_REQUEST');
  if (input.action !== 'approve') {
    if (input.approvedValues !== undefined || input.valueEvidence !== undefined || input.featureEvidence !== undefined || input.taxonomyVersion !== undefined)
      throw fail('OVERALL_REVIEW_NON_APPROVAL_HAS_DECISION_DATA');
    return;
  }
  const value = input.approvedValues;
  const evidence = input.valueEvidence;
  const features = input.featureEvidence;
  if (!value || !isMarketOffering(value.market, value.offering) || typeof value.instrument !== 'string' || !value.instrument.trim() ||
      !['registration', 'issuance'].includes(value.documentStage) || !['domestic-company', 'other'].includes(value.issuerScope) ||
      !['professional', 'other'].includes(value.investorScope) || typeof value.industry !== 'string' || !value.industry.trim() ||
      !Array.isArray(value.specialFeatures) || value.specialFeatures.length > 32 ||
      value.specialFeatures.some(v => typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(v)) ||
      new Set(value.specialFeatures).size !== value.specialFeatures.length || !validDate(value.asOf) ||
      !evidence || !isRecord(evidence) || !features || !Array.isArray(features) ||
      typeof input.taxonomyVersion !== 'string' || !/^bondbuddy-applicability-[a-z0-9.-]{1,64}$/.test(input.taxonomyVersion))
    throw fail('OVERALL_REVIEW_APPROVED_VALUES_INVALID');
  const requiredEvidenceFields = ['instrument', 'issuerScope', 'investorScope', 'industry'];
  for (const key of requiredEvidenceFields) {
    const refs = evidence[key]; if (!Array.isArray(refs) || refs.length === 0) throw fail(`OVERALL_REVIEW_FIELD_EVIDENCE_REQUIRED:${key}`);
    refs.forEach(validateEvidence);
  }
  const keys = features.map(item => item?.dimension);
  if (keys.length !== RULE_APPLICABILITY_FEATURE_DIMENSIONS.length || new Set(keys).size !== keys.length ||
      RULE_APPLICABILITY_FEATURE_DIMENSIONS.some(key => !keys.includes(key))) throw fail('OVERALL_REVIEW_FEATURE_DIMENSIONS_INCOMPLETE');
  const positive: string[] = [];
  for (const item of features) {
    if (!['present', 'absent', 'not_applicable'].includes(item.outcome) || typeof item.reason !== 'string' ||
        item.reason.trim().length < 1 || item.reason.trim().length > 1024 || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)
      throw fail(`OVERALL_REVIEW_FEATURE_EVIDENCE_REQUIRED:${item.dimension}`);
    item.evidenceRefs.forEach(validateEvidence);
    if (item.outcome === 'present') {
      if (!item.featureCode || !/^[a-z][a-z0-9_]{0,63}$/.test(item.featureCode)) throw fail('OVERALL_REVIEW_FEATURE_CODE_REQUIRED');
      positive.push(item.featureCode);
    } else if (item.featureCode !== undefined) throw fail('OVERALL_REVIEW_NEGATIVE_FEATURE_HAS_CODE');
  }
  if (canonical([...positive].sort()) !== canonical([...value.specialFeatures].sort())) throw fail('OVERALL_REVIEW_SPECIAL_FEATURES_MISMATCH');
}
function map(row: Row, replayed: boolean): RuleApplicabilityOverallReviewRecord {
  return { id: String(row.id), sequence: Number(row.sequence_id), requestId: String(row.request_id), ownerUserId: String(row.owner_user_id),
    projectId: String(row.project_id), contextId: String(row.context_id), contextVersion: Number(row.context_version),
    contextContentHash: String(row.context_content_hash).trim(), sourceInputRevision: Number(row.source_input_revision),
    sourceInputHash: String(row.source_input_hash).trim(), action: String(row.action) as RuleApplicabilityOverallReviewRecord['action'],
    reason: String(row.reason), approvedValues: parse(row.applicability_values) as RuleApplicabilityApprovedValues | null,
    valueEvidence: parse(row.value_evidence) as Record<string, readonly RuleApplicabilityEvidenceRef[]>,
    featureEvidence: parse(row.feature_evidence) as RuleApplicabilityFeatureEvidence[],
    taxonomyVersion: row.taxonomy_version === null ? null : String(row.taxonomy_version), reviewerUserId: String(row.reviewer_user_id),
    reviewerGrantId: String(row.reviewer_grant_id), reviewedAt: new Date(String(row.reviewed_at)).toISOString(), replayed };
}
function replayHash(input: AppendRuleApplicabilityOverallReviewInput, reviewerUserId: string, reviewerGrantId: string): string {
  return hash({ ownerUserId: input.scope.ownerUserId, projectId: input.scope.projectId, target: input.target, requestId: input.requestId,
    action: input.action, reason: input.reason.trim(), approvedValues: input.approvedValues ?? null, valueEvidence: input.valueEvidence ?? {},
    featureEvidence: input.featureEvidence ?? [], taxonomyVersion: input.taxonomyVersion ?? null, reviewerUserId, reviewerGrantId });
}
async function validateEvidenceAgainstInput(client: Queryable, owner: string, project: string, inputRevision: number,
  inputHash: string, refs: readonly RuleApplicabilityEvidenceRef[]): Promise<void> {
  const revision = (await client.query(`SELECT input_hash,material_versions,manifest FROM bb_input_revisions
    WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 FOR SHARE`, [owner, project, inputRevision])).rows[0];
  if (!revision || String(revision.input_hash).trim() !== inputHash || !isRecord(revision.manifest) ||
      !Array.isArray(revision.material_versions) || !Array.isArray(revision.manifest.materials)) throw fail('OVERALL_REVIEW_SOURCE_INPUT_STALE');
  for (const ref of refs) {
    const pinned = (revision.material_versions as Row[]).some(m => m.material_id === ref.materialId && Number(m.material_version) === ref.materialVersion) &&
      (revision.manifest.materials as Row[]).some(m => m.material_id === ref.materialId && Number(m.material_version) === ref.materialVersion &&
        String(m.sha256).trim().toLowerCase() === ref.materialSha256);
    const found = await client.query(`SELECT e.record_sha256,e.content_sha256,m.sha256 AS material_sha256,m.deleted_at
      FROM bb_parse_evidence e JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
        AND m.id=e.material_id AND m.version=e.material_version
      JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.material_id=e.material_id
        AND s.material_version=e.material_version AND s.id=e.snapshot_id AND s.content_sha256=e.content_sha256
        AND s.response_status IN ('parsed','needs_confirmation')
      WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
        AND e.snapshot_id=$5 AND e.record_id=$6`, [owner, project, ref.materialId, ref.materialVersion, ref.parseSnapshotId, ref.recordId]);
    const row = found.rows[0];
    if (!pinned || !row || row.deleted_at !== null || String(row.record_sha256).trim() !== ref.recordSha256 ||
        String(row.content_sha256).trim() !== ref.materialSha256 || String(row.material_sha256).trim() !== ref.materialSha256)
      throw fail('OVERALL_REVIEW_EVIDENCE_NOT_PINNED');
  }
}
export async function appendRuleApplicabilityOverallReview(db: Db, input: AppendRuleApplicabilityOverallReviewInput): Promise<RuleApplicabilityOverallReviewRecord> {
  validate(input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const reviewer = await authorizeRuleApplicabilityReviewer(client, input.principal, input.scope);
    if (!reviewer) throw fail('OVERALL_REVIEW_REVIEWER_NOT_AUTHORIZED');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${input.scope.ownerUserId}:${input.scope.projectId}:rule-overall-review:${input.requestId}`]);
    const target = input.target;
    const context = (await client.query(`SELECT content_hash,source_input_revision,source_input_hash FROM bb_rule_applicability_context_drafts
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
    [input.scope.ownerUserId, input.scope.projectId, target.contextId, target.contextVersion])).rows[0];
    if (!context || String(context.content_hash).trim() !== target.contextContentHash ||
        Number(context.source_input_revision) !== target.sourceInputRevision || String(context.source_input_hash).trim() !== target.sourceInputHash)
      throw fail('OVERALL_REVIEW_CONTEXT_PIN_MISMATCH');
    const reqHash = replayHash(input, reviewer.userId, reviewer.grantId);
    const prior = (await client.query(`SELECT * FROM bb_rule_applicability_overall_reviews WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`,
      [input.scope.ownerUserId, input.scope.projectId, input.requestId])).rows[0];
    if (prior) {
      if (String(prior.request_hash).trim() !== reqHash) throw fail('OVERALL_REVIEW_IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT'); return map(prior, true);
    }
    if (input.action === 'approve') {
      const targetConfirmation = (await client.query(`SELECT market,offering,document_purpose,as_of::text AS as_of,confirmed_by
        FROM bb_input_revision_target_confirmations WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3 FOR SHARE`,
      [input.scope.ownerUserId, input.scope.projectId, target.sourceInputRevision])).rows[0];
      if (!targetConfirmation || targetConfirmation.confirmed_by !== input.scope.ownerUserId ||
          targetConfirmation.market !== input.approvedValues!.market || targetConfirmation.offering !== input.approvedValues!.offering ||
          targetConfirmation.document_purpose !== input.approvedValues!.documentStage ||
          String(targetConfirmation.as_of) !== input.approvedValues!.asOf)
        throw fail('OVERALL_REVIEW_TARGET_INTENT_MISMATCH');
      const fieldDecisions = await client.query(`SELECT DISTINCT ON (r.candidate_id) r.action,r.field_key,r.candidate_value
        FROM bb_rule_applicability_field_reviews r
        WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.context_id=$3 AND r.context_version=$4
        ORDER BY r.candidate_id,r.reviewed_at DESC,r.id DESC`,
      [input.scope.ownerUserId, input.scope.projectId, target.contextId, target.contextVersion]);
      const approvedValueByField: Record<string, unknown> = { ...input.approvedValues, documentPurpose: input.approvedValues!.documentStage };
      for (const decision of fieldDecisions.rows) {
        if (decision.action !== 'adopt_candidate') throw fail(`OVERALL_REVIEW_FIELD_ACTION_UNRESOLVED:${String(decision.field_key)}`);
        const key = String(decision.field_key);
        if (!(key in approvedValueByField) || canonical(parse(decision.candidate_value)) !== canonical(approvedValueByField[key]))
          throw fail(`OVERALL_REVIEW_FIELD_ACTION_VALUE_MISMATCH:${key}`);
      }
      const refs = [...Object.values(input.valueEvidence ?? {}).flat(), ...(input.featureEvidence ?? []).flatMap(f => [...f.evidenceRefs])];
      await validateEvidenceAgainstInput(client, input.scope.ownerUserId, input.scope.projectId, target.sourceInputRevision, target.sourceInputHash, refs);
      const materialRows = (await client.query(`SELECT material_versions,manifest FROM bb_input_revisions
        WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
      [input.scope.ownerUserId, input.scope.projectId, target.sourceInputRevision])).rows[0];
      const sourceManifest = materialRows && isRecord(materialRows.manifest) ? materialRows.manifest : null;
      const manifestMaterials: unknown[] = sourceManifest && Array.isArray(sourceManifest.materials) ? sourceManifest.materials : [];
      const materials = manifestMaterials.filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => `${String(item.material_id)}\u0000${String(item.material_version)}`).sort();
      if (materials.length === 0 || new Set(materials).size !== materials.length || !Array.isArray(materialRows?.material_versions) ||
          materials.length !== materialRows.material_versions.length) throw fail('OVERALL_REVIEW_COMPLETE_MATERIAL_SET_UNAVAILABLE');
      for (const feature of input.featureEvidence ?? []) {
        const covered = [...new Set(feature.evidenceRefs.map(ref => `${ref.materialId}\u0000${ref.materialVersion}`))].sort();
        if (canonical(covered) !== canonical(materials)) throw fail(`OVERALL_REVIEW_FEATURE_MATERIAL_COVERAGE_INCOMPLETE:${feature.dimension}`);
      }
    }
    const id = randomUUID();
    const result = await client.query(`INSERT INTO bb_rule_applicability_overall_reviews
      (id,request_id,request_hash,owner_user_id,project_id,context_id,context_version,context_content_hash,source_input_revision,source_input_hash,
       action,reason,applicability_values,value_evidence,feature_evidence,taxonomy_version,reviewer_user_id,reviewer_grant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18) RETURNING *`,
    [id, input.requestId, reqHash, input.scope.ownerUserId, input.scope.projectId, target.contextId, target.contextVersion,
      target.contextContentHash, target.sourceInputRevision, target.sourceInputHash, input.action, input.reason.trim(),
      input.approvedValues ? JSON.stringify(input.approvedValues) : null, JSON.stringify(input.valueEvidence ?? {}),
      JSON.stringify(input.featureEvidence ?? []), input.taxonomyVersion ?? null, reviewer.userId, reviewer.grantId]);
    const inserted = result.rows[0]!;
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'rule_applicability_overall_review',$3,'rule_applicability.overall_review_recorded',$4::jsonb)`,
    [randomUUID(), input.scope.ownerUserId, inserted.id, JSON.stringify({ review_id: inserted.id, project_id: input.scope.projectId,
      context_id: target.contextId, context_version: target.contextVersion, action: input.action,
      reviewer_user_id: reviewer.userId, reviewer_grant_id: reviewer.grantId })]);
    await client.query('COMMIT');
    return map(inserted, false);
  } catch (cause) { await client.query('ROLLBACK').catch(() => undefined); throw cause; }
  finally { await client.release(); }
}

/** Latest appended decision wins; revoked reviewers can never keep a pin eligible. */
export async function loadApprovedRuleApplicabilityReview(db: Queryable, scope: RuleApplicabilityReviewerScope,
  target: { contextId: string; contextVersion: number; contextContentHash: string; sourceInputRevision: number; sourceInputHash: string }): Promise<RuleApplicabilityOverallReviewRecord | null> {
  const result = await db.query(`SELECT r.* FROM bb_rule_applicability_overall_reviews r
    WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.context_id=$3 AND r.context_version=$4
      AND r.context_content_hash=$5 AND r.source_input_revision=$6 AND r.source_input_hash=$7
    ORDER BY r.sequence_id DESC LIMIT 1`,
  [scope.ownerUserId, scope.projectId, target.contextId, target.contextVersion, target.contextContentHash,
    target.sourceInputRevision, target.sourceInputHash]);
  const row = result.rows[0];
  if (!row || row.action !== 'approve') return null;
  const current = await db.query(`SELECT 1 FROM bb_rule_applicability_reviewer_grants g
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    WHERE g.id=$1 AND g.user_id=$2 AND g.role='rule_applicability_reviewer' AND g.revoked_at IS NULL
      AND g.scope_owner_user_id=$3 AND g.scope_project_id=$4`,
  [row.reviewer_grant_id, row.reviewer_user_id, scope.ownerUserId, scope.projectId]);
  if (!current.rows.length) return null;
  return map(row, false);
}
