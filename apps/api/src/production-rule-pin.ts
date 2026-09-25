import type { Pool, PoolClient } from 'pg';
import { revalidateProductionRulePackPin, selectProductionRulePack, type ProductionRulePackApplicabilityContext,
  type ProductionRulePackPin, type ProductionRulePackRequest } from '@bondbuddy/rule-pack-registry';
import { digest } from './data.js';
import { isVerifiedIssuerIdentityBinding, type VerifiedIssuerIdentityBinding } from './issuer-identity-binding.js';

type Db = Pick<Pool | PoolClient, 'query'>;
export type RuleApplicabilityContextRef = {
  context_id: string; version: number; content_hash: string;
  source_input_revision: number; source_input_hash: string;
};
export type ReviewedContextArgs = {
  ownerUserId: string; projectId: string; contextId: string; version: number; contentHash: string;
  expectedSourceInputRevision: number; expectedSourceInputHash: string;
  expectedIssuerBinding: VerifiedIssuerIdentityBinding;
};
export type ReviewedContextResult =
  | { request: ProductionRulePackRequest; contextPin: Record<string, unknown> }
  | { status: 'needs_review'; reasons: string[] };
/** #15/#19 owns implementation and review semantics. No loader is installed in production yet. */
export type ReviewedContextLoader = (db: Db, args: ReviewedContextArgs) => Promise<ReviewedContextResult>;
export type RulePackBinding =
  | { status: 'blocked'; reasons: string[] }
  | { status: 'selected'; pin: ProductionRulePackPin; applicability: { ref: RuleApplicabilityContextRef; contextPin: Record<string, unknown> } };
export type LockedRuleSource = { draftRevision: number; materials: readonly { material_id: string; material_version: number; role: string; sha256: string }[] };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function canonicalInputManifest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInputManifest).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalInputManifest(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const inputManifestHash = (manifest: unknown) => digest(canonicalInputManifest(manifest));
export const validContextRef = (ref: unknown): ref is RuleApplicabilityContextRef =>
  isRecord(ref) && typeof ref.context_id === 'string' && ref.context_id.length > 0 &&
  Number.isSafeInteger(ref.version) && Number(ref.version) > 0 &&
  typeof ref.content_hash === 'string' && /^[a-f0-9]{64}$/.test(ref.content_hash) &&
  Number.isSafeInteger(ref.source_input_revision) && Number(ref.source_input_revision) > 0 &&
  typeof ref.source_input_hash === 'string' && /^[a-f0-9]{64}$/.test(ref.source_input_hash);

function normalizedMaterials(value: unknown): { material_id: string; material_version: number; role: string; sha256: string }[] | null {
  if (!Array.isArray(value)) return null;
  const materials = value.map(item => {
    if (!isRecord(item) || typeof item.material_id !== 'string' || !item.material_id ||
        !Number.isSafeInteger(item.material_version) || Number(item.material_version) < 1 ||
        typeof item.role !== 'string' || !item.role || typeof item.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.sha256.trim())) return null;
    return { material_id: item.material_id, material_version: item.material_version as number,
      role: item.role, sha256: item.sha256.trim() };
  });
  if (materials.some(item => item === null)) return null;
  const sorted = (materials as NonNullable<typeof materials[number]>[])
    .sort((a, b) => a.material_id.localeCompare(b.material_id) || a.material_version - b.material_version);
  if (new Set(sorted.map(item => item.material_id)).size !== sorted.length) return null;
  return sorted;
}

function normalizedRefs(value: unknown): { material_id: string; material_version: number }[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.map(item => isRecord(item) && typeof item.material_id === 'string' && item.material_id &&
    Number.isSafeInteger(item.material_version) && Number(item.material_version) > 0
    ? { material_id: item.material_id, material_version: item.material_version as number } : null);
  if (refs.some(item => item === null)) return null;
  return (refs as NonNullable<typeof refs[number]>[])
    .sort((a, b) => a.material_id.localeCompare(b.material_id) || a.material_version - b.material_version);
}

