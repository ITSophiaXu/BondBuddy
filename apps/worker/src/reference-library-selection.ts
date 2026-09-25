import { createHash } from 'node:crypto';
import { type LibraryCandidateV1_1, type LibraryQueryRequest, type LibraryQueryResponse, type LibrarySelectionLock } from '@bondbuddy/contracts';
import { matchBusinessReferences, matchLibraryQuery, type AnnualBusinessProfile, type ReferenceTarget } from '@bondbuddy/domain/reference-match';
import type { Pool } from 'pg';
import { checkpointStage, type Lease } from '@bondbuddy/api/queue';
import { lockReferenceSelection, queryReferenceLibrary } from '@bondbuddy/api/library';
import { Problem } from '@bondbuddy/api/data';

export type LibrarySelectionStatus = 'exact' | 'needs_evidence' | 'needs_review' | 'no_match' | 'unavailable' | 'index_version_mismatch';

/** Internal run checkpoint only. Never expose this object to a browser or include library body bytes. */
export interface LibrarySelectionSnapshot {
  schema_version: 'reference-selection-v1';
  query_schema_version: 'reference-library-query-v1.1';
  status: LibrarySelectionStatus;
  selection_hash: string;
  target: ReturnType<typeof matchBusinessReferences>['snapshot'];
  index_release: LibraryQueryResponse['index_release'];
  candidate_decisions: ReturnType<typeof matchLibraryQuery>['decisions'];
  selected: null | {
    reference_id: string;
    document_version_id: string;
    document_version: number;
    profile_id: string;
    profile_version: number;
    taxonomy_version: string;
    chapter_mapping_version: string | null;
    lock: LibrarySelectionLock;
  };
  reasons: readonly string[];
}

export interface NoHistoryLibrarySelectionInput {
  ownerUserId: string;
  projectId: string;
  runId: string;
  traceId: string;
  targetProfile: AnnualBusinessProfile;
  target: ReferenceTarget;
  ruleVersion: string;
}

