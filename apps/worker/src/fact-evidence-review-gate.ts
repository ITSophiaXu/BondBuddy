import { factIdentityKey } from '@bondbuddy/domain/facts';
import {
  readFactEvidenceReviewDeterminations,
  type FactEvidenceReviewDetermination,
  type FactEvidenceReviewPin,
  type FactEvidenceReviewReason,
} from './fact-evidence-review-seam.js';
import type { StoredFactCandidate } from './fact-repository.js';
import type { HistoricalGenerationInput } from './historical-generation-input.js';
import type { StageContext } from './run-pipeline.js';

/**
 * #15 -> #31 consumer guard for the fail-closed fact evidence review seam (#439).
 *
 * This module never reviews evidence and never mutates a candidate. It only answers, for a run
 * that explicitly enables the guard, which of its issuer facts may enter the generation-usable
 * set. A fact may only be offered when the seam reports `offerable: true` for the exact latest
 * immutable evidence-context set. Unreviewed, withdrawn, re-materialised, re-parsed, re-contexted,
 * grant-revoked, conflicted or otherwise unresolved candidates are excluded and stay pending
 * manual confirmation in the ledger; their warning/confidence/uncertainty/status/source_kind are
 * never rewritten and no candidate is promoted to `verified`.
 *
 * Fail-closed: any missing context set, malformed pin, reader error or determination/ pin count
 * mismatch excludes every affected issuer fact instead of widening the offered set. The guard is
 * off by default; installing it never changes an existing run unless the caller enables it.
 */

export const FACT_EVIDENCE_REVIEW_GATE_VERSION = 'fact-evidence-review-gate-v1' as const;

