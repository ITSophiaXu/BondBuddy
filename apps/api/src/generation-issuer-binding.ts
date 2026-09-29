import { createHash, randomUUID } from 'node:crypto';
import {
  GENERATION_ISSUER_MATERIAL_ROLES,
  VERIFIED_ISSUER_ENTITY_PATTERN,
  nextGenerationIssuerBindingStatus,
  validGenerationIssuerBindingApproval,
  type GenerationIssuerBindingExpectedInput,
  type GenerationIssuerBindingRef,
  type GenerationIssuerBindingResponse,
} from '@bondbuddy/contracts';
import { isTrustedIssuerIdentityReviewer, type TrustedIssuerIdentityReviewer } from './issuer-identity-source.js';

export interface GenerationIssuerBindingPool {
  connect(): Promise<GenerationIssuerBindingClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface GenerationIssuerBindingClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface GenerationIssuerBindingDependencies {
  readonly pool: GenerationIssuerBindingPool;
  readonly newId?: () => string;
}

export interface GenerationIssuerBindingScope {
  /** Authenticated principal; never request JSON. */
  readonly ownerUserId: string;
  readonly projectId: string;
}

export interface GenerationIssuerBindingObservationInput {
  readonly source_record_id: string;
  readonly observed_subject_label: string;
  readonly evidence_context: 'financial_statement' | 'identity_relationship';
  readonly subject_relation: 'issuer_compiler' | 'component_subsidiary' | 'unrelated' | 'pending';
  readonly accounting_scope: 'consolidated' | 'parent' | 'not_applicable' | 'pending';
  readonly relation_reason: string;
  /** Required for issuer_compiler observations and resolved server-side from the active identity review. */
  readonly source_identity_review_id?: string | null;
}

export interface GenerationIssuerBindingDecisionInput {
  readonly material_id: string;
  readonly material_version: number;
  readonly disposition: 'classified' | 'unrelated' | 'pending';
  readonly reason: string;
  readonly observations: readonly GenerationIssuerBindingObservationInput[];
}

export interface GenerationIssuerBindingDisputeInput {
  readonly code: string;
  readonly status: 'open' | 'resolved';
  readonly reason: string;
  readonly source_record_ids: readonly string[];
  readonly resolution: string | null;
}

export interface AppendGenerationIssuerBindingInput extends GenerationIssuerBindingScope {
  readonly inputRevision: number;
  readonly inputHash: string;
  readonly requestId: string;
  /** Runtime-branded context from authorizeIssuerIdentityReviewer; never request JSON. */
  readonly reviewer: TrustedIssuerIdentityReviewer;
  readonly materialDecisions: readonly GenerationIssuerBindingDecisionInput[];
  readonly disputes?: readonly GenerationIssuerBindingDisputeInput[];
}

export interface ReviewGenerationIssuerBindingInput extends GenerationIssuerBindingScope {
  readonly bindingId: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly requestId: string;
  readonly action: 'request_more_evidence' | 'approve' | 'withdraw';
  readonly reason: string;
  readonly reviewer: TrustedIssuerIdentityReviewer;
}

export interface AppendGenerationIssuerBindingResult {
  readonly bindingId: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly status: GenerationIssuerBindingResponse['status'];
  readonly created: boolean;
}
export interface ReviewGenerationIssuerBindingResult {
  readonly reviewId: string;
  readonly status: GenerationIssuerBindingResponse['status'];
  readonly replayed: boolean;
}

type MaterialPin = GenerationIssuerBindingResponse['selected_materials'][number];
type MaterialDecision = GenerationIssuerBindingResponse['material_decisions'][number];
type Observation = GenerationIssuerBindingResponse['material_decisions'][number]['observations'][number];
type Dispute = GenerationIssuerBindingResponse['disputes'][number];
type ReviewEvent = GenerationIssuerBindingResponse['review_events'][number];

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const verifiedEntityPattern = new RegExp(VERIFIED_ISSUER_ENTITY_PATTERN);
const issuerRoles: readonly string[] = GENERATION_ISSUER_MATERIAL_ROLES;
const MATERIAL_ROLES = new Set<string>(issuerRoles);

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'GenerationIssuerBindingError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_GENERATION_ISSUER_BINDING_ROW'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function utc(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}
function pinKey(pin: Pick<MaterialPin, 'material_id' | 'material_version'>): string {
  return `${pin.material_id}\u0000${pin.material_version}`;
}
function samePin(left: MaterialPin, right: MaterialPin): boolean {
  return left.material_id === right.material_id && left.material_version === right.material_version && left.role === right.role &&
    left.material_sha256 === right.material_sha256 && left.parse_snapshot_id === right.parse_snapshot_id &&
    left.parse_response_sha256 === right.parse_response_sha256 && left.parse_coverage === right.parse_coverage &&
    left.identity_coverage === right.identity_coverage && JSON.stringify(left.parse_warning_codes) === JSON.stringify(right.parse_warning_codes) &&
    JSON.stringify(left.identity_uncertainties) === JSON.stringify(right.identity_uncertainties);
}

/** Immutable decision content that a binding version hashes. Status and review events are append-only and excluded. */
export function generationIssuerBindingContent(value: {
  owner_user_id: string; project_id: string; input_revision: number; input_hash: string;
  selected_materials: readonly MaterialPin[]; material_decisions: readonly MaterialDecision[];
  disputes: readonly Dispute[]; issuer_entity_id: string | null;
}): Record<string, unknown> {
  return {
    schema_version: 'generation-issuer-binding-v1',
    owner_user_id: value.owner_user_id, project_id: value.project_id,
    input_revision: value.input_revision, input_hash: value.input_hash,
    selected_materials: value.selected_materials, material_decisions: value.material_decisions,
    disputes: value.disputes, issuer_entity_id: value.issuer_entity_id,
  };
}
export const generationIssuerBindingContentHash = (value: Parameters<typeof generationIssuerBindingContent>[0]): string =>
  sha256(canonical(generationIssuerBindingContent(value)));

/** Deterministic idempotency key over the reviewer-supplied decision request. */
function bindingRequestHash(value: {
  ownerUserId: string; projectId: string; inputRevision: number; inputHash: string; requestId: string;
  materialDecisions: readonly GenerationIssuerBindingDecisionInput[];
  disputes?: readonly GenerationIssuerBindingDisputeInput[];
}): string {
  return sha256(canonical({ owner_user_id: value.ownerUserId, project_id: value.projectId,
    input_revision: value.inputRevision, input_hash: value.inputHash, request_id: value.requestId,
    material_decisions: value.materialDecisions, disputes: value.disputes ?? [] }));
}

function identityReviewHash(row: Record<string, unknown>): string {
  return sha256(canonical({
    id: String(row.id), owner_user_id: String(row.owner_user_id), project_id: String(row.project_id),
    material_id: String(row.material_id), material_version: Number(row.material_version),
    source_record_id: String(row.source_record_id), identity_version: Number(row.identity_version),
    content_sha256: String(row.content_sha256).trim(), entity_id: String(row.entity_id),
    reviewer_user_id: String(row.reviewer_user_id), reviewer_grant_id: String(row.reviewer_grant_id),
    decision: String(row.decision), reason_code: String(row.reason_code),
    verified_entity_id: row.verified_entity_id === null || row.verified_entity_id === undefined ? null : String(row.verified_entity_id),
    entity_basis_kind: row.entity_basis_kind === null || row.entity_basis_kind === undefined ? null : String(row.entity_basis_kind),
    entity_basis_ref: row.entity_basis_ref === null || row.entity_basis_ref === undefined ? null : String(row.entity_basis_ref),
    created_at: utc(row.created_at),
  }));
}

async function assertActiveReviewerGrant(db: Pick<GenerationIssuerBindingClient, 'query'>, reviewer: TrustedIssuerIdentityReviewer,
  ownerUserId: string, projectId: string): Promise<void> {
  if (!isTrustedIssuerIdentityReviewer(reviewer) || reviewer.ownerUserId !== ownerUserId || reviewer.projectId !== projectId)
    throw fail('GENERATION_ISSUER_BINDING_REVIEWER_NOT_AUTHORIZED');
  const grant = await db.query(`SELECT 1 FROM bb_issuer_identity_reviewer_grants g JOIN bb_users u ON u.id=g.user_id
    WHERE g.id=$1 AND g.user_id=$2 AND g.role='issuer_identity_reviewer' AND g.revoked_at IS NULL
      AND g.scope_owner_user_id=$3 AND g.scope_project_id=$4 AND u.status='active' FOR SHARE OF g,u`,
  [reviewer.grantId, reviewer.userId, ownerUserId, projectId]);
  if (grant.rows.length !== 1) throw fail('GENERATION_ISSUER_BINDING_REVIEWER_NOT_AUTHORIZED');
}

interface IdentityCoverage {
  readonly coverage: 'complete' | 'incomplete';
  readonly uncertainties: MaterialPin['identity_uncertainties'];
}

/**
 * Current identity coverage for one material. Identity observations are versioned per
 * source record; only the highest identity_version for a source record is authoritative,
 * mirroring the #15 profile/context loaders. Coverage is incomplete when the authoritative
 * observation is unresolved/revoked, or when the same source record carries verified
 * observations that disagree on the entity (a re-verification conflict is never silently
 * superseded).
 */
async function currentIdentityCoverage(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  materialId: string, materialVersion: number): Promise<IdentityCoverage> {
  const rows = (await db.query(`SELECT r.id, r.source_record_id, r.source_record_sha256, r.source_locator,
      r.identity_version, rv.decision, rv.verified_entity_id, rv.entity_basis_kind, rv.entity_basis_ref, g.id AS active_grant_id
    FROM bb_issuer_identity_source_records r
    LEFT JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
      AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id
    LEFT JOIN bb_issuer_identity_reviewer_grants g ON g.id=rv.reviewer_grant_id AND g.user_id=rv.reviewer_user_id
      AND g.role='issuer_identity_reviewer' AND g.revoked_at IS NULL
      AND g.scope_owner_user_id=r.owner_user_id AND g.scope_project_id=r.project_id
    WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.material_id=$3 AND r.material_version=$4
    ORDER BY r.source_record_id, r.identity_version`, [scope.ownerUserId, scope.projectId, materialId, materialVersion])).rows;
  const latestByRecord = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row.source_record_id);
    const prior = latestByRecord.get(key);
    if (!prior || Number(row.identity_version) > Number(prior.identity_version)) latestByRecord.set(key, row);
  }
  const uncertainties: MaterialPin['identity_uncertainties'] = [];
  for (const row of latestByRecord.values()) {
    const decision = row.decision === null || row.decision === undefined ? null : String(row.decision);
    const verified = decision === 'verified' && row.active_grant_id !== null && validVerifiedBasis(row);
    const rejected = decision === 'rejected' && row.active_grant_id !== null;
    if (verified) {
      // The latest verified observation of this source record must be resolvable to exactly the
      // entities attested by every live version of the same record; a re-verified different entity
      // is an unresolved subject conflict, not a silent supersession.
      const entities = new Set<string>();
      for (const candidate of rows) {
        if (String(candidate.source_record_id) !== String(row.source_record_id)) continue;
        const candidateDecision = candidate.decision === null || candidate.decision === undefined ? null : String(candidate.decision);
        if (candidateDecision === 'verified' && candidate.active_grant_id !== null && validVerifiedBasis(candidate))
          entities.add(String(candidate.verified_entity_id));
      }
      if (entities.size > 1) {
        const locator = parseJson(row.source_locator);
        uncertainties.push({
          code: 'ISSUER_IDENTITY_OBSERVATION_UNRESOLVED',
          source_record_id: String(row.source_record_id),
          source_record_sha256: String(row.source_record_sha256).trim(),
          locator: isRecord(locator) ? { type: 'parse_evidence', value: locator } : null,
          reason: '同一主体观察存在多个已核验且不一致的实体，需人工确认。',
        });
      }
      continue;
    }
    if (rejected) continue;
    const locator = parseJson(row.source_locator);
    uncertainties.push({
      code: 'ISSUER_IDENTITY_OBSERVATION_UNRESOLVED',
      source_record_id: String(row.source_record_id),
      source_record_sha256: String(row.source_record_sha256).trim(),
      locator: isRecord(locator) ? { type: 'parse_evidence', value: locator } : null,
      reason: decision === null ? '材料主体观察尚未经授权审核。' : '材料主体观察的审核已撤回、冲突或缺失审核依据。',
    });
  }
  return uncertainties.length
    ? { coverage: 'incomplete', uncertainties }
    : { coverage: 'complete', uncertainties: [] };
}

