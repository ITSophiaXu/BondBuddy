import { createHash, randomUUID } from 'node:crypto';
import {
  factCandidateStatus,
  factIdentityKey,
  type FactCandidate,
  type FactIdentity,
  type FactStatus,
} from '@bondbuddy/domain/facts';

export interface FactRepositoryPool {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface FactEvidenceAnchor {
  readonly evidence_id: string;
  readonly material_id: string;
  readonly material_version: number;
  readonly content_hash: string;
  readonly locator_type: string;
  readonly locator: Record<string, unknown>;
  readonly literal_quote: string;
  readonly extraction_method: string;
  readonly extraction_version: string;
  readonly confidence: number | null;
  readonly uncertainty: readonly string[];
  /** Repository metadata needed to round-trip candidate-level domain fields. */
  readonly candidate_confidence?: number;
  readonly source_anchor_review?: { readonly verifier_id: string; readonly verified_at: string };
}

export interface FactProvenance {
  readonly status: FactStatus;
  readonly evidence: readonly FactEvidenceAnchor[];
  readonly uncertainty: readonly string[];
  readonly materialId: string;
  readonly materialVersion: number;
  readonly sourceObservedAt: string;
  readonly sourceValidAsOf?: string;
  readonly verification?: {
    readonly actorId: string;
    readonly actorRole: 'internal_reviewer';
    readonly verifiedAt: string;
  };
  readonly createdAt: string;
}

export interface StoredFactCandidate {
  readonly candidate: FactCandidate;
  readonly provenance: FactProvenance;
}

export interface FactRepositoryContext {
  /** Must come from the authenticated worker execution context, not candidate JSON. */
  readonly ownerUserId: string;
  readonly projectId: string;
}

export interface FactRepositoryDependencies {
  readonly pool: FactRepositoryPool;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

function factError(code: string): Error {
  const error = new Error(code);
  error.name = 'FactRepositoryError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function validIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateIdentity(context: FactRepositoryContext, identity: FactIdentity): string {
  if (!context.ownerUserId.trim() || !context.projectId.trim() || identity.accountId !== context.ownerUserId ||
    !identity.entityId.trim() || !identity.scope.trim() || !identity.metric.trim() || !identity.unit.trim() ||
    !identity.basis.trim() || !identity.dataVersion.trim()) throw factError('INVALID_FACT_IDENTITY');
  for (const date of [identity.period.start, identity.period.end, identity.period.asOf]) {
    if (date !== undefined && !validIsoDay(date)) throw factError('INVALID_FACT_PERIOD');
  }
  return factIdentityKey(identity);
}

function validateEvidence(candidate: FactCandidate, materialId: string, materialVersion: number,
  evidence: readonly FactEvidenceAnchor[]): void {
  if (!Number.isSafeInteger(materialVersion) || materialVersion < 1 || !materialId.trim() || evidence.length === 0) {
    throw factError('FACT_SOURCE_EVIDENCE_REQUIRED');
  }
  for (const anchor of evidence) {
    if (!anchor.evidence_id.trim() || anchor.material_id !== materialId || anchor.material_version !== materialVersion ||
      !/^[a-f0-9]{64}$/.test(anchor.content_hash) || !anchor.locator_type.trim() || !isRecord(anchor.locator) ||
      !anchor.literal_quote.trim() || !anchor.extraction_method.trim() || !anchor.extraction_version.trim() ||
      !(anchor.confidence === null || (Number.isFinite(anchor.confidence) && anchor.confidence >= 0 && anchor.confidence <= 1)) ||
      !Array.isArray(anchor.uncertainty) || !anchor.uncertainty.every((reason) => typeof reason === 'string')) {
      throw factError('INVALID_FACT_EVIDENCE');
    }
  }
  if (new Set(evidence.map((anchor) => anchor.content_hash)).size !== 1) throw factError('FACT_EVIDENCE_HASH_MISMATCH');
  if (candidate.auditCheck && !evidence.some((anchor) => anchor.evidence_id === candidate.auditCheck?.evidenceId)) {
    throw factError('FACT_AUDIT_EVIDENCE_MISMATCH');
  }
}

function validateCandidate(context: FactRepositoryContext, candidate: FactCandidate,
  materialId: string, materialVersion: number, evidence: readonly FactEvidenceAnchor[]): {
    key: string; status: FactStatus; occurred: string; validAsOf: string | null; valueKind: 'decimal' | 'text' | 'unknown' | 'not_applicable';
    valueDecimal: string | null; valueText: string | null; uncertainty: string[];
  } {
  const key = validateIdentity(context, candidate.identity);
  if (candidate.source.kind === 'template' || candidate.source.kind === 'reference') throw factError('NON_ISSUER_FACT_SOURCE');
  if (candidate.source.kind === 'user_statement' && !validDate(candidate.source.observedAt)) {
    throw factError('USER_STATEMENT_DATE_REQUIRED');
  }
  if (!candidate.source.sourceId.trim() || !validDate(candidate.source.observedAt)) throw factError('INVALID_FACT_SOURCE');
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw factError('INVALID_CONFIDENCE');
  }
  validateEvidence(candidate, materialId, materialVersion, evidence);

