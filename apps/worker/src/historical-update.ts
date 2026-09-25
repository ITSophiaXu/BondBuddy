import { Ajv } from 'ajv';
import { schemas, type Material } from '@bondbuddy/contracts';
import { factIdentityKey, type FactIdentity } from '@bondbuddy/domain/facts';
import { planHistoricalUpdate, updateContentHash, type HistoricalUpdateInput, type HistoricalUpdatePlan, type UpdateFact } from '@bondbuddy/domain/historical-update';
import { getParseSnapshot, type ParseEvidenceDependencies, type StoredParseSnapshot } from './parse-evidence-repository.js';
import { listHistoricalProfileHistory, type StoredHistoricalProfile } from './historical-profile-repository.js';
import { listFactCandidates, type StoredFactCandidate } from './fact-repository.js';
import { validateDocumentParseResponse } from './document-parser.js';
import { parseHistoricalNativeExtractorVersion } from './historical-native-recognition.js';

export interface UpdateMaterialLock { materialId: string; materialVersion: number; contentHash: string; role: Material['role'] }
/** Server-owned execution snapshot and semantic inventory. Never accept these fields directly from a browser/model. */
export interface LockedHistoricalUpdate extends Pick<HistoricalUpdateInput, 'context' | 'bindings' | 'occurrences' | 'columns' | 'coverage'> {
  materials: readonly UpdateMaterialLock[];
  baseline: { materialId: string; materialVersion: number; snapshotId: string; profileVersion: number };
  /** Trusted preflight must include all candidates/conflicts at snapshot creation. Later arrivals belong to a new input revision. */
  factCandidateIds: readonly string[];
  /** Hash of the immutable candidates named above. No newest-candidate selection. */
  factsHash: string;
}
type Scope = { ownerUserId: string; projectId: string; materialId: string; materialVersion: number };
/** Injectable repository reads for component tests; defaults use the owner-scoped repositories. */
export interface HistoricalUpdateReaders {
  snapshot(scope: Scope, id: string): Promise<StoredParseSnapshot | null>;
  profiles(scope: Scope): Promise<StoredHistoricalProfile[]>;
  facts(scope: Pick<Scope, 'ownerUserId' | 'projectId'>, identity: FactIdentity): Promise<readonly StoredFactCandidate[]>;
}
const profileValidator = new Ajv({ strict: false, allErrors: true }).compile(schemas.RecognitionResponse);
const auditedRoles = new Set<Material['role']>(['audit', 'financial', 'interimFinancial', 'notes']);
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function fail(code: string): never { throw new Error(code); }
function factIdentities(input: LockedHistoricalUpdate): FactIdentity[] {
  const identities = input.bindings.flatMap(binding => {
    const expr = binding.expression;
    return [...(expr.kind === 'fact' ? [expr.identity] : expr.kind === 'sum' ? expr.terms : [expr.left, expr.right]), ...(binding.replaces ? [binding.replaces] : [])];
  });
  return [...new Map(identities.map(identity => [factIdentityKey(identity), identity])).values()];
}
/** Stable across repository row ordering; binds exact immutable candidate contents. */
export function historicalUpdateFactsHash(facts: readonly StoredFactCandidate[]): string {
  return updateContentHash([...facts].sort((a, b) => a.candidate.candidateId.localeCompare(b.candidate.candidateId, 'en')));
}