function validVerifiedBasis(row: Record<string, unknown>): boolean {
  const entity = row.verified_entity_id;
  const kind = row.entity_basis_kind;
  const basis = row.entity_basis_ref;
  if (typeof entity !== 'string' || !verifiedEntityPattern.test(entity)) return false;
  if (!['uscc', 'registry_record', 'manual_attestation'].includes(String(kind))) return false;
  if (typeof basis !== 'string' || basis.trim().length === 0 || basis.length > 512) return false;
  return kind !== 'uscc' || entity === `uscc:${basis}`;
}

interface CurrentPinSet { readonly pins: MaterialPin[] }

/** Server-authoritative issuer-role material pins for one locked generation input revision. Null means fail closed. */
async function collectCurrentPins(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  inputRevision: number, inputHash: string): Promise<CurrentPinSet | null> {
  const revision = (await db.query(`SELECT input_hash, manifest FROM bb_input_revisions
    WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 FOR SHARE`,
  [scope.ownerUserId, scope.projectId, inputRevision])).rows[0];
  if (!revision || String(revision.input_hash).trim() !== inputHash) return null;
  const manifest = revision.manifest;
  if (!isRecord(manifest) || manifest.kind !== 'generation' || !Array.isArray(manifest.materials)) return null;
  const materials = manifest.materials.filter((item): item is Record<string, unknown> => isRecord(item)).map(item => ({
    material_id: String(item.material_id), material_version: Number(item.material_version),
    role: String(item.role), sha256: String(item.sha256).trim(),
  }));
  if (materials.some(item => !idPattern.test(item.material_id) || !Number.isSafeInteger(item.material_version) ||
      item.material_version < 1 || item.role.length === 0 || item.role.length > 64 || !shaPattern.test(item.sha256))) return null;
  const selected = materials.filter(item => MATERIAL_ROLES.has(item.role))
    .sort((a, b) => a.material_id.localeCompare(b.material_id) || a.material_version - b.material_version);
  if (selected.length === 0 || selected.length > 100 ||
      new Set(selected.map(item => `${item.material_id}\u0000${item.material_version}`)).size !== selected.length) return null;
  const pins: MaterialPin[] = [];
  for (const material of selected) {
    const live = (await db.query(`SELECT role, sha256, deleted_at FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
    [scope.ownerUserId, scope.projectId, material.material_id, material.material_version])).rows[0];
    if (!live || live.deleted_at !== null || String(live.role) !== material.role ||
        String(live.sha256).trim() !== material.sha256) return null;
    const snapshot = (await db.query(`SELECT id, content_sha256, response_sha256, response_status, response_meta
      FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [scope.ownerUserId, scope.projectId, material.material_id, material.material_version])).rows[0];
    if (!snapshot || !['parsed', 'needs_confirmation'].includes(String(snapshot.response_status)) ||
        String(snapshot.content_sha256).trim() !== material.sha256 || !shaPattern.test(String(snapshot.response_sha256).trim())) return null;
    const meta = parseJson(snapshot.response_meta);
    if (!isRecord(meta) || !Array.isArray(meta.warnings) ||
        !meta.warnings.every(warning => isRecord(warning) && typeof warning.code === 'string' && warning.code.length > 0)) return null;
    const warningCodes = [...new Set((meta.warnings as { code: string }[]).map(warning => warning.code))];
    const identity = await currentIdentityCoverage(db, scope, material.material_id, material.material_version);
    pins.push({
      material_id: material.material_id, material_version: material.material_version, role: material.role as MaterialPin['role'],
      material_sha256: material.sha256, parse_snapshot_id: String(snapshot.id),
      parse_response_sha256: String(snapshot.response_sha256).trim(),
      parse_coverage: warningCodes.length ? 'incomplete' : 'complete', parse_warning_codes: warningCodes,
      identity_coverage: identity.coverage, identity_uncertainties: identity.uncertainties,
    });
  }
  return { pins };
}

