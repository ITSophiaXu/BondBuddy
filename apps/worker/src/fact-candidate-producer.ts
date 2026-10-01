import { createHash, randomUUID } from 'node:crypto';
import { loadVerifiedIssuerIdentitySourceRecord, type VerifiedIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { isVerifiedIssuerIdentityBinding, issuerIdentityBindingMatches } from '@bondbuddy/api/issuer-identity-binding';
import { isTestIssuerCandidate, testIssuerCandidateMatches } from '@bondbuddy/api/test-issuer-candidate';
import { assertTestGrant } from '@bondbuddy/api/non-production-test';
import type { FactCandidate, FactIdentity } from '@bondbuddy/domain/facts';
import type { Pool } from 'pg';
import { SEMANTIC_FACT_EXTRACTION_REQUEST_VERSION, SEMANTIC_FACT_EXTRACTION_RESULT_VERSION } from './semantic-fact-extraction-constants.js';
export { SEMANTIC_FACT_EXTRACTION_REQUEST_VERSION, SEMANTIC_FACT_EXTRACTION_RESULT_VERSION } from './semantic-fact-extraction-constants.js';
import {
  RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID,
  RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION,
  RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256,
} from './rq-prospectus-annual-fact-constants.js';
import { RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_ID, RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_VERSION,
  RQ_Q3_FORMULA_SOURCE_SHA256 } from './rq-q3-formula-candidate-constants.js';
import { getParseSnapshot, type StoredParseSnapshot } from './parse-evidence-repository.js';
import { createFactEvidenceContextSet } from './fact-evidence-context-repository.js';
import { insertFactCandidate, listFactCandidates, type FactEvidenceAnchor, type FactRepositoryDependencies,
  type FactRepositoryContext, type StoredFactCandidate } from './fact-repository.js';

/** Internal semantic extraction handoff. It deliberately does not belong to public API contracts. */
export type SemanticFactIdentity = Omit<FactIdentity, 'accountId' | 'entityId' | 'dataVersion'>;
export type SemanticFactValue = FactCandidate['value'];

export interface SemanticFactExtractionResult {
  readonly schema_version: typeof SEMANTIC_FACT_EXTRACTION_RESULT_VERSION;
  readonly extractor: { readonly id: string; readonly version: string };
  readonly parse_snapshot: {
    readonly snapshot_id: string; readonly response_sha256: string; readonly parser_version: string;
    readonly material_id: string; readonly material_version: number; readonly content_sha256: string;
  };
  readonly facts: readonly {
    /** Stable within one immutable snapshot and extractor version. */
    readonly extraction_id: string;
    readonly identity: SemanticFactIdentity;
    readonly value: SemanticFactValue;
    readonly source_kind: 'audited' | 'external';
    readonly confidence: number;
    readonly uncertainty: readonly string[];
    readonly evidence_refs: readonly string[];
  }[];
  /** Records the extractor could not map without guessing; these are never persisted as facts. */
  readonly needs_review: readonly { readonly evidence_refs: readonly string[]; readonly reason_code: string }[];
}

export interface SemanticFactExtractionRequest {
  readonly schema_version: typeof SEMANTIC_FACT_EXTRACTION_REQUEST_VERSION;
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly input_revision: number;
  readonly input_hash: string;
  readonly issuer_identity_record_id: string;
  readonly issuer_identity_version: number;
  readonly issuer_identity_hash: string;
  readonly entity_id: string;
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly parse_snapshot_id: string;
  readonly parse_response_sha256: string;
  readonly parser_version: string;
  readonly records: StoredParseSnapshot['evidence'];
}

export interface SemanticFactExtractor {
  readonly id: string;
  readonly version: string;
  extract(request: SemanticFactExtractionRequest): Promise<SemanticFactExtractionResult>;
}

export interface FactCandidateProductionContext extends FactRepositoryContext {
  readonly testRunId?: string;
  readonly inputRevision: number;
  readonly inputHash: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly snapshotId: string;
}

export interface FactCandidateProducerDependencies extends FactRepositoryDependencies {
  /** Test seam for a separately configured internal extractor. No model call is made here. */
  readonly extractor: SemanticFactExtractor;
  /** Explicit source-role exception for a controlled historical-prospectus-only mapper. */
  readonly historicalProspectusExtractor?: SemanticFactExtractor;
  /** Exact-hash opt-in for the authorized rq-202509-02 formula-cache review candidates. */
  readonly rqQ3FormulaExtractor?: SemanticFactExtractor;
  readonly loadSnapshot?: typeof getParseSnapshot;
  readonly loadIssuerIdentity?: typeof loadVerifiedIssuerIdentitySourceRecord;
}

export interface FactCandidateProductionResult {
  readonly extractionRunId: string;
  readonly snapshotId: string;
  readonly responseSha256: string;
  readonly inserted: readonly StoredFactCandidate[];
  readonly replayed: readonly StoredFactCandidate[];
  readonly needsReview: SemanticFactExtractionResult['needs_review'];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const day = /^\d{4}-\d{2}-\d{2}$/;
const financialRoles = new Set(['audit', 'financial', 'interimFinancial', 'notes', 'accountDetails']);

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'FactCandidateProducerError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && day.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('FACT_EXTRACTION_INPUT_INVALID'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function factDataVersion(extractor: { id: string; version: string }): string {
  return `semantic:${extractor.id}@${extractor.version}`;
}

function candidateId(context: FactCandidateProductionContext, snapshot: StoredParseSnapshot,
  extractor: SemanticFactExtractionResult['extractor'], extractionId: string,
  issuerIdentity: { recordId: string; version: number; contentHash: string; entityId: string }): string {
  const identity = [context.ownerUserId, context.projectId, snapshot.snapshotId, snapshot.responseSha256,
    context.inputRevision, issuerIdentity.recordId, issuerIdentity.version, issuerIdentity.contentHash,
    issuerIdentity.entityId, extractor.id, extractor.version, extractionId];
  return `fact-${createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex')}`;
}

function parseIdentity(value: unknown): SemanticFactIdentity {
  if (!isRecord(value) || typeof value.scope !== 'string' || !value.scope.trim() ||
      typeof value.metric !== 'string' || !value.metric.trim() || !isRecord(value.period) ||
      !(value.currency === null || (typeof value.currency === 'string' && value.currency.trim())) ||
      typeof value.unit !== 'string' || !value.unit.trim() || typeof value.basis !== 'string' || !value.basis.trim()) {
    throw fail('FACT_EXTRACTION_IDENTITY_INCOMPLETE');
  }
  const period: Record<string, string> = {};
  for (const field of ['start', 'end', 'asOf'] as const) {
    const date = value.period[field];
    if (date !== undefined) {
      if (!validDate(date)) throw fail('FACT_EXTRACTION_PERIOD_INVALID');
      period[field] = date;
    }
  }
  if (!period.start && !period.end && !period.asOf) throw fail('FACT_EXTRACTION_PERIOD_REQUIRED');
  if (period.start && period.end && period.start > period.end) throw fail('FACT_EXTRACTION_PERIOD_INVALID');
  return { scope: value.scope, metric: value.metric, period, currency: value.currency as string | null,
    unit: value.unit, basis: value.basis };
}

function validateExtractionResult(value: unknown, context: FactCandidateProductionContext, snapshot: StoredParseSnapshot): SemanticFactExtractionResult {
  if (!isRecord(value) || value.schema_version !== SEMANTIC_FACT_EXTRACTION_RESULT_VERSION || !isRecord(value.extractor) ||
      !identifier.test(String(value.extractor.id)) || !identifier.test(String(value.extractor.version)) ||
      !isRecord(value.parse_snapshot) || !Array.isArray(value.facts) || !Array.isArray(value.needs_review)) {
    throw fail('FACT_EXTRACTION_RESULT_INVALID');
  }
  const pin = value.parse_snapshot;
  if (pin.snapshot_id !== snapshot.snapshotId || pin.response_sha256 !== snapshot.responseSha256 ||
      pin.parser_version !== snapshot.parserVersion || pin.material_id !== context.materialId ||
      pin.material_version !== context.materialVersion || pin.content_sha256 !== snapshot.contentSha256) {
    throw fail('FACT_EXTRACTION_SNAPSHOT_MISMATCH');
  }
  if (value.facts.length > 10000 || value.needs_review.length > 10000) throw fail('FACT_EXTRACTION_RESULT_LIMIT');
  if (value.facts.length === 0 && value.needs_review.length === 0) throw fail('FACT_EXTRACTION_EMPTY_RESULT');
  const evidenceIds = new Set(snapshot.evidence.map(record => record.record_id));
  const usedIds = new Set<string>();
  for (const entry of value.facts) {
    if (!isRecord(entry) || !identifier.test(String(entry.extraction_id)) || usedIds.has(String(entry.extraction_id)) ||
        !isRecord(entry.value) || !['known', 'unknown', 'not_applicable'].includes(String(entry.value.kind)) ||
        (entry.value.kind === 'known' && (typeof entry.value.decimalOrText !== 'string' || !entry.value.decimalOrText.trim())) ||
        (entry.value.kind !== 'known' && Object.keys(entry.value).length !== 1) ||
        !['audited', 'external'].includes(String(entry.source_kind)) || !Number.isFinite(entry.confidence) ||
        Number(entry.confidence) < 0 || Number(entry.confidence) > 1 || !Array.isArray(entry.uncertainty) ||
        !entry.uncertainty.every(reason => typeof reason === 'string' && reason.trim()) ||
        !Array.isArray(entry.evidence_refs) || entry.evidence_refs.length === 0 ||
        !entry.evidence_refs.every(ref => typeof ref === 'string' && evidenceIds.has(ref))) {
      throw fail('FACT_EXTRACTION_FACT_INVALID');
    }
    usedIds.add(String(entry.extraction_id));
    parseIdentity(entry.identity);
  }
  for (const entry of value.needs_review) {
    if (!isRecord(entry) || !Array.isArray(entry.evidence_refs) || entry.evidence_refs.length === 0 ||
        !entry.evidence_refs.every(ref => typeof ref === 'string' && evidenceIds.has(ref)) ||
        typeof entry.reason_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(entry.reason_code)) {
      throw fail('FACT_EXTRACTION_REVIEW_ITEM_INVALID');
    }
  }
  return value as unknown as SemanticFactExtractionResult;
}

function sameCandidate(left: StoredFactCandidate, right: FactCandidate): boolean {
  return JSON.stringify(left.candidate) === JSON.stringify(right);
}

function toEvidence(snapshot: StoredParseSnapshot, recordId: string): FactEvidenceAnchor {
  const record = snapshot.evidence.find(item => item.record_id === recordId);
  if (!record) throw fail('FACT_EXTRACTION_EVIDENCE_NOT_FOUND');
  return {
    evidence_id: record.record_id, material_id: record.material_id, material_version: record.material_version,
    content_hash: record.content_hash, locator_type: record.locator_type, locator: record.locator,
    literal_quote: record.literal_quote, extraction_method: record.extraction_method,
    extraction_version: record.extractor_version, confidence: record.confidence, uncertainty: record.uncertainty,
  };
}

async function ensureFactEvidenceContexts(pool: Pool, ownerUserId: string, projectId: string,
  candidates: readonly StoredFactCandidate[]): Promise<void> {
  const seen = new Set<string>();
  for (const item of candidates) {
    const id = item.candidate.candidateId;
    if (seen.has(id) || (item.candidate.source.kind !== 'audited' && item.candidate.source.kind !== 'external')) continue;
    seen.add(id);
    await createFactEvidenceContextSet({ pool }, { ownerUserId, projectId, candidateId: id });
  }
}

/**
 * Converts a versioned semantic result into append-only candidates only after rechecking the exact
 * immutable input, issuer identity review, material version, parser snapshot and every evidence ref.
 * The extractor supplies explicit fact dimensions; this function never infers metric/period/scope/unit.
 */
export async function produceParsedFactCandidates(
  dependencies: FactCandidateProducerDependencies,
  context: FactCandidateProductionContext,
): Promise<FactCandidateProductionResult> {
  if (![context.ownerUserId, context.projectId, context.materialId, context.snapshotId].every(id => identifier.test(id)) ||
      !Number.isSafeInteger(context.inputRevision) || context.inputRevision < 1 ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1 || !sha256.test(context.inputHash)) {
    throw fail('FACT_EXTRACTION_CONTEXT_INVALID');
  }
  const inputResult = await dependencies.pool.query(
    `SELECT input_hash, manifest, material_versions FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
    [context.ownerUserId, context.projectId, context.inputRevision]);
  if (inputResult.rows.length !== 1 || String(inputResult.rows[0]!.input_hash).trim() !== context.inputHash) {
    throw fail('FACT_EXTRACTION_INPUT_REVISION_MISMATCH');
  }
  const refs = parseJson(inputResult.rows[0]!.material_versions);
  if (!Array.isArray(refs) || !refs.some(ref => isRecord(ref) && ref.material_id === context.materialId &&
      ref.material_version === context.materialVersion)) throw fail('FACT_EXTRACTION_MATERIAL_NOT_PINNED');
  const manifest = parseJson(inputResult.rows[0]!.manifest);
  if (!isRecord(manifest)) throw fail('FACT_EXTRACTION_ISSUER_IDENTITY_NOT_VERIFIED');
  const verifiedBinding=isVerifiedIssuerIdentityBinding(manifest.issuer_identity)?manifest.issuer_identity:null;
  const testCandidate=isTestIssuerCandidate(manifest.test_issuer_candidate)?manifest.test_issuer_candidate:null;
  if(!verifiedBinding && (!testCandidate || !context.testRunId))throw fail('FACT_EXTRACTION_ISSUER_IDENTITY_NOT_VERIFIED');
  const validateTestRun=async(db:Pool)=>{
    const row=(await db.query(`SELECT channel,test_grant_id FROM bb_runs WHERE id=$1 AND owner_user_id=$2
      AND project_id=$3 AND input_revision=$4 AND input_hash=$5 AND task_kind='update'`,
    [context.testRunId,context.ownerUserId,context.projectId,context.inputRevision,context.inputHash])).rows[0];
    if(!row || row.channel!=='non_production_test' || !row.test_grant_id || !testCandidate ||
        !await testIssuerCandidateMatches(db,{ownerUserId:context.ownerUserId,projectId:context.projectId},testCandidate))
      throw fail('FACT_EXTRACTION_TEST_ISSUER_CANDIDATE_STALE');
    await assertTestGrant(db,{grantId:row.test_grant_id,userId:context.ownerUserId,projectId:context.projectId,
      inputRevision:context.inputRevision,inputHash:context.inputHash});
  };
  if(testCandidate && !verifiedBinding)await validateTestRun(dependencies.pool as Pool);
  const binding=verifiedBinding ?? testCandidate!;
  const verifiedIdentity=verifiedBinding
    ? await (dependencies.loadIssuerIdentity ?? loadVerifiedIssuerIdentitySourceRecord)(dependencies.pool as Pool, {
      ownerUserId: context.ownerUserId, projectId: context.projectId,
      materialId: binding.material_id, materialVersion: binding.material_version })
    : {recordId:testCandidate!.source_record_id,version:testCandidate!.identity_version,contentHash:testCandidate!.content_sha256,
      entityId:testCandidate!.candidate_key};
  if (!verifiedIdentity || (verifiedBinding && !issuerIdentityBindingMatches(verifiedBinding, verifiedIdentity as VerifiedIssuerIdentitySourceRecord)))
    throw fail('FACT_EXTRACTION_ISSUER_IDENTITY_STALE');

  const materialResult = await dependencies.pool.query(
    `SELECT role, media_type, sha256 FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion]);
  if (materialResult.rows.length !== 1) {
    throw fail('FACT_EXTRACTION_MATERIAL_NOT_FINANCIAL');
  }
  const materialRole = String(materialResult.rows[0]!.role);
  const materialMediaType = String(materialResult.rows[0]!.media_type);
  const isHistoricalProspectusSource = materialRole === 'historical' &&
    String(materialResult.rows[0]!.sha256).trim().toLowerCase() === RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256 &&
    materialMediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    dependencies.historicalProspectusExtractor?.id === RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_ID &&
    dependencies.historicalProspectusExtractor.version === RQ_PROSPECTUS_ANNUAL_FACT_EXTRACTOR_VERSION;
  const materialHash = String(materialResult.rows[0]!.sha256).trim().toLowerCase();
  if (!sha256.test(materialHash)) throw fail('FACT_EXTRACTION_MATERIAL_INVALID');
  const isRqQ3FormulaSource = materialRole === 'interimFinancial' &&
    materialMediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
    materialHash === RQ_Q3_FORMULA_SOURCE_SHA256 &&
    dependencies.rqQ3FormulaExtractor?.id === RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_ID &&
    dependencies.rqQ3FormulaExtractor.version === RQ_Q3_FORMULA_CANDIDATE_EXTRACTOR_VERSION;
  if (!financialRoles.has(materialRole) && !isHistoricalProspectusSource) throw fail('FACT_EXTRACTION_MATERIAL_NOT_FINANCIAL');
  const extractor = isHistoricalProspectusSource ? dependencies.historicalProspectusExtractor!
    : isRqQ3FormulaSource ? dependencies.rqQ3FormulaExtractor! : dependencies.extractor;

  const scope = { ownerUserId: context.ownerUserId, projectId: context.projectId, materialId: context.materialId,
    materialVersion: context.materialVersion };
  const snapshot = await (dependencies.loadSnapshot ?? getParseSnapshot)({ pool: dependencies.pool as Pool }, scope, context.snapshotId);
  if (!snapshot || snapshot.contentSha256 !== materialHash || snapshot.response.status === 'failed' ||
      snapshot.response.material?.material_id !== context.materialId || snapshot.response.material.material_version !== context.materialVersion) {
    throw fail('FACT_EXTRACTION_PARSE_SNAPSHOT_INVALID');
  }
  const request: SemanticFactExtractionRequest = {
    schema_version: SEMANTIC_FACT_EXTRACTION_REQUEST_VERSION,
    owner_user_id: context.ownerUserId, project_id: context.projectId,
    input_revision: context.inputRevision, input_hash: context.inputHash,
    issuer_identity_record_id: verifiedIdentity.recordId, issuer_identity_version: verifiedIdentity.version,
    issuer_identity_hash: verifiedIdentity.contentHash, entity_id: verifiedIdentity.entityId,
    material_id: context.materialId, material_version: context.materialVersion, material_sha256: materialHash,
    parse_snapshot_id: snapshot.snapshotId, parse_response_sha256: snapshot.responseSha256,
    parser_version: snapshot.parserVersion, records: snapshot.evidence,
  };
  if (!identifier.test(extractor.id) || !identifier.test(extractor.version)) {
    throw fail('FACT_EXTRACTION_ADAPTER_INVALID');
  }
  const extractors = [extractor.id, extractor.version];
  const previous = await dependencies.pool.query(
    `SELECT id, input_hash, parse_response_sha256, extractor_id, extractor_version, result_sha256,
            candidate_ids, needs_review
       FROM bb_fact_extraction_runs
      WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3 AND material_id=$4 AND material_version=$5
        AND snapshot_id=$6 AND extractor_id=$7 AND extractor_version=$8`,
    [context.ownerUserId, context.projectId, context.inputRevision, context.materialId, context.materialVersion,
      snapshot.snapshotId, ...extractors]);
  const replayPersisted = async (row: Record<string, unknown>): Promise<FactCandidateProductionResult> => {
    if (String(row.input_hash).trim() !== context.inputHash || String(row.parse_response_sha256).trim() !== snapshot.responseSha256 ||
        row.extractor_id !== extractor.id || row.extractor_version !== extractor.version) {
      throw fail('FACT_EXTRACTION_IDEMPOTENCY_CONFLICT');
    }
    const ids = parseJson(row.candidate_ids);
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw fail('FACT_EXTRACTION_LEDGER_INVALID');
    const all = await listFactCandidates(dependencies, { ownerUserId: context.ownerUserId, projectId: context.projectId });
    const byId = new Map(all.map(item => [item.candidate.candidateId, item]));
    const candidates = ids.map(id => byId.get(id as string));
    if (candidates.some(item => item === undefined)) throw fail('FACT_EXTRACTION_CANDIDATE_MISSING');
    const replayedCandidates = candidates as StoredFactCandidate[];
    await ensureFactEvidenceContexts(dependencies.pool as Pool, context.ownerUserId, context.projectId, replayedCandidates);
    return { extractionRunId: String(row.id), snapshotId: snapshot.snapshotId, responseSha256: snapshot.responseSha256,
      inserted: [], replayed: replayedCandidates, needsReview: parseJson(row.needs_review) as SemanticFactExtractionResult['needs_review'] };
  };
  if (previous.rows.length > 1) throw fail('FACT_EXTRACTION_LEDGER_AMBIGUOUS');
  if (previous.rows.length === 1) return replayPersisted(previous.rows[0]!);

  // Numerical/source uncertainty remains the extractor's exact result. The
  // provisional issuer identity is tracked separately in the locked input and
  // annotated on every test-draft edit; combining them here would make every
  // otherwise evidenced fact unusable to the historical planner.
  const result = validateExtractionResult(await extractor.extract(request), context, snapshot);
  if (result.extractor.id !== extractor.id || result.extractor.version !== extractor.version) {
    throw fail('FACT_EXTRACTION_VERSION_MISMATCH');
  }
  const resultSha256 = contentHash(result);
  const extractionRunId = `fact-extraction-${createHash('sha256').update(JSON.stringify([
    context.ownerUserId, context.projectId, context.inputRevision, context.materialId, context.materialVersion,
    snapshot.snapshotId, extractor.id, extractor.version,
  ])).digest('hex')}`;
  const client = await (dependencies.pool as Pool).connect();
  const transactionDependencies: FactRepositoryDependencies = { ...dependencies, pool: client };
  const inserted: StoredFactCandidate[] = [], replayed: StoredFactCandidate[] = [];
  let transactionOpen = false;
  let clientReleased = false;
  const releaseClient = () => {
    if (!clientReleased) { client.release(); clientReleased = true; }
  };
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const lockKey = `fact-extraction:${context.ownerUserId}:${context.projectId}:${context.inputRevision}:${context.materialId}:${context.materialVersion}:${snapshot.snapshotId}:${extractor.id}:${extractor.version}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
    // Hold the immutable input/material/parse source plus reviewer grant rows while candidates,
    // the extraction result ledger and its outbox event are written in this transaction.
    const lockedInput = await client.query(`SELECT 1 FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4 FOR SHARE`,
      [context.ownerUserId, context.projectId, context.inputRevision, context.inputHash]);
    if (lockedInput.rowCount !== 1) throw fail('FACT_EXTRACTION_INPUT_REVISION_MISMATCH');
    const lockedMaterial = await client.query(`SELECT role,media_type,sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND sha256=$5 AND deleted_at IS NULL FOR SHARE`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, materialHash]);
    if (lockedMaterial.rowCount !== 1) throw fail('FACT_EXTRACTION_MATERIAL_NOT_PINNED');
    const lockedRole = String(lockedMaterial.rows[0]!.role);
    const lockedRoleAllowed = financialRoles.has(lockedRole) || (isHistoricalProspectusSource && lockedRole === 'historical');
    if (lockedRole !== materialRole || String(lockedMaterial.rows[0]!.media_type) !== materialMediaType || !lockedRoleAllowed) {
      throw fail('FACT_EXTRACTION_MATERIAL_ROLE_CHANGED');
    }
    for (const fact of result.facts) {
      // The material role permits an audited assertion; it does not verify every
      // extracted value. Keep external candidates from audit files unverified.
      if (fact.source_kind === 'audited' && lockedRole !== 'audit') {
        throw fail('FACT_EXTRACTION_SOURCE_ROLE_MISMATCH');
      }
    }
    const lockedSnapshot = await client.query(`SELECT 1 FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND id=$5 AND response_sha256=$6 FOR SHARE`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, snapshot.snapshotId, snapshot.responseSha256]);
    if (lockedSnapshot.rowCount !== 1) throw fail('FACT_EXTRACTION_PARSE_SNAPSHOT_INVALID');
    const lockedIdentitySource = await client.query(`SELECT id FROM bb_issuer_identity_source_records WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 FOR SHARE`,
      [context.ownerUserId, context.projectId, binding.material_id, binding.material_version]);
    if (!lockedIdentitySource.rowCount) throw fail('FACT_EXTRACTION_ISSUER_IDENTITY_STALE');
    const lockedReviewerGrant = verifiedBinding ? await client.query(`SELECT g.id FROM bb_issuer_identity_source_reviews rv
      JOIN bb_issuer_identity_reviewer_grants g ON g.id=rv.reviewer_grant_id
      WHERE rv.owner_user_id=$1 AND rv.project_id=$2 AND rv.material_id=$3 AND rv.material_version=$4 FOR SHARE OF g`,
      [context.ownerUserId, context.projectId, binding.material_id, binding.material_version]) : null;
    if (verifiedBinding && !lockedReviewerGrant?.rowCount) throw fail('FACT_EXTRACTION_ISSUER_IDENTITY_STALE');
    if(testCandidate && !verifiedBinding)await validateTestRun(client as unknown as Pool);
    const currentIdentity = verifiedBinding ? await (dependencies.loadIssuerIdentity ?? loadVerifiedIssuerIdentitySourceRecord)(client as unknown as Pool, {
      ownerUserId: context.ownerUserId, projectId: context.projectId,
      materialId: binding.material_id, materialVersion: binding.material_version,
    }) : verifiedIdentity;
    if (!currentIdentity || (verifiedBinding && !issuerIdentityBindingMatches(verifiedBinding, currentIdentity as VerifiedIssuerIdentitySourceRecord)))
      throw fail('FACT_EXTRACTION_ISSUER_IDENTITY_STALE');

    const priorRun = await client.query(`SELECT id,input_hash,parse_response_sha256,result_sha256,candidate_ids,needs_review
      FROM bb_fact_extraction_runs WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3 AND material_id=$4
        AND material_version=$5 AND snapshot_id=$6 AND extractor_id=$7 AND extractor_version=$8`,
    [context.ownerUserId, context.projectId, context.inputRevision, context.materialId, context.materialVersion,
      snapshot.snapshotId, extractor.id, extractor.version]);
    if (priorRun.rows.length > 0) {
      const row = priorRun.rows[0]!;
      if (String(row.input_hash).trim() !== context.inputHash || String(row.parse_response_sha256).trim() !== snapshot.responseSha256 ||
          String(row.result_sha256).trim() !== resultSha256) throw fail('FACT_EXTRACTION_IDEMPOTENCY_CONFLICT');
      const ids = parseJson(row.candidate_ids);
      if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw fail('FACT_EXTRACTION_LEDGER_INVALID');
      const all = await listFactCandidates(transactionDependencies, { ownerUserId: context.ownerUserId, projectId: context.projectId });
      const byId = new Map(all.map(item => [item.candidate.candidateId, item]));
      const candidates = ids.map(id => byId.get(id as string));
      if (candidates.some(item => item === undefined)) throw fail('FACT_EXTRACTION_CANDIDATE_MISSING');
      await client.query('COMMIT');
      transactionOpen = false;
      // Context creation has its own transaction and parse read. Return this slot
      // before starting it so concurrent producers cannot nest pool reservations.
      releaseClient();
      const replayedCandidates = candidates as StoredFactCandidate[];
      await ensureFactEvidenceContexts(dependencies.pool as Pool, context.ownerUserId, context.projectId, replayedCandidates);
      return { extractionRunId: String(row.id), snapshotId: snapshot.snapshotId, responseSha256: snapshot.responseSha256,
        inserted: [], replayed: replayedCandidates, needsReview: parseJson(row.needs_review) as SemanticFactExtractionResult['needs_review'] };
    }

    const existing = await listFactCandidates(transactionDependencies, { ownerUserId: context.ownerUserId, projectId: context.projectId });
    const byId = new Map(existing.map(item => [item.candidate.candidateId, item]));
    const persistedIds: string[] = [];
    for (const fact of result.facts) {
      const evidence = fact.evidence_refs.map(ref => toEvidence(snapshot, ref));
      const uncertainty = [...new Set([
        ...fact.uncertainty,
        ...(snapshot.response.status === 'needs_confirmation' ? ['PARSE_SNAPSHOT_NEEDS_CONFIRMATION'] : []),
        ...evidence.flatMap(anchor => anchor.uncertainty),
        ...(evidence.some(anchor => anchor.confidence === null) ? ['SOURCE_CONFIDENCE_MISSING'] : []),
      ])];
      const candidate: FactCandidate = {
        candidateId: 'producer-assigned',
        identity: { accountId: context.ownerUserId, entityId: currentIdentity.entityId, ...parseIdentity(fact.identity),
          dataVersion: factDataVersion(result.extractor) },
        value: fact.value,
        source: { kind: fact.source_kind, sourceId: context.materialId, observedAt: snapshot.createdAt },
        confidence: Math.min(fact.confidence, ...evidence.map(anchor => anchor.confidence ?? 0)),
        uncertainty: uncertainty.length ? uncertainty.join('; ') : null,
        auditCheck: null,
      };
      const id = candidateId(context, snapshot, result.extractor, fact.extraction_id, currentIdentity);
      const stableCandidate = { ...candidate, candidateId: id };
      const existingCandidate = byId.get(id);
      if (existingCandidate) {
        if (!sameCandidate(existingCandidate, stableCandidate)) throw fail('FACT_EXTRACTION_IDEMPOTENCY_CONFLICT');
        persistedIds.push(id);
        replayed.push(existingCandidate);
        continue;
      }
      const stored = await insertFactCandidate({ ...transactionDependencies, newId: () => id },
        { ownerUserId: context.ownerUserId, projectId: context.projectId }, candidate,
        { id: context.materialId, version: context.materialVersion }, evidence);
      byId.set(id, stored);
      persistedIds.push(id);
      inserted.push(stored);
    }
    await client.query(`INSERT INTO bb_fact_extraction_runs
      (id,owner_user_id,project_id,input_revision,input_hash,material_id,material_version,snapshot_id,parse_response_sha256,
       extractor_id,extractor_version,result_sha256,candidate_ids,needs_review)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,
    [extractionRunId, context.ownerUserId, context.projectId, context.inputRevision, context.inputHash,
      context.materialId, context.materialVersion, snapshot.snapshotId, snapshot.responseSha256, result.extractor.id,
      result.extractor.version, resultSha256, JSON.stringify(persistedIds), JSON.stringify(result.needs_review)]);
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'project',$3,'fact.extraction.completed',$4::jsonb)`,
    [randomUUID(), context.ownerUserId, context.projectId, JSON.stringify({ extraction_run_id: extractionRunId,
      input_revision: context.inputRevision, material_id: context.materialId, material_version: context.materialVersion,
      parse_snapshot_id: snapshot.snapshotId, extractor_id: result.extractor.id, extractor_version: result.extractor.version,
      candidate_ids: persistedIds, needs_review_count: result.needs_review.length })]);
    await client.query('COMMIT');
    transactionOpen = false;
    // The immutable ledger/outbox is durable now. Release the producer's connection
    // before context persistence starts its own transaction.
    releaseClient();
    await ensureFactEvidenceContexts(dependencies.pool as Pool, context.ownerUserId, context.projectId, [...inserted, ...replayed]);
    return { extractionRunId, snapshotId: snapshot.snapshotId, responseSha256: snapshot.responseSha256,
      inserted, replayed, needsReview: result.needs_review };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    releaseClient();
  }
}