/** Internal preparation seam only: no queue transitions, provider calls, billing or Word success promotion. */
export async function prepareHistoricalUpdate(
  dependencies: ParseEvidenceDependencies,
  input: LockedHistoricalUpdate,
  readers: HistoricalUpdateReaders = {
    snapshot: (scope, id) => getParseSnapshot(dependencies, scope, id),
    profiles: scope => listHistoricalProfileHistory(dependencies, scope),
    facts: (scope, identity) => listFactCandidates(dependencies, scope, identity),
  },
): Promise<HistoricalUpdatePlan> {
  const locked = structuredClone(input);
  const { context } = locked;
  const scope = { ownerUserId: context.ownerUserId, projectId: context.projectId, materialId: locked.baseline.materialId, materialVersion: locked.baseline.materialVersion };
  const materialKey = (id: string, version: number) => `${id}:${version}`;
  const materials = new Map(locked.materials.map(material => [materialKey(material.materialId, material.materialVersion), material]));
  if (materials.size !== locked.materials.length || !materials.size) fail('UPDATE_INVALID_MATERIAL_MANIFEST');
  const historical = materials.get(materialKey(scope.materialId, scope.materialVersion));
  if (!historical || historical.role !== 'historical') fail('UPDATE_HISTORICAL_MATERIAL_REQUIRED');
  for (const material of materials.values()) {
    const result = await dependencies.pool.query(
      `SELECT owner_user_id, project_id, id, version, sha256, role FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
      [context.ownerUserId, context.projectId, material.materialId, material.materialVersion],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || row.owner_user_id !== context.ownerUserId || row.project_id !== context.projectId ||
      row.id !== material.materialId || Number(row.version) !== material.materialVersion || row.role !== material.role ||
      String(row.sha256).trim().toLowerCase() !== material.contentHash) fail('UPDATE_MATERIAL_LOCK_MISMATCH');
  }
  const snapshot = await readers.snapshot(scope, locked.baseline.snapshotId);
  if (!snapshot || snapshot.ownerUserId !== context.ownerUserId || snapshot.projectId !== context.projectId ||
    snapshot.materialId !== scope.materialId || snapshot.materialVersion !== scope.materialVersion ||
    snapshot.snapshotId !== locked.baseline.snapshotId || snapshot.contentSha256 !== historical.contentHash) fail('UPDATE_BASELINE_LOCK_MISMATCH');
  const response = snapshot.response;
  if (!response.material || !response.request_id || ![docx, 'application/pdf'].includes(response.material.media_type) || snapshot.parserVersion !== response.parser_version) fail('UPDATE_INVALID_BASELINE_FORMAT');
  validateDocumentParseResponse(response, {
    schema_version: 'document-parse-request-v1', request_id: response.request_id,
    material: { ...response.material, material_id: scope.materialId, material_version: scope.materialVersion, sha256: historical.contentHash, authorized_local_path: '/locked-baseline' },
    options: snapshot.requestOptions,
  });
  const { request_id: _request, ...stableResult } = response;
  if (updateContentHash(stableResult) !== snapshot.responseSha256 || updateContentHash(response.records) !== updateContentHash(snapshot.evidence)) fail('UPDATE_PARSE_INTEGRITY_MISMATCH');
  const profiles = (await readers.profiles(scope)).filter(profile => profile.profileVersion === locked.baseline.profileVersion);
  const profile = profiles[0];
  if (profiles.length !== 1 || !profile || profile.ownerUserId !== context.ownerUserId || profile.projectId !== context.projectId ||
    profile.materialId !== scope.materialId || profile.materialVersion !== scope.materialVersion ||
    profile.recognition.profile_version !== locked.baseline.profileVersion || !profileValidator(profile.recognition)) fail('UPDATE_PROFILE_LOCK_MISMATCH');
  const fields = [profile.recognition.source_market, profile.recognition.source_offering, profile.recognition.latest_reporting_cutoff, ...profile.recognition.reporting_periods];
  if (fields.some(field => field.status === 'recognized' && (field.provenance.method !== 'native_text' ||
    parseHistoricalNativeExtractorVersion(field.provenance.extractor_version)?.parserVersion !== snapshot.parserVersion))) fail('UPDATE_PROFILE_PARSER_MISMATCH');
  const stored: StoredFactCandidate[] = [];
  const selectedIds = new Set(locked.factCandidateIds);
  if (selectedIds.size !== locked.factCandidateIds.length) fail('UPDATE_INVALID_FACT_MANIFEST');
  for (const identity of factIdentities(locked)) {
    if (identity.accountId !== context.ownerUserId || identity.entityId !== context.issuerEntityId) fail('UPDATE_FACT_OWNER_OR_ISSUER_MISMATCH');
    const rows = await readers.facts(scope, identity);
    if (rows.some(row => factIdentityKey(row.candidate.identity) !== factIdentityKey(identity))) fail('UPDATE_FACT_IDENTITY_MISMATCH');
    stored.push(...rows.filter(row => selectedIds.has(row.candidate.candidateId)));
  }
  if (stored.length !== selectedIds.size || new Set(stored.map(row => row.candidate.candidateId)).size !== stored.length ||
    historicalUpdateFactsHash(stored) !== locked.factsHash) fail('UPDATE_FACT_SNAPSHOT_CHANGED');
  const facts: UpdateFact[] = stored.map(({ candidate, provenance }) => {
    const source = materials.get(materialKey(provenance.materialId, provenance.materialVersion));
    if (!source || !auditedRoles.has(source.role) || provenance.uncertainty.length || !provenance.evidence.length ||
      provenance.evidence.some(anchor => anchor.material_id !== source.materialId || anchor.material_version !== source.materialVersion || anchor.content_hash !== source.contentHash)) fail('UPDATE_FACT_MATERIAL_MISMATCH');
    return { candidate, status: provenance.status, evidence: provenance.evidence.map(anchor => ({
      materialId: anchor.material_id, materialVersion: anchor.material_version, contentHash: anchor.content_hash,
      recordId: anchor.evidence_id, locatorType: anchor.locator_type, locator: anchor.locator, literalQuote: anchor.literal_quote,
      extractionVersion: anchor.extraction_version, uncertainty: anchor.uncertainty,
    })) };
  });
  const revisionSummary = response.document.revision_summary as { insertions?: unknown; deletions?: unknown } | undefined;
  if (response.material.media_type === docx && (!revisionSummary ||
    ![revisionSummary.insertions, revisionSummary.deletions].every(value => Number.isSafeInteger(value) && Number(value) >= 0))) fail('UPDATE_REVISION_BASELINE_REQUIRED');
  const blocks = response.records.map(record => {
    if (record.locator_type !== (response.material!.media_type === docx ? 'docx_block' : 'pdf_bbox')) fail('UPDATE_INVALID_BASELINE_FORMAT');
    return { recordId: record.record_id, text: record.literal_quote, locatorType: record.locator_type as 'docx_block' | 'pdf_bbox',
      locator: record.locator, formatting: record.formatting, uncertainty: record.uncertainty };
  });
  return planHistoricalUpdate({ ...locked, facts, baseline: {
    ...scope, contentHash: historical.contentHash, snapshotId: snapshot.snapshotId, parserVersion: snapshot.parserVersion,
    parseResultHash: snapshot.responseSha256, format: response.material.media_type === docx ? 'docx_effective' : 'pdf_requires_reconstruction',
    parseStatus: response.status, warnings: response.warnings.map(warning => warning.code),
    priorRevisions: { insertions: Number(revisionSummary?.insertions ?? 0), deletions: Number(revisionSummary?.deletions ?? 0) },
    blocks, profile: profile.recognition,
  } });
}