interface ResolvedObservation { readonly observation: Observation; readonly candidateKey: string | null }

/** Resolve one reviewer observation against the immutable parse ledger and, for compilers, the active identity review. */
async function resolveObservation(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  pin: MaterialPin, input: GenerationIssuerBindingObservationInput): Promise<ResolvedObservation> {
  if (!idPattern.test(input.source_record_id) || !input.observed_subject_label.trim() || input.observed_subject_label.length > 512 ||
      !['financial_statement', 'identity_relationship'].includes(input.evidence_context) ||
      !['issuer_compiler', 'component_subsidiary', 'unrelated', 'pending'].includes(input.subject_relation) ||
      !['consolidated', 'parent', 'not_applicable', 'pending'].includes(input.accounting_scope) ||
      !input.relation_reason.trim()) throw fail('INVALID_GENERATION_ISSUER_BINDING_OBSERVATION');
  const evidence = (await db.query(`SELECT record_sha256, content_sha256, locator_type, locator, literal_quote, uncertainty
    FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      AND snapshot_id=$5 AND record_id=$6`,
  [scope.ownerUserId, scope.projectId, pin.material_id, pin.material_version, pin.parse_snapshot_id, input.source_record_id])).rows[0];
  if (!evidence || String(evidence.content_sha256).trim() !== pin.material_sha256 ||
      !shaPattern.test(String(evidence.record_sha256).trim()) || !Array.isArray(evidence.uncertainty) || evidence.uncertainty.length > 0) {
    throw fail('GENERATION_ISSUER_BINDING_OBSERVATION_EVIDENCE_MISMATCH');
  }
  const locator = parseJson(evidence.locator);
  if (!isRecord(locator)) throw fail('GENERATION_ISSUER_BINDING_OBSERVATION_EVIDENCE_MISMATCH');
  let reviewId: string | null = null;
  let reviewSha: string | null = null;
  let reviewDecision: 'verified' | null = null;
  let verifiedEntityId: string | null = null;
  let candidateKey: string | null = null;
  if (input.source_identity_review_id !== null && input.source_identity_review_id !== undefined) {
    if (!idPattern.test(input.source_identity_review_id)) throw fail('INVALID_GENERATION_ISSUER_BINDING_OBSERVATION');
    const review = (await db.query(`SELECT rv.*, r.source_record_id AS identity_source_record_id,
        r.source_record_sha256 AS identity_source_record_sha256, r.source_content_sha256 AS identity_source_content_sha256,
        r.entity_id AS identity_candidate_key
      FROM bb_issuer_identity_source_reviews rv
      JOIN bb_issuer_identity_source_records r ON r.owner_user_id=rv.owner_user_id AND r.project_id=rv.project_id
        AND r.material_id=rv.material_id AND r.material_version=rv.material_version AND r.id=rv.source_record_id
        AND r.identity_version=rv.identity_version AND r.content_sha256=rv.content_sha256 AND r.entity_id=rv.entity_id
      JOIN bb_issuer_identity_reviewer_grants g ON g.id=rv.reviewer_grant_id AND g.user_id=rv.reviewer_user_id
        AND g.role='issuer_identity_reviewer' AND g.revoked_at IS NULL
        AND g.scope_owner_user_id=rv.owner_user_id AND g.scope_project_id=rv.project_id
      JOIN bb_users u ON u.id=rv.reviewer_user_id AND u.status='active'
      WHERE rv.owner_user_id=$1 AND rv.project_id=$2 AND rv.material_id=$3 AND rv.material_version=$4 AND rv.id=$5 FOR SHARE OF rv, r, g, u`,
    [scope.ownerUserId, scope.projectId, pin.material_id, pin.material_version, input.source_identity_review_id])).rows[0];
    if (!review || String(review.decision) !== 'verified' || !validVerifiedBasis(review) ||
        String(review.identity_source_record_id) !== input.source_record_id ||
        String(review.identity_source_record_sha256).trim() !== String(evidence.record_sha256).trim() ||
        String(review.identity_source_content_sha256).trim() !== pin.material_sha256) {
      throw fail('GENERATION_ISSUER_BINDING_OBSERVATION_IDENTITY_REVIEW_MISMATCH');
    }
    reviewId = String(review.id);
    reviewSha = identityReviewHash(review);
    reviewDecision = 'verified';
    verifiedEntityId = String(review.verified_entity_id);
    candidateKey = review.identity_candidate_key === null || review.identity_candidate_key === undefined ? null : String(review.identity_candidate_key);
  } else if (input.subject_relation === 'issuer_compiler') {
    throw fail('GENERATION_ISSUER_BINDING_COMPILER_REVIEW_REQUIRED');
  }
  const observation: Observation = {
    source_record_id: input.source_record_id, source_record_sha256: String(evidence.record_sha256).trim(),
    material_id: pin.material_id, material_version: pin.material_version, material_sha256: pin.material_sha256,
    parse_snapshot_id: pin.parse_snapshot_id, parse_response_sha256: pin.parse_response_sha256,
    locator: { type: String((evidence as Record<string, unknown>).locator_type ?? 'parse_evidence'), value: locator },
    quote: String(evidence.literal_quote), observed_subject_label: input.observed_subject_label,
    evidence_context: input.evidence_context, subject_relation: input.subject_relation,
    accounting_scope: input.accounting_scope, relation_reason: input.relation_reason,
    source_identity_review_id: reviewId, source_identity_review_sha256: reviewSha,
    source_identity_review_decision: reviewDecision, verified_entity_id: verifiedEntityId,
  };
  return { observation, candidateKey };
}