  let valueKind: 'decimal' | 'text' | 'unknown' | 'not_applicable';
  let valueDecimal: string | null = null;
  let valueText: string | null = null;
  if (candidate.value.kind === 'known') {
    const value = candidate.value.decimalOrText.trim();
    if (!value) throw factError('INVALID_FACT_VALUE');
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
      valueKind = 'decimal';
      valueDecimal = value;
    } else {
      valueKind = 'text';
      valueText = candidate.value.decimalOrText;
    }
  } else {
    valueKind = candidate.value.kind;
  }
  const evidenceUncertainty = evidence.flatMap((anchor) => anchor.uncertainty);
  if (candidate.source.kind === 'audited' && evidence.some((anchor) => /ocr/i.test(anchor.extraction_method) &&
    anchor.evidence_id !== candidate.auditCheck?.evidenceId)) evidenceUncertainty.push('OCR_REVIEW_REQUIRED');
  const uncertainty = [...new Set([...(candidate.uncertainty ? [candidate.uncertainty] : []), ...evidenceUncertainty])];
  const persistedCandidate = uncertainty.length > 0 ? { ...candidate, uncertainty: uncertainty.join('; ') } : candidate;
  const status = factCandidateStatus(persistedCandidate);
  if (status === 'verified' && (candidate.source.kind !== 'audited' || !candidate.auditCheck || evidence.length === 0 ||
    evidence.some((anchor) => anchor.uncertainty.length > 0))) throw factError('VERIFICATION_EVIDENCE_REQUIRED');
  const validAsOf = candidate.source.validAsOf;
  if (validAsOf !== undefined && !validIsoDay(validAsOf)) throw factError('INVALID_FACT_VALID_DATE');
  return { key, status, occurred: new Date(candidate.source.observedAt).toISOString(), validAsOf: validAsOf ?? null,
    valueKind, valueDecimal, valueText, uncertainty };
}

function identityHash(identityKey: string): string {
  return createHash('sha256').update(identityKey, 'utf8').digest('hex');
}

function mapStatus(value: unknown): FactStatus {
  if (value === 'extracted' || value === 'verified' || value === 'user_asserted' || value === 'conflicted' ||
    value === 'needs_confirmation' || value === 'superseded') return value;
  throw factError('INVALID_FACT_ROW');
}

function mapJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw factError('INVALID_FACT_ROW'); }
}

function timestampString(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && validDate(value)) return new Date(value).toISOString();
  return null;
}

function dayString(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && validDate(value)) return value.slice(0, 10);
  return null;
}

