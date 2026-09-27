import type { Pool, PoolClient } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { AUTHORIZED_SAMPLE_MANIFEST_SHA256 } from './authorized-sample-membership.generated.js';
import {
  verifyAuthorizedSampleMembership,
  type AuthorizedSampleMembershipFailure,
  type AuthorizedSampleMembershipResult,
  type LockedSampleMaterialRef,
  type PersistedSampleMaterialMetadata,
} from './authorized-sample-membership.js';

type Db = Pick<Pool | PoolClient, 'query'>;

export interface LockedInputMembershipRef {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly inputRevision: number;
  readonly inputHash: string;
}

export type AuthorizedSampleMembershipLoadFailure =
  | 'locked_input_not_found'
  | 'locked_input_hash_mismatch'
  | 'locked_input_manifest_hash_mismatch'
  | 'locked_input_material_manifest_invalid'
  | 'locked_material_reference_set_mismatch'
  | 'locked_material_deleted_or_missing'
  | 'locked_material_state_invalid'
  | AuthorizedSampleMembershipFailure;

export type AuthorizedSampleMembershipLoadResult =
  | Extract<AuthorizedSampleMembershipResult, { accepted: true }>
  | { readonly accepted: false; readonly reason: AuthorizedSampleMembershipLoadFailure };

const invalid = (reason: AuthorizedSampleMembershipLoadFailure): AuthorizedSampleMembershipLoadResult => ({ accepted: false, reason });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pairKey = (id: string, version: number): string => `${id}\u0000${version}`;

function normalizeMaterialReferences(value: unknown): LockedSampleMaterialRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: LockedSampleMaterialRef[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.material_id !== 'string' || item.material_id.length === 0 ||
        !Number.isSafeInteger(item.material_version) || Number(item.material_version) < 1 ||
        typeof item.role !== 'string' || item.role.length === 0 || typeof item.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.sha256.trim().toLowerCase())) return null;
    refs.push({ material_id: item.material_id, material_version: Number(item.material_version),
      role: item.role, sha256: item.sha256.trim().toLowerCase() });
  }
  return refs;
}

function normalizeInputMaterialRefs(value: unknown): Array<{ material_id: string; material_version: number }> | null {
  if (!Array.isArray(value)) return null;
  const refs: Array<{ material_id: string; material_version: number }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.material_id !== 'string' || item.material_id.length === 0 ||
        !Number.isSafeInteger(item.material_version) || Number(item.material_version) < 1) return null;
    refs.push({ material_id: item.material_id, material_version: Number(item.material_version) });
  }
  return refs;
}

const LIVE_MATERIAL_STATES = new Set(['persisted', 'prechecking', 'ready', 'parsing', 'needs_confirmation', 'parsed', 'failed']);

/**
 * Resolve the authorized-sample membership only from an immutable, owner-scoped
 * input revision and its exact live material rows. The caller cannot supply the
 * manifest SHA: this loader always pins the whole tracked sample manifest hash.
 */
export async function loadAuthorizedSampleMembershipFromLockedInput(
  db: Db,
  ref: LockedInputMembershipRef,
): Promise<AuthorizedSampleMembershipLoadResult> {
  if (!ref.ownerUserId || !ref.projectId || !Number.isSafeInteger(ref.inputRevision) || ref.inputRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(ref.inputHash)) return invalid('locked_input_not_found');

  const inputResult = await db.query<{ input_hash: string; manifest: unknown; material_versions: unknown }>(
    `SELECT input_hash, manifest, material_versions
       FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
    [ref.ownerUserId, ref.projectId, ref.inputRevision],
  );
  const input = inputResult.rows[0];
  if (!input) return invalid('locked_input_not_found');
  if (String(input.input_hash).trim() !== ref.inputHash) return invalid('locked_input_hash_mismatch');
  if (!isRecord(input.manifest) || !Array.isArray(input.manifest.materials)) return invalid('locked_input_material_manifest_invalid');
  if (inputManifestHash(input.manifest) !== ref.inputHash) return invalid('locked_input_manifest_hash_mismatch');

  const lockedMaterials = normalizeMaterialReferences(input.manifest.materials);
  const revisionMaterials = normalizeInputMaterialRefs(input.material_versions);
  if (!lockedMaterials || !revisionMaterials) return invalid('locked_input_material_manifest_invalid');

  const manifestKeys = lockedMaterials.map(item => pairKey(item.material_id, item.material_version));
  const revisionKeys = revisionMaterials.map(item => pairKey(item.material_id, item.material_version));
  if (new Set(manifestKeys).size !== manifestKeys.length || new Set(lockedMaterials.map(item => item.material_id)).size !== lockedMaterials.length ||
      new Set(revisionKeys).size !== revisionKeys.length || new Set(revisionMaterials.map(item => item.material_id)).size !== revisionMaterials.length ||
      manifestKeys.length !== revisionKeys.length || manifestKeys.some(key => !revisionKeys.includes(key))) {
    return invalid('locked_material_reference_set_mismatch');
  }

  const persistedMaterials: PersistedSampleMaterialMetadata[] = [];
  for (const item of lockedMaterials) {
    const materialResult = await db.query<{
      owner_user_id: string; project_id: string; id: string; version: number;
      role: string; sha256: string; state: string;
    }>(
      `SELECT owner_user_id, project_id, id, version, role, sha256, state
         FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL
        FOR SHARE`,
      [ref.ownerUserId, ref.projectId, item.material_id, item.material_version],
    );
    const material = materialResult.rows[0];
    if (!material) return invalid('locked_material_deleted_or_missing');
    if (!LIVE_MATERIAL_STATES.has(material.state)) return invalid('locked_material_state_invalid');
    persistedMaterials.push({ owner_user_id: material.owner_user_id, project_id: material.project_id,
      id: material.id, version: Number(material.version), role: material.role, sha256: String(material.sha256).trim().toLowerCase() });
  }

  return verifyAuthorizedSampleMembership({ ownerUserId: ref.ownerUserId, projectId: ref.projectId,
    lockedMaterials, persistedMaterials, grantManifestSha256: AUTHORIZED_SAMPLE_MANIFEST_SHA256 });
}