function derivedIssuerEntityId(decisions: readonly MaterialDecision[]): string | null {
  const entities = new Set<string>();
  for (const decision of decisions) for (const observation of decision.observations) {
    if (observation.subject_relation === 'issuer_compiler' && observation.verified_entity_id) entities.add(observation.verified_entity_id);
  }
  if (entities.size > 1) throw fail('GENERATION_ISSUER_BINDING_SUBJECT_CONFLICT');
  return entities.size === 1 ? [...entities][0]! : null;
}

async function buildDecisions(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  pins: readonly MaterialPin[], input: readonly GenerationIssuerBindingDecisionInput[]):
  Promise<{ decisions: MaterialDecision[]; issuerEntityId: string | null }> {
  const pinByKey = new Map(pins.map(pin => [pinKey(pin), pin]));
  if (input.length !== pins.length) throw fail('GENERATION_ISSUER_BINDING_DECISION_COVERAGE_MISMATCH');
  const seen = new Set<string>();
  const decisions: MaterialDecision[] = [];
  for (const decision of input) {
    const key = `${decision.material_id}\u0000${decision.material_version}`;
    const pin = pinByKey.get(key);
    if (!pin || seen.has(key) || !['classified', 'unrelated', 'pending'].includes(decision.disposition) ||
        !decision.reason.trim() || decision.reason.length > 2048 || !Array.isArray(decision.observations))
      throw fail('GENERATION_ISSUER_BINDING_DECISION_COVERAGE_MISMATCH');
    if (decision.disposition === 'pending' && decision.observations.length > 0)
      throw fail('GENERATION_ISSUER_BINDING_DECISION_INVALID');
    if (decision.disposition === 'unrelated' &&
        (decision.observations.length === 0 || decision.observations.some(item => item.subject_relation !== 'unrelated')))
      throw fail('GENERATION_ISSUER_BINDING_DECISION_INVALID');
    if (decision.disposition === 'classified' &&
        (decision.observations.length === 0 || decision.observations.every(item => item.subject_relation === 'unrelated')))
      throw fail('GENERATION_ISSUER_BINDING_DECISION_INVALID');
    seen.add(key);
    const observations: Observation[] = [];
    for (const observationInput of decision.observations) {
      const { observation } = await resolveObservation(db, scope, pin, observationInput);
      if (observation.evidence_context === 'financial_statement' && observation.accounting_scope === 'not_applicable')
        throw fail('GENERATION_ISSUER_BINDING_DECISION_INVALID');
      if (observation.evidence_context === 'identity_relationship' && observation.accounting_scope !== 'not_applicable')
        throw fail('GENERATION_ISSUER_BINDING_DECISION_INVALID');
      observations.push(observation);
    }
    decisions.push({ material_id: pin.material_id, material_version: pin.material_version,
      disposition: decision.disposition, reason: decision.reason.trim(), observations });
  }
  if (seen.size !== pins.length) throw fail('GENERATION_ISSUER_BINDING_DECISION_COVERAGE_MISMATCH');
  return { decisions, issuerEntityId: derivedIssuerEntityId(decisions) };
}

