import { createHash } from 'node:crypto';
import { getParseSnapshot, type ParseEvidencePool, type StoredParseSnapshot } from './parse-evidence-repository.js';
import { DOCX_AUXILIARY_TARGETS_PARSER_VERSION, type DocxAuxiliaryTarget, type DocumentParseRecord } from './document-parser.js';

export interface FactEvidenceContextPool extends ParseEvidencePool {}

export interface FactEvidenceContextDependencies {
  readonly pool: FactEvidenceContextPool;
}

export interface FactEvidenceContextRequest {
  /** Trusted worker identity. Candidate and evidence IDs are resolved in PostgreSQL. */
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly candidateId: string;
}

export interface FactEvidenceContextBodyMember {
  readonly record_id: string;
  readonly content_sha256: string;
  readonly locator_type: DocumentParseRecord['locator_type'];
  readonly locator: Record<string, unknown>;
  readonly confidence: number | null;
  readonly uncertainty: readonly string[];
}

export interface FactEvidenceContextAuxiliaryMember {
  readonly target_id: string;
  readonly kind: DocxAuxiliaryTarget['kind'];
  readonly part_name: string;
  readonly part_sha256: string | null;
  readonly target_sha256: string | null;
  readonly scope: DocxAuxiliaryTarget['scope'];
  readonly parse_status: DocxAuxiliaryTarget['parse_status'];
  readonly relevance: 'relevant' | 'not_relevant' | 'unknown';
  readonly relevance_reason: string;
}

export interface FactEvidenceContextManifest {
  readonly schema_version: 'fact-evidence-context-v1';
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly candidate_id: string;
  readonly input_revision: number;
  readonly input_hash: string;
  readonly candidate_identity_sha256: string;
  readonly fact_identity: Record<string, unknown>;
  readonly source_kind: 'audited' | 'external';
  readonly candidate_status: 'extracted' | 'verified' | 'user_asserted' | 'conflicted' | 'needs_confirmation' | 'superseded';
  readonly candidate_uncertainty: readonly string[];
  readonly candidate_confidence: number;
  readonly material_id: string;
  readonly material_version: number;
  readonly material_sha256: string;
  readonly snapshot_id: string;
  readonly parser_version: string;
  readonly parse_request_hash: string;
  readonly parse_response_sha256: string;
  readonly parse_status: StoredParseSnapshot['response']['status'];
  readonly original_warnings: readonly { code: string; message: string }[];
  readonly selected_body: readonly FactEvidenceContextBodyMember[];
  readonly auxiliary_targets: readonly FactEvidenceContextAuxiliaryMember[];
  readonly completeness_status: 'complete' | 'incomplete';
  readonly completeness_reasons: readonly string[];
  readonly reviewable: boolean;
  readonly evidence_set_sha256: string;
}

