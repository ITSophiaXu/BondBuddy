import {
  AUTHORIZED_SAMPLE_CASE_FILES,
  AUTHORIZED_SAMPLE_MANIFEST_SHA256,
} from './authorized-sample-membership.generated.js';

export interface LockedSampleMaterialRef {
  readonly material_id: string;
  readonly material_version: number;
  readonly role: string;
  readonly sha256: string;
}

export interface PersistedSampleMaterialMetadata {
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly id: string;
  readonly version: number;
  readonly role: string;
  readonly sha256: string;
}

export interface AuthorizedSampleMembershipInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly lockedMaterials: readonly LockedSampleMaterialRef[];
  readonly persistedMaterials: readonly PersistedSampleMaterialMetadata[];
  readonly grantManifestSha256: string;
}

export interface AuthorizedSampleGap {
  readonly fileId: string;
  readonly role: string;
  readonly reason: 'authorized_sample_material_not_locked';
}

export type AuthorizedSampleMembershipFailure =
  | 'manifest_hash_mismatch'
  | 'locked_materials_empty'
  | 'invalid_material_reference'
  | 'duplicate_locked_material'
  | 'duplicate_persisted_material'
  | 'persisted_material_set_mismatch'
  | 'material_owner_mismatch'
  | 'material_project_mismatch'
  | 'material_version_mismatch'
  | 'material_role_mismatch'
  | 'material_hash_mismatch'
  | 'sample_material_unknown'
  | 'sample_material_role_mismatch'
  | 'sample_material_hash_mismatch'
  | 'sample_material_ambiguous'
  | 'duplicate_sample_material'
  | 'mixed_sample_cases'
  | 'historical_material_required'
  | 'financial_material_required';

export type AuthorizedSampleMembershipResult =
  | { readonly accepted: true; readonly caseId: string; readonly gaps: readonly AuthorizedSampleGap[] }
  | { readonly accepted: false; readonly reason: AuthorizedSampleMembershipFailure };

const FINANCIAL_SAMPLE_ROLES = new Set(['audit', 'financial', 'interimFinancial', 'notes']);
const invalid = (reason: AuthorizedSampleMembershipFailure): AuthorizedSampleMembershipResult => ({ accepted: false, reason });
const pairKey = (id: string, version: number): string => `${id}\u0000${version}`;

/**
 * Verifies that a locked material set is an authorized same-case subset and that
 * every locked reference resolves to the exact owner/project/version/role/hash
 * row persisted by the database. This is a membership check, not grant creation.
 */
export function verifyAuthorizedSampleMembership(
  input: AuthorizedSampleMembershipInput,
): AuthorizedSampleMembershipResult {
  if (input.grantManifestSha256 !== AUTHORIZED_SAMPLE_MANIFEST_SHA256) return invalid('manifest_hash_mismatch');
  if (input.lockedMaterials.length === 0) return invalid('locked_materials_empty');

  const lockedById = new Map<string, LockedSampleMaterialRef>();
  const lockedKeys = new Set<string>();
  for (const ref of input.lockedMaterials) {
    if (!ref.material_id || !Number.isSafeInteger(ref.material_version) || ref.material_version < 1 ||
      !ref.role || !/^[a-f0-9]{64}$/.test(ref.sha256)) return invalid('invalid_material_reference');
    const key = pairKey(ref.material_id, ref.material_version);
    if (lockedKeys.has(key) || lockedById.has(ref.material_id)) return invalid('duplicate_locked_material');
    lockedKeys.add(key);
    lockedById.set(ref.material_id, ref);
  }

  const persistedByKey = new Map<string, PersistedSampleMaterialMetadata>();
  for (const row of input.persistedMaterials) {
    const key = pairKey(row.id, row.version);
    if (persistedByKey.has(key)) return invalid('duplicate_persisted_material');
    persistedByKey.set(key, row);
  }
  if (persistedByKey.size !== lockedKeys.size) return invalid('persisted_material_set_mismatch');

  const matchedFiles: typeof AUTHORIZED_SAMPLE_CASE_FILES[number][] = [];
  for (const ref of input.lockedMaterials) {
    const row = persistedByKey.get(pairKey(ref.material_id, ref.material_version));
    if (!row) return invalid('persisted_material_set_mismatch');
    if (row.owner_user_id !== input.ownerUserId) return invalid('material_owner_mismatch');
    if (row.project_id !== input.projectId) return invalid('material_project_mismatch');
    if (row.id !== ref.material_id || row.version !== ref.material_version) return invalid('material_version_mismatch');
    if (row.role !== ref.role) return invalid('material_role_mismatch');
    if (row.sha256 !== ref.sha256) return invalid('material_hash_mismatch');

    const roleMatches = AUTHORIZED_SAMPLE_CASE_FILES.filter(file => file.uploadRole === ref.role);
    const exactMatches = roleMatches.filter(file => file.sha256 === ref.sha256);
    if (exactMatches.length === 0) {
      if (AUTHORIZED_SAMPLE_CASE_FILES.some(file => file.sha256 === ref.sha256)) return invalid('sample_material_role_mismatch');
      if (roleMatches.length > 0) return invalid('sample_material_hash_mismatch');
      return invalid('sample_material_unknown');
    }
    if (exactMatches.length > 1) return invalid('sample_material_ambiguous');
    matchedFiles.push(exactMatches[0]!);
  }

  const caseIds = new Set(matchedFiles.map(file => file.caseId));
  if (caseIds.size !== 1) return invalid('mixed_sample_cases');
  const caseId = matchedFiles[0]!.caseId;
  const fileIds = new Set(matchedFiles.map(file => file.fileId));
  if (fileIds.size !== matchedFiles.length) return invalid('duplicate_sample_material');
  if (!matchedFiles.some(file => file.uploadRole === 'historical')) return invalid('historical_material_required');
  if (!matchedFiles.some(file => FINANCIAL_SAMPLE_ROLES.has(file.uploadRole))) return invalid('financial_material_required');

  const gaps = AUTHORIZED_SAMPLE_CASE_FILES
    .filter(file => file.caseId === caseId && !fileIds.has(file.fileId))
    .map(file => ({ fileId: file.fileId, role: file.uploadRole, reason: 'authorized_sample_material_not_locked' as const }))
    .sort((a, b) => a.fileId.localeCompare(b.fileId));
  return { accepted: true, caseId, gaps };
}