function normalizeDisputes(disputes: readonly GenerationIssuerBindingDisputeInput[] | undefined,
  decisions: readonly MaterialDecision[]): Dispute[] {
  const sourceIds = new Set(decisions.flatMap(decision => decision.observations.map(observation => observation.source_record_id)));
  const result: Dispute[] = [];
  for (const dispute of disputes ?? []) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(dispute.code) || !['open', 'resolved'].includes(dispute.status) ||
        !dispute.reason.trim() || dispute.source_record_ids.length === 0 || dispute.source_record_ids.length > 100 ||
        [...dispute.source_record_ids].some(id => !sourceIds.has(id)) ||
        (dispute.status === 'resolved' && (!dispute.resolution || !dispute.resolution.trim()))) {
      throw fail('GENERATION_ISSUER_BINDING_DISPUTE_INVALID');
    }
    result.push({ code: dispute.code, status: dispute.status, reason: dispute.reason.trim(),
      source_record_ids: [...dispute.source_record_ids], resolution: dispute.resolution?.trim() ?? null });
  }
  return result;
}

async function readReviewEvents(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  bindingId: string, version: number): Promise<ReviewEvent[]> {
  const rows = (await db.query(`SELECT id, action, reason, reviewer_user_id, reviewer_grant_id, authority,
      binding_version, binding_content_sha256, created_at FROM bb_generation_issuer_binding_reviews
    WHERE owner_user_id=$1 AND project_id=$2 AND binding_id=$3 AND binding_version=$4 ORDER BY sequence_id`,
  [scope.ownerUserId, scope.projectId, bindingId, version])).rows;
  return rows.map(row => ({
    review_id: String(row.id), action: row.action as ReviewEvent['action'], reason: String(row.reason),
    reviewer_user_id: String(row.reviewer_user_id), reviewer_grant_id: String(row.reviewer_grant_id),
    authority: 'issuer_identity_reviewer' as const, binding_version: Number(row.binding_version),
    binding_content_sha256: String(row.binding_content_sha256).trim(), reviewed_at: utc(row.created_at),
  }));
}