export interface StoredFactEvidenceContextSet {
  readonly id: string;
  readonly evidenceSetSha256: string;
  readonly completenessStatus: 'complete' | 'incomplete';
  readonly reviewable: boolean;
  readonly manifest: FactEvidenceContextManifest;
  readonly replayed: boolean;
}

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'FactEvidenceContextRepositoryError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('FACT_EVIDENCE_CONTEXT_SOURCE_INVALID'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableRef(record: DocumentParseRecord): string | null {
  const value = record.locator.stable_ref;
  return typeof value === 'string' ? value : null;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function assessAuxiliary(
  target: DocxAuxiliaryTarget,
  selectedStableRefs: ReadonlySet<string>,
): FactEvidenceContextAuxiliaryMember {
  const scope = target.scope;
  let relevance: FactEvidenceContextAuxiliaryMember['relevance'] = 'unknown';
  let relevanceReason = 'auxiliary_scope_does_not_locate_selected_body_records';

  if (scope.truncated || scope.status === 'unknown' || scope.status === 'partially_resolved') {
    relevanceReason = scope.truncated ? 'auxiliary_scope_truncated' : 'auxiliary_scope_incomplete';
  } else if (target.kind === 'footnote' || target.kind === 'endnote') {
    if (scope.status === 'unreferenced' && scope.body_references.length === 0) {
      relevance = 'not_relevant';
      relevanceReason = 'parser_records_auxiliary_target_as_unreferenced';
    } else if (scope.status === 'resolved' && scope.body_references.every(reference => reference.stable_ref !== null)) {
      const references = scope.body_references.map(reference => reference.stable_ref!);
      relevance = references.some(reference => selectedStableRefs.has(reference)) ? 'relevant' : 'not_relevant';
      relevanceReason = relevance === 'relevant'
        ? 'body_reference_matches_selected_evidence'
        : 'complete_body_reference_list_has_no_selected_evidence';
    }
  } else if (target.kind === 'header' || target.kind === 'footer') {
    // The parser identifies section relationships, but current body records do not bind each
    // locator to a section. Treat the influence as unknown until that mapping is persisted.
    relevanceReason = 'section_scope_not_mapped_to_selected_body_records';
  } else if (target.kind === 'drawing') {
    relevanceReason = 'drawing_target_scope_not_resolved_to_selected_body_records';
  } else {
    relevanceReason = 'unrecognized_auxiliary_part_relevance_unknown';
  }

  return {
    target_id: target.target_id,
    kind: target.kind,
    part_name: target.part_name,
    part_sha256: target.part_sha256,
    target_sha256: target.target_sha256,
    scope,
    parse_status: target.parse_status,
    relevance,
    relevance_reason: relevanceReason,
  };
}

export function deriveFactEvidenceContextManifest(input: {
  ownerUserId: string; projectId: string; candidateId: string; identityHash: string; sourceKind: 'audited' | 'external';
  inputRevision: number; inputHash: string; factIdentity: Record<string, unknown>;
  candidateStatus: FactEvidenceContextManifest['candidate_status']; candidateUncertainty: string[]; candidateConfidence: number;
  materialId: string; materialVersion: number; sourceSha256: string; snapshot: StoredParseSnapshot;
  selectedRecords: DocumentParseRecord[]; auxiliaryTargets: DocxAuxiliaryTarget[]; docx: boolean;
}): FactEvidenceContextManifest {
  const reasons = new Set<string>();
  const selectedBody = input.selectedRecords.map(record => ({
    record_id: record.record_id,
    content_sha256: record.content_hash,
    locator_type: record.locator_type,
    locator: record.locator,
    confidence: record.confidence,
    uncertainty: record.uncertainty,
  }));
  const refs = new Set(selectedBody.map(member => member.record_id));
  if (selectedBody.length === 0 || refs.size !== selectedBody.length) reasons.add('BODY_EVIDENCE_SELECTION_EMPTY_OR_DUPLICATED');
  if (!input.snapshot.evidenceComplete || input.snapshot.evidence.length !== input.snapshot.evidenceRecordCount) {
    reasons.add('PARSE_EVIDENCE_INVENTORY_INCOMPLETE');
  }
  if (input.snapshot.response.status === 'failed') reasons.add('PARSE_SNAPSHOT_FAILED');
  if (input.docx && input.snapshot.response.parser_version !== DOCX_AUXILIARY_TARGETS_PARSER_VERSION) reasons.add('DOCX_AUXILIARY_INVENTORY_VERSION_UNSUPPORTED');
  if (input.docx && !Array.isArray(input.snapshot.response.document.auxiliary_targets)) {
    reasons.add('DOCX_AUXILIARY_INVENTORY_MISSING');
  }

  const selectedStableRefs = new Set(input.selectedRecords.map(stableRef).filter((ref): ref is string => ref !== null));
  const auxiliary = input.auxiliaryTargets.map(target => assessAuxiliary(target, selectedStableRefs));
  const knownTargets = new Set(input.auxiliaryTargets.map(target => `${target.kind}:${target.part_name}`));
  for (const target of input.auxiliaryTargets) {
    if (target.scope.truncated) reasons.add('AUXILIARY_SCOPE_TRUNCATED');
    if (target.scope.status === 'unknown' || target.scope.status === 'partially_resolved') reasons.add('AUXILIARY_SCOPE_UNKNOWN');
    if (target.scope.relationships.some(relation => relation.status !== 'resolved')) reasons.add('AUXILIARY_RELATION_UNRESOLVED');
    if (target.scope.relationships.some(relation => relation.status === 'resolved' && relation.target_part !== null &&
      ['header', 'footer', 'footnotes', 'endnotes'].includes(relation.relationship_type) &&
      !knownTargets.has(`${relation.relationship_type === 'footnotes' ? 'footnote' : relation.relationship_type === 'endnotes' ? 'endnote' : relation.relationship_type}:${relation.target_part}`))) {
      reasons.add('AUXILIARY_TARGET_MISSING');
    }
    if (!target.parseable || !target.locator_resolved || target.part_sha256 === null || target.target_sha256 === null) {
      reasons.add('AUXILIARY_TARGET_UNREADABLE');
    }
  }
  if (auxiliary.some(target => target.relevance === 'unknown')) reasons.add('AUXILIARY_RELEVANCE_UNKNOWN');

  const completenessStatus: 'complete' | 'incomplete' = reasons.size === 0 ? 'complete' : 'incomplete';
  const base = {
    schema_version: 'fact-evidence-context-v1' as const,
    owner_user_id: input.ownerUserId,
    project_id: input.projectId,
    candidate_id: input.candidateId,
    input_revision: input.inputRevision,
    input_hash: input.inputHash,
    candidate_identity_sha256: input.identityHash,
    fact_identity: input.factIdentity,
    source_kind: input.sourceKind,
    candidate_status: input.candidateStatus,
    candidate_uncertainty: input.candidateUncertainty,
    candidate_confidence: input.candidateConfidence,
    material_id: input.materialId,
    material_version: input.materialVersion,
    material_sha256: input.sourceSha256,
    snapshot_id: input.snapshot.snapshotId,
    parser_version: input.snapshot.parserVersion,
    parse_request_hash: input.snapshot.requestHash,
    parse_response_sha256: input.snapshot.responseSha256,
    parse_status: input.snapshot.response.status,
    original_warnings: input.snapshot.response.warnings,
    selected_body: selectedBody,
    auxiliary_targets: auxiliary,
    completeness_status: completenessStatus,
    completeness_reasons: [...reasons].sort(),
    reviewable: completenessStatus === 'complete',
  };
  const evidenceSetSha256 = sha256(canonical(base));
  return { ...base, evidence_set_sha256: evidenceSetSha256 };
}

