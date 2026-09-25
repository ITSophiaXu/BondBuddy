import type { VerifiedIssuerIdentitySourceRecord } from './issuer-identity-source.js';

export type HistoricalMaterialReference = {
  material_id: string;
  material_version: number;
};

/** Internal immutable binding embedded in an input revision manifest. */
export type VerifiedIssuerIdentityBinding = {
  status: 'verified';
  record_id: string;
  version: number;
  content_hash: string;
  entity_id: string;
  issuer_display_name: string;
  material_id: string;
  material_version: number;
  source_snapshot_id: string;
  source_record_id: string;
  source_record_sha256: string;
  source_content_sha256: string;
  reviewed_by: string;
  reviewed_at: string;
};

export type PendingIssuerIdentityBinding = {
  status: 'pending';
  reason: string;
  historical_materials: HistoricalMaterialReference[];
};

export type IssuerIdentityBinding = VerifiedIssuerIdentityBinding | PendingIssuerIdentityBinding;

export function verifiedIssuerIdentityBinding(record: VerifiedIssuerIdentitySourceRecord): VerifiedIssuerIdentityBinding {
  return {
    status: 'verified', record_id: record.recordId, version: record.version, content_hash: record.contentHash,
    entity_id: record.entityId, issuer_display_name: record.issuerDisplayName,
    material_id: record.materialId, material_version: record.materialVersion,
    source_snapshot_id: record.sourceSnapshotId, source_record_id: record.sourceRecordId,
    source_record_sha256: record.sourceRecordSha256, source_content_sha256: record.sourceContentSha256,
    reviewed_by: record.reviewedBy, reviewed_at: record.reviewedAt,
  };
}

export function pendingIssuerIdentityBinding(
  reason: string,
  historicalMaterials: readonly HistoricalMaterialReference[],
): PendingIssuerIdentityBinding {
  return {
    status: 'pending', reason,
    historical_materials: historicalMaterials.map(({ material_id, material_version }) => ({ material_id, material_version })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function isVerifiedIssuerIdentityBinding(value: unknown): value is VerifiedIssuerIdentityBinding {
  return isRecord(value) && value.status === 'verified' &&
    typeof value.record_id === 'string' && value.record_id.length > 0 &&
    Number.isSafeInteger(value.version) && Number(value.version) > 0 && isSha256(value.content_hash) &&
    typeof value.entity_id === 'string' && value.entity_id.length > 0 &&
    typeof value.issuer_display_name === 'string' && value.issuer_display_name.length > 0 &&
    typeof value.material_id === 'string' && value.material_id.length > 0 &&
    Number.isSafeInteger(value.material_version) && Number(value.material_version) > 0 &&
    typeof value.source_snapshot_id === 'string' && value.source_snapshot_id.length > 0 &&
    typeof value.source_record_id === 'string' && value.source_record_id.length > 0 &&
    isSha256(value.source_record_sha256) && isSha256(value.source_content_sha256) &&
    typeof value.reviewed_by === 'string' && value.reviewed_by.length > 0 &&
    typeof value.reviewed_at === 'string' && !Number.isNaN(Date.parse(value.reviewed_at));
}

/** Compare the manifest pin with the current #15 loader result, including its exact evidence anchors. */
export function issuerIdentityBindingMatches(
  binding: VerifiedIssuerIdentityBinding,
  record: VerifiedIssuerIdentitySourceRecord,
): boolean {
  const current = verifiedIssuerIdentityBinding(record);
  return binding.record_id === current.record_id && binding.version === current.version &&
    binding.content_hash === current.content_hash && binding.entity_id === current.entity_id &&
    binding.issuer_display_name === current.issuer_display_name && binding.material_id === current.material_id &&
    binding.material_version === current.material_version && binding.source_snapshot_id === current.source_snapshot_id &&
    binding.source_record_id === current.source_record_id && binding.source_record_sha256 === current.source_record_sha256 &&
    binding.source_content_sha256 === current.source_content_sha256 && binding.reviewed_by === current.reviewed_by &&
    binding.reviewed_at === current.reviewed_at;
}