function mapRow(row: Record<string, unknown>): StoredFactCandidate {
  const identity = mapJson(row.fact_key) as FactIdentity;
  const evidence = mapJson(row.evidence);
  const uncertainty = mapJson(row.uncertainty);
  if (!isRecord(identity) || !Array.isArray(evidence) || !Array.isArray(uncertainty) ||
    typeof row.material_id !== 'string' || !Number.isSafeInteger(Number(row.material_version)) ||
    timestampString(row.source_observed_at) === null || typeof row.source_kind !== 'string' || typeof row.source_ref !== 'string' ||
    typeof row.value_kind !== 'string') throw factError('INVALID_FACT_ROW');

  let value: FactCandidate['value'];
  if (row.value_kind === 'decimal' && typeof row.value_decimal === 'string') value = { kind: 'known', decimalOrText: row.value_decimal };
  else if (row.value_kind === 'text' && typeof row.value_text === 'string') value = { kind: 'known', decimalOrText: row.value_text };
  else if (row.value_kind === 'unknown' || row.value_kind === 'not_applicable') value = { kind: row.value_kind };
  else throw factError('INVALID_FACT_ROW');

  const anchorRows = evidence as FactEvidenceAnchor[];
  const confidenceValues = anchorRows.map((anchor) => anchor.candidate_confidence)
    .filter((item): item is number => typeof item === 'number');
  const evidenceConfidence = anchorRows.map((anchor) => anchor.confidence).filter((item): item is number => typeof item === 'number');
  const confidence = confidenceValues[0] ?? (evidenceConfidence.length ? Math.min(...evidenceConfidence) : 0);
  const reviewedAnchor = anchorRows.find((anchor) => anchor.source_anchor_review !== undefined);
  const verifiedAt = timestampString(row.verification_at);
  const verification = row.verification_actor_kind === 'internal_reviewer' && typeof row.verification_actor_id === 'string' && verifiedAt &&
    reviewedAnchor
    ? { kind: 'source_anchor_review' as const, evidenceId: reviewedAnchor.evidence_id,
      verifierId: row.verification_actor_id, verifierRole: 'internal_reviewer' as const }
    : null;
  const sourceObservedAt = timestampString(row.source_observed_at)!;
  const sourceValidAsOf = dayString(row.source_valid_as_of);
  const candidate: FactCandidate = {
    candidateId: String(row.id),
    identity,
    value,
    source: {
      kind: row.source_kind as FactCandidate['source']['kind'],
      sourceId: row.source_ref,
      observedAt: sourceObservedAt,
      ...(sourceValidAsOf ? { validAsOf: sourceValidAsOf } : {}),
    },
    confidence,
    uncertainty: (uncertainty as string[]).join('; ') || null,
    auditCheck: verification,
  };
  const status = mapStatus(row.status);
  return {
    candidate,
    provenance: {
      status,
      evidence: anchorRows,
      uncertainty: uncertainty as string[],
      materialId: row.material_id,
      materialVersion: Number(row.material_version),
      sourceObservedAt,
      ...(sourceValidAsOf ? { sourceValidAsOf } : {}),
      ...(verification ? { verification: { actorId: verification.verifierId, actorRole: 'internal_reviewer', verifiedAt: verifiedAt! } } : {}),
      createdAt: timestampString(row.created_at) ?? String(row.created_at),
    },
  };
}

const RETURNING_COLUMNS = `id, owner_user_id, project_id, fact_key_hash, fact_key, value_decimal, value_text, value_kind,
 source_kind, source_ref, status, source_observed_at, source_valid_as_of, verification_actor_kind,
 verification_actor_id, verification_at, material_id, material_version, evidence, uncertainty, created_at`;