function mapStored(row: Record<string, unknown>, replayed: boolean): StoredFactEvidenceContextSet {
  const manifest = json(row.manifest);
  if (!isRecord(manifest) || typeof row.id !== 'string' || typeof row.evidence_set_sha256 !== 'string' ||
    !['complete', 'incomplete'].includes(String(row.completeness_status)) || typeof row.reviewable !== 'boolean' ||
    manifest.evidence_set_sha256 !== String(row.evidence_set_sha256).trim() || manifest.reviewable !== row.reviewable) {
    throw fail('FACT_EVIDENCE_CONTEXT_ROW_INVALID');
  }
  return { id: row.id, evidenceSetSha256: String(row.evidence_set_sha256).trim(),
    completenessStatus: row.completeness_status as 'complete' | 'incomplete', reviewable: row.reviewable,
    manifest: manifest as unknown as FactEvidenceContextManifest, replayed };
}

/**
 * Builds and stores a context only from an immutable fact candidate, its extraction ledger,
 * locked material version, and exact parse snapshot. No evidence subset is accepted from callers.
 */
export async function createFactEvidenceContextSet(
  dependencies: FactEvidenceContextDependencies,
  request: FactEvidenceContextRequest,
): Promise<StoredFactEvidenceContextSet> {
  if (![request.ownerUserId, request.projectId, request.candidateId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) {
    throw fail('FACT_EVIDENCE_CONTEXT_REQUEST_INVALID');
  }
  const client = await dependencies.pool.connect();
  let open = false;
  try {
    await client.query('BEGIN'); open = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`fact-evidence-context:${request.ownerUserId}:${request.projectId}:${request.candidateId}`]);
    const source = await client.query(
      `SELECT c.id AS candidate_id, c.owner_user_id, c.project_id, c.fact_key_hash, c.fact_key, c.source_kind, c.status, c.uncertainty,
              c.material_id, c.material_version, c.evidence, r.input_revision, r.input_hash, r.snapshot_id, r.parse_response_sha256,
              s.parser_version, s.content_sha256, s.response_sha256, s.request_hash, s.record_count, m.media_type, m.sha256 AS material_sha256
         FROM bb_fact_candidates c
         JOIN bb_fact_extraction_runs r ON r.owner_user_id=c.owner_user_id AND r.project_id=c.project_id
          AND r.material_id=c.material_id AND r.material_version=c.material_version
          AND r.candidate_ids @> jsonb_build_array(c.id)
         JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id
          AND i.revision=r.input_revision AND i.input_hash=r.input_hash
          AND i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',c.material_id,'material_version',c.material_version))
         JOIN bb_parse_snapshots s ON s.owner_user_id=r.owner_user_id AND s.project_id=r.project_id
          AND s.material_id=r.material_id AND s.material_version=r.material_version
          AND s.id=r.snapshot_id AND s.response_sha256=r.parse_response_sha256
         JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
          AND m.id=s.material_id AND m.version=s.material_version AND lower(btrim(m.sha256::text))=lower(btrim(s.content_sha256::text))
        WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.id=$3 AND c.source_kind IN ('audited','external')
          AND c.material_id IS NOT NULL AND c.material_version IS NOT NULL AND m.deleted_at IS NULL AND m.role <> 'reference'
        FOR SHARE OF c, r, s, m`,
      [request.ownerUserId, request.projectId, request.candidateId],
    );
    if (source.rows.length !== 1) throw fail(source.rows.length === 0
      ? 'FACT_EVIDENCE_CONTEXT_SOURCE_NOT_FOUND' : 'FACT_EVIDENCE_CONTEXT_SOURCE_AMBIGUOUS');
    const row = source.rows[0]!;
    const storedEvidence = json(row.evidence);
    const factIdentity = json(row.fact_key);
    const candidateUncertainty = json(row.uncertainty);
    if (!Array.isArray(storedEvidence) || !isRecord(factIdentity) || !Array.isArray(candidateUncertainty) ||
      !candidateUncertainty.every(reason => typeof reason === 'string') || !/^[a-f0-9]{64}$/.test(String(row.fact_key_hash)) ||
      String(row.response_sha256).trim() !== String(row.parse_response_sha256).trim()) throw fail('FACT_EVIDENCE_CONTEXT_SOURCE_INVALID');
    const evidenceIds = storedEvidence.map(anchor => isRecord(anchor) ? anchor.evidence_id : null);
    if (evidenceIds.length === 0 || evidenceIds.some(id => typeof id !== 'string') || new Set(evidenceIds).size !== evidenceIds.length) {
      throw fail('FACT_EVIDENCE_CONTEXT_REFS_INCOMPLETE');
    }
    const candidateConfidences = storedEvidence.map(anchor => isRecord(anchor) ? anchor.candidate_confidence : null);
    if (candidateConfidences.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) ||
      new Set(candidateConfidences).size !== 1 || !['extracted', 'verified', 'user_asserted', 'conflicted', 'needs_confirmation', 'superseded'].includes(String(row.status))) {
      throw fail('FACT_EVIDENCE_CONTEXT_SOURCE_INVALID');
    }

    const snapshot = await getParseSnapshot(dependencies, {
      ownerUserId: request.ownerUserId, projectId: request.projectId,
      materialId: String(row.material_id), materialVersion: Number(row.material_version),
    }, String(row.snapshot_id));
    if (!snapshot || snapshot.responseSha256 !== String(row.response_sha256).trim() ||
      snapshot.parserVersion !== String(row.parser_version) || snapshot.contentSha256 !== String(row.content_sha256).trim()) {
      throw fail('FACT_EVIDENCE_CONTEXT_PARSE_SNAPSHOT_MISMATCH');
    }
    const recordsById = new Map(snapshot.evidence.map(record => [record.record_id, record]));
    const selectedRecords: DocumentParseRecord[] = [];
    for (const raw of storedEvidence) {
      if (!isRecord(raw) || typeof raw.evidence_id !== 'string') throw fail('FACT_EVIDENCE_CONTEXT_REFS_INCOMPLETE');
      const parsed = recordsById.get(raw.evidence_id);
      if (!parsed || raw.material_id !== snapshot.materialId || Number(raw.material_version) !== snapshot.materialVersion ||
        raw.content_hash !== parsed.content_hash || raw.locator_type !== parsed.locator_type || !same(raw.locator, parsed.locator) ||
        raw.literal_quote !== parsed.literal_quote || raw.extraction_method !== parsed.extraction_method ||
        raw.extraction_version !== parsed.extractor_version || raw.confidence !== parsed.confidence || !same(raw.uncertainty, parsed.uncertainty)) {
        throw fail('FACT_EVIDENCE_CONTEXT_REF_MISMATCH');
      }
      selectedRecords.push(parsed);
    }
    if (snapshot.evidence.length !== Number(row.record_count)) throw fail('FACT_EVIDENCE_CONTEXT_PARSE_INVENTORY_INCOMPLETE');
    const docx = row.media_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const targets = Array.isArray(snapshot.response.document.auxiliary_targets)
      ? snapshot.response.document.auxiliary_targets as DocxAuxiliaryTarget[] : [];
    const manifest = deriveFactEvidenceContextManifest({
      ownerUserId: request.ownerUserId, projectId: request.projectId, candidateId: request.candidateId,
      inputRevision: Number(row.input_revision), inputHash: String(row.input_hash).trim(),
      identityHash: String(row.fact_key_hash).trim(), factIdentity,
      candidateStatus: row.status as FactEvidenceContextManifest['candidate_status'],
      candidateUncertainty: candidateUncertainty as string[], candidateConfidence: candidateConfidences[0] as number,
      sourceKind: row.source_kind as 'audited' | 'external',
      materialId: snapshot.materialId, materialVersion: snapshot.materialVersion, sourceSha256: snapshot.contentSha256,
      snapshot, selectedRecords, auxiliaryTargets: targets, docx,
    });
    if (Buffer.byteLength(canonical(manifest), 'utf8') > 1024 * 1024) throw fail('FACT_EVIDENCE_CONTEXT_TOO_LARGE');
    const id = `fact-evidence-context-${manifest.evidence_set_sha256}`;
    const inserted = await client.query(
      `INSERT INTO bb_fact_evidence_context_sets
         (id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,
          parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'fact-evidence-context-v1',$13,$14,$15,$16::jsonb)
       ON CONFLICT(owner_user_id,project_id,candidate_id,evidence_set_sha256) DO NOTHING
       RETURNING id,evidence_set_sha256,completeness_status,reviewable,manifest`,
      [id, request.ownerUserId, request.projectId, request.candidateId, Number(row.input_revision), String(row.input_hash).trim(),
        snapshot.materialId, snapshot.materialVersion, snapshot.snapshotId, snapshot.parserVersion, snapshot.responseSha256, snapshot.contentSha256,
        manifest.evidence_set_sha256, manifest.completeness_status, manifest.reviewable, JSON.stringify(manifest)],
    );
    let result = inserted.rows[0];
    let replayed = false;
    if (!result) {
      const prior = await client.query(
        `SELECT id,evidence_set_sha256,completeness_status,reviewable,manifest
           FROM bb_fact_evidence_context_sets
          WHERE owner_user_id=$1 AND project_id=$2 AND candidate_id=$3 AND evidence_set_sha256=$4`,
        [request.ownerUserId, request.projectId, request.candidateId, manifest.evidence_set_sha256],
      );
      if (prior.rows.length !== 1 || !same(json(prior.rows[0]!.manifest), manifest)) throw fail('FACT_EVIDENCE_CONTEXT_IDEMPOTENCY_CONFLICT');
      result = prior.rows[0]; replayed = true;
    }
    await client.query('COMMIT'); open = false;
    return mapStored(result!, replayed);
  } catch (error) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error instanceof Error && error.name === 'FactEvidenceContextRepositoryError'
      ? error : fail('FACT_EVIDENCE_CONTEXT_PERSIST_FAILED');
  } finally { client.release(); }
}