function statusFromEvents(events: readonly ReviewEvent[], version: number, contentSha256: string): GenerationIssuerBindingResponse['status'] | null {
  let status: GenerationIssuerBindingResponse['status'] = 'pending';
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.review_id) || event.binding_version !== version || event.binding_content_sha256 !== contentSha256) return null;
    ids.add(event.review_id);
    const next = nextGenerationIssuerBindingStatus(status, event.action);
    if (next === null) return null;
    status = next;
  }
  return status;
}

interface StoredBinding {
  readonly binding_id: string; readonly version: number; readonly content_sha256: string;
  readonly owner_user_id: string; readonly project_id: string; readonly input_revision: number;
  readonly input_hash: string; readonly selected_materials: MaterialPin[];
  readonly material_decisions: MaterialDecision[]; readonly disputes: Dispute[];
  readonly issuer_entity_id: string | null; readonly created_at: string;
}

async function readStoredBinding(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  bindingId: string, version: number, contentSha256?: string): Promise<StoredBinding | null> {
  const row = (await db.query(`SELECT id, version, content_sha256, owner_user_id, project_id, input_revision, input_hash,
      selected_materials, material_decisions, disputes, issuer_entity_id, created_at FROM bb_generation_issuer_bindings
    WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
  [scope.ownerUserId, scope.projectId, bindingId, version])).rows[0];
  if (!row) return null;
  if (contentSha256 !== undefined && String(row.content_sha256).trim() !== contentSha256) return null;
  const selected = parseJson(row.selected_materials);
  const decisions = parseJson(row.material_decisions);
  const disputes = parseJson(row.disputes);
  if (!Array.isArray(selected) || !Array.isArray(decisions) || !Array.isArray(disputes)) throw fail('INVALID_GENERATION_ISSUER_BINDING_ROW');
  const stored: StoredBinding = {
    binding_id: String(row.id), version: Number(row.version), content_sha256: String(row.content_sha256).trim(),
    owner_user_id: String(row.owner_user_id), project_id: String(row.project_id), input_revision: Number(row.input_revision),
    input_hash: String(row.input_hash).trim(), selected_materials: selected as MaterialPin[],
    material_decisions: decisions as MaterialDecision[], disputes: disputes as Dispute[],
    issuer_entity_id: row.issuer_entity_id === null || row.issuer_entity_id === undefined ? null : String(row.issuer_entity_id),
    created_at: utc(row.created_at),
  };
  if (generationIssuerBindingContentHash(stored) !== stored.content_sha256) throw fail('GENERATION_ISSUER_BINDING_CONTENT_HASH_MISMATCH');
  return stored;
}

/** Append an immutable combination decision. The server derives every material/parse/review pin; callers only classify. */
export async function appendGenerationIssuerBinding(
  dependencies: GenerationIssuerBindingDependencies,
  input: AppendGenerationIssuerBindingInput,
): Promise<AppendGenerationIssuerBindingResult> {
  if (![input.ownerUserId, input.projectId, input.requestId].every(value => idPattern.test(value)) ||
      !Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1 || !shaPattern.test(input.inputHash) ||
      !Array.isArray(input.materialDecisions) || input.materialDecisions.length === 0) throw fail('INVALID_GENERATION_ISSUER_BINDING_INPUT');
  const db = await dependencies.pool.connect();
  const newId = dependencies.newId ?? randomUUID;
  try {
    await db.query('BEGIN');
    await assertActiveReviewerGrant(db, input.reviewer, input.ownerUserId, input.projectId);
    const project = await db.query(`SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
      [input.ownerUserId, input.projectId]);
    if (project.rows.length !== 1) throw fail('GENERATION_ISSUER_BINDING_PROJECT_NOT_FOUND');
    const requestHash = bindingRequestHash(input);
    const prior = await db.query(`SELECT id, version, content_sha256, request_hash FROM bb_generation_issuer_bindings
      WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`, [input.ownerUserId, input.projectId, input.requestId]);
    if (prior.rows.length === 1) {
      const row = prior.rows[0]!;
      if (String(row.request_hash).trim() !== requestHash) throw fail('GENERATION_ISSUER_BINDING_IDEMPOTENCY_CONFLICT');
      const events = await readReviewEvents(db, input, String(row.id), Number(row.version));
      const status = statusFromEvents(events, Number(row.version), String(row.content_sha256).trim()) ?? 'pending';
      await db.query('COMMIT');
      return { bindingId: String(row.id), version: Number(row.version), contentSha256: String(row.content_sha256).trim(),
        status, created: false };
    }
    const currentPins = await collectCurrentPins(db, input, input.inputRevision, input.inputHash);
    if (!currentPins) throw fail('GENERATION_ISSUER_BINDING_INPUT_OR_MATERIAL_STALE');
    const { decisions, issuerEntityId } = await buildDecisions(db, input, currentPins.pins, input.materialDecisions);
    const disputes = normalizeDisputes(input.disputes, decisions);
    const content = generationIssuerBindingContent({ owner_user_id: input.ownerUserId, project_id: input.projectId,
      input_revision: input.inputRevision, input_hash: input.inputHash, selected_materials: currentPins.pins,
      material_decisions: decisions, disputes, issuer_entity_id: issuerEntityId });
    const contentSha256 = sha256(canonical(content));
    const bindingId = newId();
    await db.query(`INSERT INTO bb_generation_issuer_bindings
      (id, version, owner_user_id, project_id, input_revision, input_hash, request_id, request_hash,
       selected_materials, material_decisions, disputes, issuer_entity_id, content_sha256)
      VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)`,
    [bindingId, input.ownerUserId, input.projectId, input.inputRevision, input.inputHash, input.requestId, requestHash,
      JSON.stringify(currentPins.pins), JSON.stringify(decisions), JSON.stringify(disputes), issuerEntityId, contentSha256]);
    await db.query(`INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
      VALUES ($1,$2,'project',$3,'generation.issuer_binding.created',$4::jsonb)`,
    [newId(), input.ownerUserId, input.projectId, JSON.stringify({ binding_id: bindingId, version: 1,
      content_sha256: contentSha256, input_revision: input.inputRevision, status: 'pending' })]);
    await db.query('COMMIT');
    return { bindingId, version: 1, contentSha256, status: 'pending', created: true };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(); }
}


