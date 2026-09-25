import type { Pool, PoolClient } from 'pg';
import { selectProductionRulePack, type ProductionRulePackPin, type ProductionRulePackRequest } from '@bondbuddy/rule-pack-registry';
import { digest } from './data.js';
import type { VerifiedIssuerIdentityBinding } from './issuer-identity-binding.js';

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

export async function loadExactReviewedContext(db: Db, owner: string, projectId: string,
  ref: RuleApplicabilityContextRef, identity: VerifiedIssuerIdentityBinding, loader?: ReviewedContextLoader): Promise<ReviewedContextResult> {
  if (!loader) return { status: 'needs_review', reasons: ['rule_applicability_loader_unavailable'] };
  const source = (await db.query('SELECT input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
    [owner, projectId, ref.source_input_revision])).rows[0];
  if (!source || String(source.input_hash).trim() !== ref.source_input_hash)
    return { status: 'needs_review', reasons: ['rule_applicability_source_input_mismatch'] };
  const result = await loader(db, { ownerUserId: owner, projectId, contextId: ref.context_id,
    version: ref.version, contentHash: ref.content_hash, expectedSourceInputRevision: ref.source_input_revision,
    expectedSourceInputHash: ref.source_input_hash, expectedIssuerBinding: identity });
  if ('status' in result) return result;
  if (!isRecord(result.contextPin) || inputManifestHash(result.contextPin) !== ref.content_hash)
    return { status: 'needs_review', reasons: ['rule_applicability_context_hash_mismatch'] };
  return result;
}

export async function lockProductionRulePack(db: Db, project: { owner_user_id: string; id: string; market: unknown; offering: unknown },
  identity: VerifiedIssuerIdentityBinding | undefined, ref?: RuleApplicabilityContextRef, loader?: ReviewedContextLoader): Promise<RulePackBinding> {
  if (!identity) return { status: 'blocked', reasons: ['issuer_identity_not_bound'] };
  if (!ref || !validContextRef(ref)) return { status: 'blocked', reasons: ['rule_applicability_reference_missing'] };
  const reviewed = await loadExactReviewedContext(db, project.owner_user_id, project.id, ref, identity, loader);
  if ('status' in reviewed) return { status: 'blocked', reasons: reviewed.reasons };
  if (reviewed.request.market !== project.market || reviewed.request.offering !== project.offering)
    return { status: 'blocked', reasons: ['rule_applicability_project_scope_mismatch'] };
  const selection = await selectProductionRulePack(db as Pool, reviewed.request);
  if (selection.status === 'blocked') return { status: 'blocked', reasons: [...selection.reasons] };
  return { status: 'selected', pin: selection.pin, applicability: { ref, contextPin: reviewed.contextPin } };
}
