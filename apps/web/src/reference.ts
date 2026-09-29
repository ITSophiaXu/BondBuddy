import type { Material, Offering } from '@bondbuddy/contracts';
import type { Dto } from './api.js';

export type UserReferenceChoice = NonNullable<Dto<'InputRevisionCreateRequest'>['user_reference']>;

/** The browser drafts the issuance-stage prospectus; registration-stage documents are not produced here. */
export const TARGET_DOCUMENT_STAGE = 'issuance';

/**
 * Pins a user-selected similar-issuer prospectus as a structural reference. Only structure crosses
 * this boundary: the backend keeps the reference's own facts, amounts and names out of the draft.
 * The target market is the project scope the backend re-derives; the browser only asserts the
 * offering (product) and the issuance document stage.
 * `parse_snapshot_id` must come from the owner-visible parse snapshot of this exact material version.
 */
export function userReferenceChoice(reference: Material, parseSnapshotId: string, offering: Offering): UserReferenceChoice {
  return {
    material_id: reference.material_id,
    material_version: reference.material_version,
    material_sha256: reference.sha256,
    parse_snapshot_id: parseSnapshotId,
    target_product: offering,
    target_document_stage: TARGET_DOCUMENT_STAGE,
  };
}

/** A similar-issuer reference is only selected when the project declares no in-issuer history. */
export function selectedReference(materials: readonly Material[], hasHistorical: boolean | null | undefined): Material | undefined {
  if (hasHistorical !== false) return undefined;
  return materials.find(material => material.role === 'reference');
}

/**
 * Forward-compatible read of an additive owner-visible parse snapshot id on the material. The
 * current contract does not carry it, so only a well-formed value is accepted; otherwise the
 * reference is left unpinned rather than guessing a snapshot.
 */
export function materialParseSnapshotId(material: Material): string | undefined {
  const value = (material as { parse_snapshot_id?: unknown }).parse_snapshot_id;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * The re-read only counts when it is still the exact material version that was selected. A version
 * bump between listing and submission must not be combined with a snapshot from the new version.
 */
export function sameMaterialVersion(selected: Material, fresh: Material): boolean {
  return selected.material_id === fresh.material_id
    && selected.material_version === fresh.material_version
    && selected.sha256 === fresh.sha256;
}

/**
 * Decides the user reference pin from a fresh owner-scoped read taken right before submission. The
 * read can be a newer version than the selected list entry, so its identity is re-checked. A changed
 * version or an unfinished parse keeps the run unpinned (safe stop) and tells the user how to
 * recover; a mixed pin (old version/hash + new snapshot) is never submitted.
 */
export function referencePin(selected: Material, fresh: Material, offering: Offering): { choice: UserReferenceChoice } | { note: string } {
  if (!sameMaterialVersion(selected, fresh)) {
    return { note: '用户指定参考稿在提交前已更新为新的版本，本次先按未指定参考提交；请刷新已保存材料并重新选择参考稿后再提交。' };
  }
  const parseSnapshotId = materialParseSnapshotId(fresh);
  if (!parseSnapshotId) return { note: '用户指定参考稿的解析快照尚未就绪，本次先按未指定参考提交。' };
  return { choice: userReferenceChoice(fresh, parseSnapshotId, offering) };
}

/** The owner-scoped material read used to re-check the current parse snapshot at pin time. */
export type MaterialReader = (projectId: string, materialId: string) => Promise<Material>;

/**
 * Re-reads the owner-visible material for a saved reference. The browser cannot infer the snapshot
 * id: it is a server-generated identifier over the immutable material bytes, and the recovered list
 * can predate a completed parse or a new version. This seam returns the freshly read material so the
 * caller can re-check its identity before pinning a snapshot; a failed read stays unpinned rather
 * than guessing an id or bypassing the review.
 */
export type ReferenceSnapshotResolver = (projectId: string, material: Material) => Promise<Material>;

export function referenceSnapshotResolver(reader: MaterialReader): ReferenceSnapshotResolver {
  return (projectId, material) => reader(projectId, material.material_id);
}