/** Re-resolve current anchors for a stored binding version. Returns current pins, or null if any anchor is stale. */
async function currentApprovablePins(db: Pick<GenerationIssuerBindingClient, 'query'>, scope: GenerationIssuerBindingScope,
  stored: StoredBinding): Promise<MaterialPin[] | null> {
  let currentPins: CurrentPinSet | null;
  try { currentPins = await collectCurrentPins(db, scope, stored.input_revision, stored.input_hash); }
  catch { return null; }
  if (!currentPins || currentPins.pins.length !== stored.selected_materials.length) return null;
  const expected = new Map(currentPins.pins.map(pin => [pinKey(pin), pin]));
  if (stored.selected_materials.some(pin => { const match = expected.get(pinKey(pin)); return !match || !samePin(pin, match); })) return null;
  if ([...expected.keys()].some(key => !stored.selected_materials.some(pin => pinKey(pin) === key))) return null;
  try {
    const { decisions } = await buildDecisions(db, scope, stored.selected_materials, stored.material_decisions.map(decision => ({
      material_id: decision.material_id, material_version: decision.material_version,
      disposition: decision.disposition, reason: decision.reason,
      observations: decision.observations.map(observation => ({
        source_record_id: observation.source_record_id, observed_subject_label: observation.observed_subject_label,
        evidence_context: observation.evidence_context, subject_relation: observation.subject_relation,
        accounting_scope: observation.accounting_scope, relation_reason: observation.relation_reason,
        source_identity_review_id: observation.source_identity_review_id,
      })),
    })));
    return canonical(decisions) === canonical(stored.material_decisions) ? currentPins.pins : null;
  } catch { return null; }
}

/** The frozen contract gate over a reconstructed response and the current authority pins. */
function contractGate(stored: StoredBinding, status: GenerationIssuerBindingResponse['status'],
  events: readonly ReviewEvent[], pins: readonly MaterialPin[]): boolean {
  if (status !== 'approved') return false;
  const response: GenerationIssuerBindingResponse = {
    schema_version: 'generation-issuer-binding-v1', binding_id: stored.binding_id, version: stored.version,
    content_sha256: stored.content_sha256, owner_user_id: stored.owner_user_id, project_id: stored.project_id,
    input_revision: stored.input_revision, input_hash: stored.input_hash, selected_materials: stored.selected_materials,
    material_decisions: stored.material_decisions, disputes: stored.disputes, status,
    issuer_entity_id: stored.issuer_entity_id, review_events: [...events], created_at: stored.created_at,
  };
  return validGenerationIssuerBindingApproval(response, {
    owner_user_id: stored.owner_user_id, project_id: stored.project_id,
    input_revision: stored.input_revision, input_hash: stored.input_hash,
  }, pins);
}