/** The reviewed context's source revision must describe the exact new draft/material lock. */
export async function verifyRuleApplicabilitySourceLock(db: Db, owner: string, projectId: string,
  ref: RuleApplicabilityContextRef, current: LockedRuleSource): Promise<string | null> {
  const rows = await db.query(`SELECT input_hash,draft_revision,manifest,material_versions FROM bb_input_revisions
    WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 FOR SHARE`,
  [owner, projectId, ref.source_input_revision]);
  const source = rows.rows[0];
  if (!source || String(source.input_hash).trim() !== ref.source_input_hash)
    return 'rule_applicability_source_input_mismatch';
  if (!isRecord(source.manifest) || Number(source.draft_revision) !== current.draftRevision ||
      source.manifest.draft_revision !== current.draftRevision ||
      (source.manifest.manifest_schema === 'production_rule_pin_v1' && inputManifestHash(source.manifest) !== ref.source_input_hash))
    return 'rule_applicability_source_draft_mismatch';
  const selected = normalizedMaterials(current.materials);
  const sourceMaterials = normalizedMaterials(source.manifest.materials);
  const sourceRefs = normalizedRefs(source.material_versions);
  if (!selected || !sourceMaterials || !sourceRefs ||
      canonicalInputManifest(selected) !== canonicalInputManifest(sourceMaterials) ||
      canonicalInputManifest(sourceRefs) !== canonicalInputManifest(selected.map(({ material_id, material_version }) => ({ material_id, material_version }))))
    return 'rule_applicability_source_material_mismatch';
  for (const material of selected) {
    const live = (await db.query(`SELECT role,sha256,deleted_at FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
    [owner, projectId, material.material_id, material.material_version])).rows[0];
    if (!live || live.deleted_at || live.role !== material.role || String(live.sha256).trim() !== material.sha256)
      return 'rule_applicability_source_material_stale';
  }
  return null;
}

export async function loadExactReviewedContext(db: Db, owner: string, projectId: string,
  ref: RuleApplicabilityContextRef, identity: VerifiedIssuerIdentityBinding, current: LockedRuleSource,
  loader?: ReviewedContextLoader): Promise<ReviewedContextResult> {
  const sourceFailure = await verifyRuleApplicabilitySourceLock(db, owner, projectId, ref, current);
  if (sourceFailure) return { status: 'needs_review', reasons: [sourceFailure] };
  if (!loader) return { status: 'needs_review', reasons: ['rule_applicability_loader_unavailable'] };
  const result = await loader(db, { ownerUserId: owner, projectId, contextId: ref.context_id,
    version: ref.version, contentHash: ref.content_hash, expectedSourceInputRevision: ref.source_input_revision,
    expectedSourceInputHash: ref.source_input_hash, expectedIssuerBinding: identity });
  if ('status' in result) return result;
  if (!isRecord(result.contextPin) || inputManifestHash(result.contextPin) !== ref.content_hash)
    return { status: 'needs_review', reasons: ['rule_applicability_context_hash_mismatch'] };
  return result;
}

export async function lockProductionRulePack(db: Db, project: { owner_user_id: string; id: string; market: unknown; offering: unknown },
  current: LockedRuleSource, identity: VerifiedIssuerIdentityBinding | undefined,
  ref?: RuleApplicabilityContextRef, loader?: ReviewedContextLoader): Promise<RulePackBinding> {
  if (!identity) return { status: 'blocked', reasons: ['issuer_identity_not_bound'] };
  if (!ref || !validContextRef(ref)) return { status: 'blocked', reasons: ['rule_applicability_reference_missing'] };
  const reviewed = await loadExactReviewedContext(db, project.owner_user_id, project.id, ref, identity, current, loader);
  if ('status' in reviewed) return { status: 'blocked', reasons: reviewed.reasons };
  if (reviewed.request.market !== project.market || reviewed.request.offering !== project.offering)
    return { status: 'blocked', reasons: ['rule_applicability_project_scope_mismatch'] };
  const selection = await selectProductionRulePack(db as Pool, reviewed.request);
  if (selection.status === 'blocked') return { status: 'blocked', reasons: [...selection.reasons] };
  return { status: 'selected', pin: selection.pin, applicability: { ref, contextPin: reviewed.contextPin } };
}

export type StoredRulePinCheck =
  | { status: 'valid' }
  | { status: 'blocked'; reason: string }
  | { status: 'tampered'; reason: string };

/** Exact selected pin validation shared by preflight and Worker recovery. Never selects latest. */
export async function revalidateStoredProductionRulePin(db: Db, scope: { ownerUserId: string; projectId: string },
  input: { input_hash: string; manifest: unknown; rule_pack_version: string | null; template_version: string | null },
  loader?: ReviewedContextLoader): Promise<StoredRulePinCheck> {
  const locked = input.manifest;
  if (!isRecord(locked) || locked.manifest_schema !== 'production_rule_pin_v1')
    return { status: 'blocked', reason: 'rule_pack_pin_missing' };
  if (inputManifestHash(locked) !== String(input.input_hash).trim())
    return { status: 'tampered', reason: 'input_manifest_hash_mismatch' };
  if (locked.rule_pack_selection !== 'selected') {
    const reasons = locked.rule_pack_block_reasons;
    return { status: 'blocked', reason: Array.isArray(reasons) && typeof reasons[0] === 'string'
      ? reasons[0] : 'rule_pack_selection_blocked' };
  }
  const pin = locked.rule_pack_pin as ProductionRulePackPin | undefined;
  const context = locked.rule_pack_context as ProductionRulePackApplicabilityContext | undefined;
  const applicability = locked.rule_applicability_pin;
  const ref = isRecord(applicability) ? applicability.ref : undefined;
  const contextPin = isRecord(applicability) ? applicability.contextPin : undefined;
  const refs = locked.rule_pack_snapshot_refs;
  const identity = locked.issuer_identity;
  if (!pin || !context || !isRecord(applicability) || !validContextRef(ref) || !isRecord(contextPin) || !isRecord(refs) ||
      !isVerifiedIssuerIdentityBinding(identity) ||
      input.rule_pack_version !== pin.version || input.template_version !== pin.templateVersion ||
      locked.rule_pack_version !== pin.version || locked.template_version !== pin.templateVersion ||
      locked.market !== pin.market || locked.offering !== pin.offering ||
      refs.release_event_id !== pin.releaseEventId || refs.pack_id !== pin.packId || refs.pack_version !== pin.version || refs.pack_hash !== pin.contentHash ||
      refs.template_id !== pin.templateId || refs.template_version !== pin.templateVersion || refs.template_hash !== pin.templateHash ||
      refs.coverage_id !== pin.coverageId || refs.coverage_version !== pin.coverageVersion || refs.coverage_hash !== pin.coverageHash ||
      canonicalInputManifest(context) !== canonicalInputManifest(pin.applicabilityContext) ||
      inputManifestHash(contextPin) !== ref.content_hash || !Number.isSafeInteger(locked.draft_revision))
    return { status: 'tampered', reason: 'rule_pack_pin_mismatch' };
  const current = { draftRevision: locked.draft_revision as number, materials: locked.materials as LockedRuleSource['materials'] };
  const reviewed = await loadExactReviewedContext(db, scope.ownerUserId, scope.projectId, ref, identity, current, loader);
  if ('status' in reviewed)
    return { status: 'blocked', reason: reviewed.reasons[0] ?? 'rule_applicability_needs_review' };
  if (canonicalInputManifest(reviewed.contextPin) !== canonicalInputManifest(contextPin) ||
      reviewed.request.market !== pin.market || reviewed.request.offering !== pin.offering ||
      reviewed.request.instrument !== pin.instrument || reviewed.request.documentStage !== pin.documentStage ||
      reviewed.request.asOf !== pin.asOf ||
      canonicalInputManifest({ issuerScope: reviewed.request.issuerScope, investorScope: reviewed.request.investorScope ?? null,
        industry: reviewed.request.industry ?? null, specialFeatures: reviewed.request.specialFeatures ?? null }) !==
      canonicalInputManifest(pin.applicabilityContext))
    return { status: 'tampered', reason: 'rule_applicability_context_changed' };
  const result = await revalidateProductionRulePackPin(db as Pool, pin, context);
  if (result.status === 'blocked')
    return { status: 'blocked', reason: result.reasons[0] ?? 'production_rule_pack_blocked' };
  return { status: 'valid' };
}
