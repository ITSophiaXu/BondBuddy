/**
 * #33 locked-input consumption for the trusted generation issuer binding.
 *
 * The worker never selects a binding and never derives the legal issuer from a browser name, a
 * reference document or the annual business profile. The only source of identity is the
 * `generation_issuer_binding_ref` already pinned into the immutable input manifest by the #17
 * input-lock transaction, re-verified through the trusted binding read against its own locked
 * input (materials, latest parse, identity reviews, grants and append-only review history). The
 * worker additionally requires the binding's selected issuer materials to equal this run's locked
 * issuer materials, so a re-materialised input stays fail closed. A missing, malformed, stale,
 * withdrawn, re-materialised, re-parsed, cross-account or conflicting pin returns null so the
 * caller stays fail-closed at `issuer_identity_not_bound`.
 */
import type { Pool } from 'pg';
import {
  GENERATION_ISSUER_MATERIAL_ROLES,
  VERIFIED_ISSUER_ENTITY_PATTERN,
  type GenerationIssuerBindingRef,
  type GenerationIssuerBindingResponse,
} from '@bondbuddy/contracts';
import { loadApprovedGenerationIssuerBindingForLock } from '@bondbuddy/api/generation-issuer-binding';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type {
  ApprovedGenerationIssuerBinding,
  NoHistoryRunScope,
} from './no-history-model-stage.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const entityPattern = new RegExp(VERIFIED_ISSUER_ENTITY_PATTERN);
const ISSUER_ROLES: ReadonlySet<string> = new Set(GENERATION_ISSUER_MATERIAL_ROLES);

type MaterialPin = GenerationIssuerBindingResponse['selected_materials'][number];
type PinnedRef = { readonly ref: GenerationIssuerBindingRef; readonly issuerEntityId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the exact pinned ref plus the approved entity from a locked manifest. Missing fields, a
 * free-form id, a non-positive/unsafe version, a non-canonical hash or a malformed entity all
 * yield null so a half-written or hand-edited manifest cannot authorize a run.
 */
export function pinnedGenerationIssuerBindingRef(manifest: unknown): PinnedRef | null {
  if (!isRecord(manifest)) return null;
  const raw = manifest.generation_issuer_binding_ref;
  const entityId = manifest.generation_issuer_entity_id;
  if (!isRecord(raw)) return null;
  if (typeof raw.binding_id !== 'string' || !idPattern.test(raw.binding_id)) return null;
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return null;
  if (typeof raw.content_sha256 !== 'string' || !shaPattern.test(raw.content_sha256)) return null;
  if (typeof entityId !== 'string' || !entityPattern.test(entityId)) return null;
  return {
    ref: {
      binding_id: raw.binding_id,
      version: raw.version as number,
      content_sha256: raw.content_sha256,
    },
    issuerEntityId: entityId,
  };
}

function materialKey(item: {
  material_id: string;
  material_version: number;
  role: string;
  sha256: string;
}): string {
  return `${item.material_id}\u0000${item.material_version}\u0000${item.role}\u0000${item.sha256}`;
}

/**
 * The pinned binding must describe exactly the issuer-role materials of this locked input, with
 * the same id/version/role/hash. An added, removed or swapped issuer material (or a binding that
 * covered extra non-selected files) is a conflict and never authorizes generation.
 */
export function lockedIssuerMaterialsMatch(
  manifest: unknown,
  selected: readonly MaterialPin[],
): boolean {
  if (!isRecord(manifest) || !Array.isArray(manifest.materials)) return false;
  const locked: string[] = [];
  for (const item of manifest.materials) {
    if (!isRecord(item)) return false;
    if (typeof item.role !== 'string' || !ISSUER_ROLES.has(item.role)) continue;
    if (
      typeof item.material_id !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !Number.isSafeInteger(item.material_version) ||
      (item.material_version as number) < 1
    )
      return false;
    locked.push(
      materialKey({
        material_id: item.material_id,
        material_version: item.material_version as number,
        role: item.role,
        sha256: item.sha256,
      }),
    );
  }
  const pinned = selected.map((pin) =>
    materialKey({
      material_id: pin.material_id,
      material_version: pin.material_version,
      role: pin.role,
      sha256: pin.material_sha256,
    }),
  );
  if (locked.length !== pinned.length || locked.length === 0) return false;
  locked.sort();
  pinned.sort();
  return locked.every((value, index) => value === pinned[index]);
}

/** Trusted re-verification of an already-pinned ref; injectable only for tests/tooling. */
export type VerifyPinnedBinding = (
  ref: GenerationIssuerBindingRef,
) => Promise<GenerationIssuerBindingResponse | null>;

/**
 * Default trusted worker loader for `NoHistoryStageAdapters.loadApprovedIssuerBinding`. Reads the
 * pinned ref from the immutable input revision, requires the stored hash to match the run scope and
 * the canonical manifest hash, then re-verifies the exact ref through the trusted #33 read against
 * the binding's own locked input. Every failure returns null; there is no latest-binding fallback
 * and no browser-name fallback.
 */
export async function loadPinnedApprovedGenerationIssuerBinding(
  pool: Pick<Pool, 'query'>,
  scope: NoHistoryRunScope,
  verify?: VerifyPinnedBinding,
): Promise<ApprovedGenerationIssuerBinding | null> {
  const inputHash = scope.inputHash.trim();
  if (!shaPattern.test(inputHash)) return null;
  try {
    const input = (
      await pool.query(
        `SELECT manifest,input_hash FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
        [scope.ownerUserId, scope.projectId, scope.inputRevision],
      )
    ).rows[0];
    if (!isRecord(input) || String(input.input_hash).trim() !== inputHash) return null;
    if (inputManifestHash(input.manifest) !== inputHash) return null;
    const pinned = pinnedGenerationIssuerBindingRef(input.manifest);
    if (!pinned) return null;
    const binding = await (verify
      ? verify(pinned.ref)
      : loadApprovedGenerationIssuerBindingForLock(
          pool,
          { ownerUserId: scope.ownerUserId, projectId: scope.projectId },
          pinned.ref,
        ));
    if (
      !binding ||
      binding.status !== 'approved' ||
      !binding.issuer_entity_id ||
      binding.issuer_entity_id !== pinned.issuerEntityId ||
      binding.binding_id !== pinned.ref.binding_id ||
      binding.version !== pinned.ref.version ||
      binding.content_sha256 !== pinned.ref.content_sha256 ||
      binding.owner_user_id !== scope.ownerUserId ||
      binding.project_id !== scope.projectId ||
      !lockedIssuerMaterialsMatch(input.manifest, binding.selected_materials)
    )
      return null;
    const approval = binding.review_events[binding.review_events.length - 1];
    if (
      !approval ||
      approval.action !== 'approve' ||
      !approval.review_id.trim() ||
      !approval.reviewed_at.trim() ||
      !Number.isSafeInteger(approval.binding_version) ||
      approval.binding_version !== binding.version ||
      approval.binding_content_sha256 !== binding.content_sha256
    )
      return null;
    return {
      ownerUserId: scope.ownerUserId,
      projectId: scope.projectId,
      runId: scope.runId,
      inputRevision: scope.inputRevision,
      inputHash,
      bindingId: binding.binding_id,
      version: binding.version,
      contentSha256: binding.content_sha256,
      issuerEntityId: binding.issuer_entity_id,
      reviewEventId: approval.review_id,
      reviewedAt: approval.reviewed_at,
    };
  } catch {
    return null;
  }
}