export interface FactEvidenceReviewGatePool {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Trusted run scope. Owner, project and issuer entity come from the locked run, never browser JSON. */
export interface FactEvidenceReviewGateScope {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly issuerEntityId: string;
}

export type FactEvidenceReviewGateExclusion =
  | FactEvidenceReviewReason
  | 'no_evidence_context_set'
  | 'identity_group_not_fully_offerable'
  | 'review_gate_unavailable';

export interface FactEvidenceReviewGateOutcome {
  readonly schemaVersion: typeof FACT_EVIDENCE_REVIEW_GATE_VERSION;
  /** Input facts minus every excluded issuer candidate; retained objects are returned unchanged. */
  readonly facts: readonly StoredFactCandidate[];
  readonly offeredCandidateIds: readonly string[];
  readonly excludedCandidateIds: readonly string[];
  readonly exclusionByCandidateId: Readonly<Record<string, FactEvidenceReviewGateExclusion>>;
  readonly originalFieldsPreserved: true;
}

export interface FactEvidenceReviewGateDependencies {
  readonly pool: FactEvidenceReviewGatePool;
  /** Latest immutable evidence-context pins per candidate. Overridable for focused tests. */
  readonly loadPins?: (
    scope: FactEvidenceReviewGateScope,
    candidateIds: readonly string[],
  ) => Promise<ReadonlyMap<string, FactEvidenceReviewPin>>;
  /** Fail-closed determination reader. Defaults to the #439 seam batch reader. */
  readonly determine?: (
    pool: FactEvidenceReviewGatePool,
    scope: Pick<FactEvidenceReviewGateScope, 'ownerUserId' | 'projectId'>,
    pins: readonly FactEvidenceReviewPin[],
  ) => Promise<readonly FactEvidenceReviewDetermination[]>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// The latest context set is the only set a current review may pin; anything older fails closed in
// the seam (`NOT EXISTS`), so the guard must not consider a superseded set.
const LATEST_CONTEXT_PIN_SQL = `SELECT DISTINCT ON (candidate_id)
    id, candidate_id, evidence_set_sha256, manifest, input_revision, input_hash,
    material_id, material_version, snapshot_id, parser_version, parse_response_sha256, content_sha256
  FROM bb_fact_evidence_context_sets
  WHERE owner_user_id=$1 AND project_id=$2 AND candidate_id = ANY($3::text[])
  ORDER BY candidate_id, created_at DESC, id DESC`;

/** Builds one exact seam pin from an immutable context-set row, or null when the row is unusable. */
export function factEvidenceReviewPinFromContextSetRow(row: Record<string, unknown>): FactEvidenceReviewPin | null {
  const manifest = row.manifest;
  if (!isRecord(manifest)) return null;
  const candidateId = trimmed(row.candidate_id);
  const evidenceContextSetId = trimmed(row.id);
  const evidenceSetSha256 = trimmed(row.evidence_set_sha256);
  const candidateIdentitySha256 = trimmed(manifest.candidate_identity_sha256);
  const sourceKind = manifest.source_kind;
  const inputHash = trimmed(row.input_hash);
  const materialId = trimmed(row.material_id);
  const materialSha256 = trimmed(row.content_sha256);
  const snapshotId = trimmed(row.snapshot_id);
  const parserVersion = trimmed(row.parser_version);
  const parseResponseSha256 = trimmed(row.parse_response_sha256);
  const inputRevision = Number(row.input_revision);
  const materialVersion = Number(row.material_version);
  if (!IDENTIFIER.test(candidateId) || !IDENTIFIER.test(evidenceContextSetId) ||
    (sourceKind !== 'audited' && sourceKind !== 'external') ||
    !SHA256.test(evidenceSetSha256) || !SHA256.test(candidateIdentitySha256) || !SHA256.test(inputHash) ||
    !IDENTIFIER.test(materialId) || !SHA256.test(materialSha256) || !IDENTIFIER.test(snapshotId) ||
    !parserVersion || !SHA256.test(parseResponseSha256) ||
    !Number.isSafeInteger(inputRevision) || inputRevision < 1 ||
    !Number.isSafeInteger(materialVersion) || materialVersion < 1) return null;
  return {
    candidateId, evidenceContextSetId, evidenceSetSha256, candidateIdentitySha256, sourceKind,
    inputRevision, inputHash, materialId, materialVersion, materialSha256, snapshotId,
    parserVersion, parseResponseSha256,
  };
}

async function latestContextPins(
  dependencies: FactEvidenceReviewGateDependencies,
  scope: FactEvidenceReviewGateScope,
  candidateIds: readonly string[],
): Promise<ReadonlyMap<string, FactEvidenceReviewPin>> {
  const pins = new Map<string, FactEvidenceReviewPin>();
  if (!candidateIds.length) return pins;
  const result = await dependencies.pool.query(LATEST_CONTEXT_PIN_SQL, [scope.ownerUserId, scope.projectId, [...candidateIds]]);
  for (const row of result.rows) {
    const pin = factEvidenceReviewPinFromContextSetRow(row);
    if (pin && !pins.has(pin.candidateId)) pins.set(pin.candidateId, pin);
  }
  return pins;
}

function isIssuerCandidate(scope: FactEvidenceReviewGateScope, fact: StoredFactCandidate): boolean {
  return fact.candidate.identity.accountId === scope.ownerUserId &&
    fact.candidate.identity.entityId === scope.issuerEntityId;
}

/**
 * Filters `facts` down to the candidates the seam currently certifies as offerable. Never offers one
 * member of a conflicted/uncertain identity while concealing the others: a whole identity group is
 * offered only when every member is offerable, matching `offerableFacts`' conflict semantics.
 */
export async function gateReviewedOfferableFacts(
  dependencies: FactEvidenceReviewGateDependencies,
  scope: FactEvidenceReviewGateScope,
  facts: readonly StoredFactCandidate[],
): Promise<FactEvidenceReviewGateOutcome> {
  const candidates = facts.filter(fact => isIssuerCandidate(scope, fact));
  const candidateIds = [...new Set(candidates.map(fact => fact.candidate.candidateId))];
  const exclusionByCandidateId: Record<string, FactEvidenceReviewGateExclusion> = {};
  const offeredCandidateIds: string[] = [];
  if (!candidateIds.length) {
    return { schemaVersion: FACT_EVIDENCE_REVIEW_GATE_VERSION, facts, offeredCandidateIds,
      excludedCandidateIds: [], exclusionByCandidateId, originalFieldsPreserved: true };
  }
  const verdict = new Map<string, FactEvidenceReviewGateExclusion | 'offerable'>();
  try {
    const pins = await (dependencies.loadPins ?? ((s, ids) => latestContextPins(dependencies, s, ids)))(scope, candidateIds);
    const orderedPins: FactEvidenceReviewPin[] = [];
    for (const id of candidateIds) {
      const pin = pins.get(id);
      if (pin) orderedPins.push(pin); else verdict.set(id, 'no_evidence_context_set');
    }
    if (orderedPins.length) {
      const determinations = await (dependencies.determine ??
        ((pool, s, p) => readFactEvidenceReviewDeterminations({ pool }, s, p)))(dependencies.pool, scope, orderedPins);
      if (determinations.length !== orderedPins.length) throw new Error('FACT_EVIDENCE_REVIEW_GATE_DETERMINATION_MISMATCH');
      for (let index = 0; index < orderedPins.length; index++) {
        const pin = orderedPins[index]!;
        const determination = determinations[index]!;
        verdict.set(pin.candidateId, determination.offerable ? 'offerable' : determination.reason);
      }
    }
  } catch {
    for (const id of candidateIds) verdict.set(id, 'review_gate_unavailable');
  }
  const groups = new Map<string, string[]>();
  for (const fact of candidates) {
    const key = factIdentityKey(fact.candidate.identity);
    const group = groups.get(key) ?? [];
    group.push(fact.candidate.candidateId);
    groups.set(key, group);
  }
  const blocked = new Set<string>();
  for (const [key, ids] of groups) if (ids.some(id => verdict.get(id) !== 'offerable')) blocked.add(key);
  const excluded = new Set<string>();
  for (const fact of candidates) {
    const id = fact.candidate.candidateId;
    const own = verdict.get(id);
    if (blocked.has(factIdentityKey(fact.candidate.identity))) {
      excluded.add(id);
      exclusionByCandidateId[id] = own !== undefined && own !== 'offerable' ? own : 'identity_group_not_fully_offerable';
    } else if (own === 'offerable') {
      offeredCandidateIds.push(id);
    } else {
      excluded.add(id);
      exclusionByCandidateId[id] = own ?? 'review_gate_unavailable';
    }
  }
  return { schemaVersion: FACT_EVIDENCE_REVIEW_GATE_VERSION, facts: facts.filter(fact => !excluded.has(fact.candidate.candidateId)),
    offeredCandidateIds, excludedCandidateIds: [...excluded], exclusionByCandidateId, originalFieldsPreserved: true };
}

/** The historical generation loader signature the guard wraps; kept structural to avoid a #31 import cycle. */
export type HistoricalGenerationLoader = (ctx: StageContext) => Promise<HistoricalGenerationInput>;

export interface FactEvidenceReviewGateLoaderOptions {
  /** Deployment/run switch. Absent or false leaves the loader untouched (existing behavior). */
  readonly enabled?: (ctx: StageContext) => boolean | Promise<boolean>;
  readonly dependencies?: Omit<FactEvidenceReviewGateDependencies, 'pool'>;
}

/**
 * Wraps the historical generation input loader so the review guard runs at the generation front
 * gate only when enabled. The narrowed `facts` flow into `offerableFacts`, so unoffered candidates
 * never reach the prompt; on any guard failure every issuer fact is withheld (fail closed) while the
 * ledger and original candidate fields stay untouched.
 */
export function createFactEvidenceReviewGuardedLoader(
  load: HistoricalGenerationLoader,
  options: FactEvidenceReviewGateLoaderOptions = {},
): HistoricalGenerationLoader {
  return async (ctx: StageContext): Promise<HistoricalGenerationInput> => {
    const input = await load(ctx);
    let enabled = true;
    try { enabled = (await options.enabled?.(ctx)) ?? false; } catch { enabled = true; }
    if (!enabled) return input;
    const context = input.locked.context;
    const scope: FactEvidenceReviewGateScope = { ownerUserId: context.ownerUserId, projectId: context.projectId,
      issuerEntityId: context.issuerEntityId };
    try {
      const outcome = await gateReviewedOfferableFacts({ pool: ctx.pool, ...options.dependencies }, scope, input.facts);
      return { ...input, facts: outcome.facts };
    } catch {
      return { ...input, facts: input.facts.filter(fact => !isIssuerCandidate(scope, fact)) };
    }
  };
}