/** Append an approve/request_more_evidence/withdraw event under an active, project-scoped identity reviewer grant. */
export async function reviewGenerationIssuerBinding(
  dependencies: GenerationIssuerBindingDependencies,
  input: ReviewGenerationIssuerBindingInput,
): Promise<ReviewGenerationIssuerBindingResult> {
  if (![input.ownerUserId, input.projectId, input.bindingId, input.requestId].every(value => idPattern.test(value)) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || !shaPattern.test(input.contentSha256) ||
      !['request_more_evidence', 'approve', 'withdraw'].includes(input.action) ||
      !input.reason.trim() || input.reason.length > 2048) throw fail('INVALID_GENERATION_ISSUER_BINDING_REVIEW_INPUT');
  const db = await dependencies.pool.connect();
  const newId = dependencies.newId ?? randomUUID;
  try {
    await db.query('BEGIN');
    await assertActiveReviewerGrant(db, input.reviewer, input.ownerUserId, input.projectId);
    const stored = await readStoredBinding(db, input, input.bindingId, input.version, input.contentSha256);
    if (!stored) throw fail('GENERATION_ISSUER_BINDING_NOT_FOUND');
    const events = await readReviewEvents(db, input, input.bindingId, input.version);
    const status = statusFromEvents(events, input.version, input.contentSha256);
    if (status === null) throw fail('GENERATION_ISSUER_BINDING_REVIEW_STATE_INVALID');
    const requestHash = sha256(canonical({ owner_user_id: input.ownerUserId, project_id: input.projectId,
      binding_id: input.bindingId, version: input.version, content_sha256: input.contentSha256, action: input.action,
      reason: input.reason.trim(), reviewer_user_id: input.reviewer.userId, reviewer_grant_id: input.reviewer.grantId }));
    const prior = await db.query(`SELECT id, request_hash FROM bb_generation_issuer_binding_reviews r
      WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`, [input.ownerUserId, input.projectId, input.requestId]);
    if (prior.rows.length === 1) {
      if (String(prior.rows[0]!.request_hash).trim() !== requestHash) throw fail('GENERATION_ISSUER_BINDING_IDEMPOTENCY_CONFLICT');
      await db.query('COMMIT');
      return { reviewId: String(prior.rows[0]!.id), status, replayed: true };
    }
    const next = nextGenerationIssuerBindingStatus(status, input.action);
    if (next === null) throw fail('GENERATION_ISSUER_BINDING_REVIEW_TRANSITION_INVALID');
    if (input.action === 'approve') {
      const pins = await currentApprovablePins(db, input, stored);
      const prospective: ReviewEvent = {
        review_id: 'pending-approval', action: 'approve', reason: input.reason.trim(),
        reviewer_user_id: input.reviewer.userId, reviewer_grant_id: input.reviewer.grantId,
        authority: 'issuer_identity_reviewer', binding_version: input.version,
        binding_content_sha256: input.contentSha256, reviewed_at: new Date().toISOString(),
      };
      if (!pins || !contractGate(stored, next, [...events, prospective], pins))
        throw fail('GENERATION_ISSUER_BINDING_NOT_CURRENTLY_APPROVABLE');
    }
    const reviewId = newId();
    await db.query(`INSERT INTO bb_generation_issuer_binding_reviews
      (id, owner_user_id, project_id, binding_id, binding_version, binding_content_sha256, action, reason,
       authority, reviewer_user_id, reviewer_grant_id, request_id, request_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issuer_identity_reviewer',$9,$10,$11,$12)`,
    [reviewId, input.ownerUserId, input.projectId, input.bindingId, input.version, input.contentSha256, input.action,
      input.reason.trim(), input.reviewer.userId, input.reviewer.grantId, input.requestId, requestHash]);
    await db.query(`INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
      VALUES ($1,$2,'project',$3,'generation.issuer_binding.reviewed',$4::jsonb)`,
    [newId(), input.ownerUserId, input.projectId, JSON.stringify({ binding_id: input.bindingId, version: input.version,
      content_sha256: input.contentSha256, action: input.action, status: next, reviewer_user_id: input.reviewer.userId })]);
    await db.query('COMMIT');
    return { reviewId, status: next, replayed: false };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(); }
}

/**
 * Trusted read for #17/#19 consumers. Returns the approved binding only when the caller's intended
 * owner/project/input revision/hash matches this exact ref and every stored pin still matches the
 * current live materials, latest parse snapshots, active identity reviews and grants. Never selects
 * a latest binding and never rewrites history.
 */
export async function loadApprovedGenerationIssuerBinding(
  pool: Pick<GenerationIssuerBindingPool, 'query'>, scope: GenerationIssuerBindingScope, ref: GenerationIssuerBindingRef,
  expectedInput: GenerationIssuerBindingExpectedInput,
): Promise<GenerationIssuerBindingResponse | null> {
  if (![scope.ownerUserId, scope.projectId, ref.binding_id].every(value => idPattern.test(value)) ||
      !Number.isSafeInteger(ref.version) || ref.version < 1 || !shaPattern.test(ref.content_sha256)) return null;
  if (expectedInput.owner_user_id !== scope.ownerUserId || expectedInput.project_id !== scope.projectId ||
      !Number.isSafeInteger(expectedInput.input_revision) || expectedInput.input_revision < 1 ||
      !shaPattern.test(expectedInput.input_hash)) return null;
  try {
    const stored = await readStoredBinding(pool, scope, ref.binding_id, ref.version, ref.content_sha256);
    if (!stored || stored.input_revision !== expectedInput.input_revision || stored.input_hash !== expectedInput.input_hash) return null;
    const events = await readReviewEvents(pool, scope, ref.binding_id, ref.version);
    const status = statusFromEvents(events, ref.version, ref.content_sha256);
    if (status !== 'approved' || events.length === 0 || events[events.length - 1]!.action !== 'approve') return null;
    const pins = await currentApprovablePins(pool, scope, stored);
    if (!pins || !contractGate(stored, status, events, pins)) return null;
    return {
      schema_version: 'generation-issuer-binding-v1', binding_id: stored.binding_id, version: stored.version,
      content_sha256: stored.content_sha256, owner_user_id: stored.owner_user_id, project_id: stored.project_id,
      input_revision: stored.input_revision, input_hash: stored.input_hash, selected_materials: stored.selected_materials,
      material_decisions: stored.material_decisions, disputes: stored.disputes, status,
      issuer_entity_id: stored.issuer_entity_id, review_events: events, created_at: stored.created_at,
    };
  } catch { return null; }
}