/** Inserts one immutable source candidate. A later source is always another row. */
export async function insertFactCandidate(
  dependencies: FactRepositoryDependencies,
  context: FactRepositoryContext,
  candidate: FactCandidate,
  material: { readonly id: string; readonly version: number },
  evidence: readonly FactEvidenceAnchor[],
): Promise<StoredFactCandidate> {
  const validated = validateCandidate(context, candidate, material.id, material.version, evidence);
  const id = dependencies.newId?.() ?? randomUUID();
  const now = dependencies.now?.() ?? new Date();
  const verification = validated.status === 'verified' ? candidate.auditCheck : null;
  const result = await dependencies.pool.query(
    `INSERT INTO bb_fact_candidates
       (id, owner_user_id, project_id, entity_id, fact_key_hash, fact_key, value_decimal, value_text, value_kind,
        source_kind, source_ref, status, source_observed_at, source_valid_as_of, verification_actor_kind,
        verification_actor_id, verification_at, material_id, material_version, evidence, uncertainty)
     SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::date,
            $15, $16, $17::timestamptz, $18, $19, $20::jsonb, $21::jsonb
      WHERE EXISTS (
        SELECT 1 FROM bb_material_versions m
         WHERE m.owner_user_id = $2 AND m.project_id = $3 AND m.id = $18 AND m.version = $19
           AND m.deleted_at IS NULL AND m.role <> 'reference' AND m.sha256 = $22
      )
     RETURNING ${RETURNING_COLUMNS}`,
    [id, context.ownerUserId, context.projectId, candidate.identity.entityId, identityHash(validated.key),
      JSON.stringify(candidate.identity), validated.valueDecimal, validated.valueText, validated.valueKind,
      candidate.source.kind, candidate.source.sourceId, validated.status, validated.occurred, validated.validAsOf,
      verification ? 'internal_reviewer' : null, verification?.verifierId ?? null,
      verification ? now.toISOString() : null, material.id, material.version,
      JSON.stringify(evidence.map((anchor) => ({
        ...anchor,
        candidate_confidence: candidate.confidence,
        ...(verification && candidate.auditCheck?.evidenceId === anchor.evidence_id
          ? { source_anchor_review: { verifier_id: verification.verifierId, verified_at: now.toISOString() } }
          : {}),
      }))), JSON.stringify(validated.uncertainty), evidence[0]!.content_hash],
  );
  if (result.rows.length !== 1) throw factError('FACT_SOURCE_MATERIAL_NOT_FOUND');
  if (result.rows[0]!.owner_user_id !== context.ownerUserId || result.rows[0]!.project_id !== context.projectId) {
    throw factError('FACT_SCOPE_MISMATCH');
  }
  return mapRow(result.rows[0]!);
}

/** Lists all source candidates in an owner/project scope; an identity narrows the query without hiding conflicts. */
export async function listFactCandidates(
  dependencies: FactRepositoryDependencies,
  context: FactRepositoryContext,
  identity?: FactIdentity,
): Promise<readonly StoredFactCandidate[]> {
  if (!context.ownerUserId.trim() || !context.projectId.trim()) throw factError('INVALID_FACT_SCOPE');
  let result: { rows: Record<string, unknown>[] };
  if (identity) {
    const key = validateIdentity(context, identity);
    result = await dependencies.pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM bb_fact_candidates
        WHERE owner_user_id = $1 AND project_id = $2 AND fact_key_hash = $3
        ORDER BY created_at ASC, id ASC`,
      [context.ownerUserId, context.projectId, identityHash(key)],
    );
  } else {
    result = await dependencies.pool.query(
      `SELECT ${RETURNING_COLUMNS} FROM bb_fact_candidates
        WHERE owner_user_id = $1 AND project_id = $2
        ORDER BY created_at ASC, id ASC`,
      [context.ownerUserId, context.projectId],
    );
  }
  if (result.rows.some((row) => row.owner_user_id !== context.ownerUserId || row.project_id !== context.projectId)) {
    throw factError('FACT_SCOPE_MISMATCH');
  }
  return result.rows.map(mapRow);
}