export interface LibrarySelectionAdapters {
  query(request: LibraryQueryRequest): Promise<LibraryQueryResponse>;
  lock(input: {
    ownerUserId: string; projectId: string; runId: string; documentVersionId: string; profileId: string; indexReleaseId: string;
    querySchemaVersion: 'reference-library-query-v1.1'; documentVersion: number; profileVersion: number; taxonomyVersion: string;
    candidateScope: { market: string; offering: string; instrument: string };
    targetScope: { market: string; offering: string; instrument: string; document_stage: string; rule_version: string };
    comparability: NonNullable<LibraryCandidateV1_1['comparability']>; chapterMappingVersionId: string | null;
  }): Promise<LibrarySelectionLock>;
  persist(snapshot: LibrarySelectionSnapshot): Promise<void>;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidenceReferences(profile: AnnualBusinessProfile): string[] {
  return [...new Set([
    ...profile.sourceEvidence,
    ...profile.lines.flatMap(line => [...line.evidence, ...line.classificationEvidence]),
  ].map(value => value.trim()).filter(Boolean))];
}

function snapshotBase(fields: Omit<LibrarySelectionSnapshot, 'schema_version' | 'query_schema_version' | 'selection_hash'>): LibrarySelectionSnapshot {
  const unsigned = { schema_version: 'reference-selection-v1' as const, query_schema_version: 'reference-library-query-v1.1' as const, ...fields };
  return { ...unsigned, selection_hash: hash(unsigned) };
}

/** Trusted worker composition for the automatic no-history reference path. */
export async function selectNoHistoryLibraryReference(input: NoHistoryLibrarySelectionInput, adapters: LibrarySelectionAdapters): Promise<LibrarySelectionSnapshot> {
  const preflight = matchBusinessReferences({
    targetProfile: input.targetProfile, target: input.target, ruleVersion: input.ruleVersion,
    referenceIndexVersion: 'preflight-only', libraryAvailable: true, candidates: [],
  });
  if (preflight.status === 'needs_evidence' || preflight.status === 'needs_review') {
    const result = snapshotBase({ status: preflight.status, target: preflight.snapshot, index_release: null,
      candidate_decisions: [], selected: null, reasons: preflight.reasons });
    await adapters.persist(result);
    return result;
  }
  const evidenceRefs = evidenceReferences(input.targetProfile);
  if (!evidenceRefs.length || evidenceRefs.length > 30 || evidenceRefs.some(ref => ref.length > 128)) {
    const result = snapshotBase({ status: 'needs_review', target: preflight.snapshot, index_release: null,
      candidate_decisions: [], selected: null, reasons: ['target_evidence_reference_limit_exceeded'] });
    await adapters.persist(result);
    return result;
  }
  const codes = preflight.snapshot.targetBusinessProfile!.topThree.map(line => line.code);
  const request: LibraryQueryRequest = {
    schema_version: 'reference-library-query-v1.1', service_identity: 'task_service',
    audit: { owner_user_id: input.ownerUserId, project_id: input.projectId, run_id: input.runId, trace_id: input.traceId },
    target: { top3_codes: codes, taxonomy_version: input.targetProfile.taxonomyVersion, fiscal_year: input.targetProfile.fiscalYear,
      evidence_refs: evidenceRefs, market: input.target.market, offering: input.target.offering, instrument: input.target.instrument,
      document_stage: input.target.documentStage, rule_version: input.ruleVersion },
    index_release: null,
  };
  const response = await adapters.query(request);
  const matched = matchLibraryQuery({ targetProfile: input.targetProfile, target: input.target, ruleVersion: input.ruleVersion, response });
  if (matched.status !== 'exact' || !matched.selected || !response.index_release) {
    const result = snapshotBase({ status: matched.status, target: matched.targetValidation.snapshot,
      index_release: response.index_release, candidate_decisions: matched.decisions, selected: null, reasons: matched.reasons });
    await adapters.persist(result);
    return result;
  }
  const candidate = matched.selected;
  const candidateV11 = 'comparability' in candidate ? candidate as LibraryCandidateV1_1 : null;
  if (response.schema_version !== 'reference-library-query-v1.1' || !candidateV11?.comparability) {
    const result = snapshotBase({ status: 'needs_review', target: matched.targetValidation.snapshot,
      index_release: response.index_release, candidate_decisions: matched.decisions, selected: null,
      reasons: ['v1_1_reviewed_lock_facts_missing'] });
    await adapters.persist(result);
    return result;
  }
  let lock: LibrarySelectionLock;
  try {
    lock = await adapters.lock({ ownerUserId: input.ownerUserId, projectId: input.projectId, runId: input.runId,
      documentVersionId: candidate.document_version_id, profileId: candidate.profile_id, indexReleaseId: response.index_release.release_id,
      querySchemaVersion: 'reference-library-query-v1.1', documentVersion: candidate.document_version, profileVersion: candidate.profile_version,
      taxonomyVersion: candidate.taxonomy_version,
      candidateScope: { market: candidate.market, offering: candidate.offering, instrument: candidate.instrument },
      targetScope: { market: input.target.market, offering: input.target.offering, instrument: input.target.instrument,
        document_stage: input.target.documentStage, rule_version: input.ruleVersion },
      comparability: candidateV11.comparability, chapterMappingVersionId: matched.selectedChapterMapping?.mapping_version_id ?? null });
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    if (error.code === 'REFERENCE_COMPLETENESS_REVIEW_REQUIRED') {
      const result = snapshotBase({ status: 'needs_review', target: matched.targetValidation.snapshot,
        index_release: response.index_release,
        candidate_decisions: matched.decisions.map(decision => decision.referenceId === candidate.reference_id
          && decision.documentVersion === String(candidate.document_version)
          ? { ...decision, disposition: 'excluded' as const, reason: 'candidate_full_revenue_universe_or_tie_proof_missing' }
          : decision), selected: null, reasons: ['candidate_full_revenue_universe_or_tie_proof_missing'] });
      await adapters.persist(result);
      return result;
    }
    if (error.code !== 'DATA_NOT_ENTITLED') throw error;
    const result = snapshotBase({ status: 'index_version_mismatch', target: matched.targetValidation.snapshot,
      index_release: response.index_release,
      candidate_decisions: matched.decisions.map(decision => decision.referenceId === candidate.reference_id
        && decision.documentVersion === String(candidate.document_version)
        ? { ...decision, disposition: 'excluded' as const, reason: 'candidate_no_longer_selectable_at_lock' }
        : decision), selected: null, reasons: ['reference_candidate_changed_before_lock'] });
    await adapters.persist(result);
    return result;
  }
  const result = snapshotBase({ status: 'exact', target: matched.targetValidation.snapshot, index_release: response.index_release,
    candidate_decisions: matched.decisions, selected: { reference_id: candidate.reference_id,
      document_version_id: candidate.document_version_id, document_version: candidate.document_version,
      profile_id: candidate.profile_id, profile_version: candidate.profile_version, taxonomy_version: candidate.taxonomy_version,
      chapter_mapping_version: matched.selectedChapterMapping?.mapping_version_id ?? null, lock }, reasons: matched.reasons });
  await adapters.persist(result);
  return result;
}

/** Production wiring: lock eligibility is rechecked by the API transaction and the complete trace is durable in the run checkpoint. */
export function createNoHistoryLibrarySelector(pool: Pool, lease: Lease) {
  return (input: NoHistoryLibrarySelectionInput) => selectNoHistoryLibraryReference(input, {
    query: request => queryReferenceLibrary(pool, request),
    lock: lockInput => lockReferenceSelection(pool, { ...lockInput, querySchemaVersion: 'reference-library-query-v1.1' }),
    persist: snapshot => checkpointStage(pool, lease, 'reference_selection', snapshot as unknown as Record<string, unknown>),
  });
}
