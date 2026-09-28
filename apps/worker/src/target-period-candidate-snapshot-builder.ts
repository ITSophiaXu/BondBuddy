import { createHash } from 'node:crypto';
import {
  canonicalTargetPeriodCandidateSnapshotContent,
  validTargetPeriodCandidateSnapshot,
  type TargetPeriodCandidateSnapshot,
} from '@bondbuddy/contracts';
import type {
  LockedFinancialMaterialRef,
  TargetPeriodCandidateSet,
  TargetPeriodCandidateSnapshotPin,
} from './target-period-candidates.js';

export type VersionedSupplementalRequirementsPin = TargetPeriodCandidateSnapshot['content']['supplemental_requirements'];

export type BuildTargetPeriodCandidateSnapshotInput = {
  readonly candidate_set: TargetPeriodCandidateSet;
  readonly candidate_set_id: string;
  readonly candidate_set_version: number;
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly project_draft_revision: number;
  /** Authoritative draft cutoff and material lock resolved by the caller, not taken from browser input. */
  readonly reporting_cutoff: string;
  readonly locked_materials: readonly LockedFinancialMaterialRef[];
  readonly supplemental_requirements: VersionedSupplementalRequirementsPin;
};

function fail(code: string): Error { return new Error(code); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_INVALID');
  return json;
}
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function cmp(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function evidenceKey(value: { readonly snapshot_id: string; readonly record_id: string }): string {
  return `${value.snapshot_id}\0${value.record_id}`;
}

function sourceState(pin: TargetPeriodCandidateSnapshotPin): 'available' | 'needs_confirmation' | 'failed' | 'partial_coverage' {
  if (pin.method === 'native_text') {
    if (pin.status === 'parsed') return 'available';
    if (pin.status === 'needs_confirmation') return 'needs_confirmation';
    if (pin.status === 'failed') return 'failed';
    throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STATUS_INVALID');
  }
  if (pin.status === 'needs_confirmation:partial') return 'partial_coverage';
  if (pin.status === 'needs_confirmation:complete') return 'needs_confirmation';
  throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STATUS_INVALID');
}

function sourceSnapshots(pins: readonly TargetPeriodCandidateSnapshotPin[]): TargetPeriodCandidateSnapshot['content']['source_snapshots'] {
  const ids = new Set<string>();
  return [...pins].sort((a, b) => cmp(a.snapshot_id, b.snapshot_id)).map(pin => {
    if (ids.has(pin.snapshot_id)) throw fail('TARGET_PERIOD_CANDIDATE_DUPLICATE_SOURCE');
    ids.add(pin.snapshot_id);
    const recordIds = pin.evidence_records.map(item => item.record_id);
    if (new Set(recordIds).size !== recordIds.length) throw fail('TARGET_PERIOD_CANDIDATE_DUPLICATE_SOURCE_RECORD');
    return {
      evidence_method: pin.method,
      snapshot_id: pin.snapshot_id,
      material_id: pin.material_id,
      material_version: pin.material_version,
      material_sha256: pin.material_sha256,
      parser_version: pin.parser_version,
      response_sha256: pin.response_sha256,
      source_state: sourceState(pin),
      record_pins: [...pin.evidence_records].sort((a, b) => cmp(a.record_id, b.record_id))
        .map(item => ({ record_id: item.record_id, record_sha256: item.record_sha256 })),
      page_image_pins: [...(pin.page_image_sha256s ?? [])].sort((a, b) => a.page - b.page)
        .map(item => ({ page: item.page, image_sha256: item.sha256 })),
    };
  });
}

/**
 * Adapts the pure extractor output into the versioned contract. It consumes only
 * server-resolved identity/material/cutoff/requirement pins and never confirms a
 * candidate or derives target intent.
 */
export function buildTargetPeriodCandidateSnapshot(input: BuildTargetPeriodCandidateSnapshotInput): TargetPeriodCandidateSnapshot {
  const proposal = input.candidate_set;
  if (proposal.reporting_cutoff !== input.reporting_cutoff) throw fail('TARGET_PERIOD_CANDIDATE_CUTOFF_DRIFT');

  const expectedMaterials = [...proposal.locked_material_pins].sort((a, b) => cmp(a.material_id, b.material_id));
  const lockedMaterials = [...input.locked_materials].sort((a, b) => cmp(a.material_id, b.material_id));
  if (expectedMaterials.length !== lockedMaterials.length ||
      new Set(expectedMaterials.map(item => item.material_id)).size !== expectedMaterials.length ||
      canonical(expectedMaterials) !== canonical(lockedMaterials)) throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_DRIFT');

  const sources = sourceSnapshots(proposal.source_snapshot_pins);
  const sourceById = new Map(proposal.source_snapshot_pins.map(pin => [pin.snapshot_id, pin]));
  const evidenceRecords = new Map<string, TargetPeriodCandidateSnapshot['content']['evidence_records'][number]>();
  const candidates = proposal.candidates.map(candidate => {
    const evidenceRefs = candidate.evidence.map(ref => {
      const source = sourceById.get(ref.snapshot_id);
      if (!source || source.method !== ref.evidence_method || source.material_id !== ref.material_id ||
          source.material_version !== ref.material_version || source.material_sha256 !== ref.material_sha256 ||
          source.parser_version !== ref.parser_version || source.response_sha256 !== ref.response_sha256) {
        throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_SOURCE_MISMATCH');
      }
      const recordPin = source.evidence_records.find(item => item.record_id === ref.record_id);
      if (!recordPin || recordPin.record_sha256 !== ref.record_sha256) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_RECORD_MISMATCH');
      if (source.method === 'ocr') {
        const pagePin = source.page_image_sha256s?.find(item => item.page === ref.page);
        if (ref.page === undefined || ref.page_image_sha256 === undefined || pagePin?.sha256 !== ref.page_image_sha256) {
          throw fail('TARGET_PERIOD_CANDIDATE_OCR_PAGE_MISMATCH');
        }
      } else if (ref.page !== undefined || ref.page_image_sha256 !== undefined) {
        throw fail('TARGET_PERIOD_CANDIDATE_NATIVE_PAGE_INVALID');
      }

      const key = evidenceKey(ref);
      const evidenceRecord = {
        snapshot_id: ref.snapshot_id,
        record_id: ref.record_id,
        record_sha256: ref.record_sha256,
        quote: ref.quote,
        context: ref.context,
        locator: ref.locator,
        uncertainty: [...ref.uncertainty],
        ...(ref.page === undefined ? {} : { page: ref.page }),
        ...(ref.page_image_sha256 === undefined ? {} : { page_image_sha256: ref.page_image_sha256 }),
      };
      const previous = evidenceRecords.get(key);
      if (previous && canonical(previous) !== canonical(evidenceRecord)) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_RECORD_CONFLICT');
      evidenceRecords.set(key, evidenceRecord);
      return { snapshot_id: ref.snapshot_id, record_id: ref.record_id };
    }).sort((a, b) => cmp(evidenceKey(a), evidenceKey(b)));

    const anchors = candidate.anchors.map(anchor => anchor.kind === 'period_end'
      ? { kind: 'period_end' as const, snapshot_id: anchor.evidence.snapshot_id,
        record_id: anchor.evidence.record_id, raw_period_token: anchor.raw_period_token }
      : { kind: anchor.kind, snapshot_id: anchor.evidence.snapshot_id, record_id: anchor.evidence.record_id })
      .sort((a, b) => cmp(`${a.kind}\0${evidenceKey(a)}`, `${b.kind}\0${evidenceKey(b)}`));

    return {
      start: candidate.start,
      end: candidate.end,
      period_kind: candidate.period_kind,
      scope: candidate.scope,
      raw_value: candidate.raw_value,
      status: 'needs_confirmation' as const,
      cutoff_relation: candidate.cutoff_relation,
      evidence_refs: evidenceRefs,
      anchors,
      pending_reasons: [...candidate.pending_reasons].sort(),
    };
  }).sort((a, b) => cmp(canonical([a.end ?? '', a.start ?? '', a.scope ?? '', a.period_kind ?? '']),
    canonical([b.end ?? '', b.start ?? '', b.scope ?? '', b.period_kind ?? ''])));

  const content: TargetPeriodCandidateSnapshot['content'] = {
    schema_version: 'target-period-candidate-snapshot-v1',
    hash_domain: 'bondbuddy:target-period-candidate-snapshot:v1',
    canonicalization: 'utf8-json-sorted-object-keys-preserve-declared-array-order-v1',
    owner_user_id: input.owner_user_id,
    project_id: input.project_id,
    project_draft_revision: input.project_draft_revision,
    reporting_cutoff: input.reporting_cutoff,
    supplemental_requirements: {
      version: input.supplemental_requirements.version,
      content_sha256: input.supplemental_requirements.content_sha256,
      message_ids: [...input.supplemental_requirements.message_ids].sort(),
    },
    financial_materials: lockedMaterials.map(item => ({
      material_id: item.material_id,
      material_version: item.material_version,
      material_sha256: item.material_sha256,
      role: item.role,
    }) as TargetPeriodCandidateSnapshot['content']['financial_materials'][number]),
    source_snapshots: sources,
    evidence_records: [...evidenceRecords.values()].sort((a, b) => cmp(evidenceKey(a), evidenceKey(b))),
    status: 'needs_confirmation',
    completeness: 'not_determined',
    candidates,
    source_warnings: [...proposal.source_warnings].sort(),
    pending_reasons: [...proposal.pending_reasons].sort(),
  };

  const snapshot: TargetPeriodCandidateSnapshot = {
    candidate_set_id: input.candidate_set_id,
    candidate_set_version: input.candidate_set_version,
    content_sha256: '0'.repeat(64),
    content,
  };
  if (!validTargetPeriodCandidateSnapshot(snapshot)) throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_INVALID');
  const contentHash = sha256(canonicalTargetPeriodCandidateSnapshotContent(snapshot));
  const result = { ...snapshot, content_sha256: contentHash };
  if (!validTargetPeriodCandidateSnapshot(result) ||
      sha256(canonicalTargetPeriodCandidateSnapshotContent(result)) !== result.content_sha256) {
    throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_SELF_CHECK_FAILED');
  }
  return result;
}
