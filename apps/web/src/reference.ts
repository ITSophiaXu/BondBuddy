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
 * Resolves the owner-visible parse snapshot id for a saved reference material. The browser cannot
 * infer it: it is a server-generated identifier over the immutable material bytes. This seam must be
 * backed by an owner-scoped parse-snapshot read before a reference can be pinned; when absent, the
 * generation path runs without a user reference rather than guessing an id or bypassing the review.
 */
export type ReferenceSnapshotResolver = (projectId: string, material: Material) => Promise<string | undefined>;
