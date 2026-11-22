import { Ajv } from 'ajv';
import {
  MATERIAL_PARSE_JOB_TYPE,
  UpdateDetailsSchema,
  type UpdateDetails,
} from '@bondbuddy/contracts';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { checkpointStage } from '@bondbuddy/api/queue';
import { isUsableHistoricalFact, updateContentHash } from '@bondbuddy/domain/historical-update';
import { factIdentityKey, type FactIdentity } from '@bondbuddy/domain/facts';
import { getParseSnapshot, type StoredParseSnapshot } from './parse-evidence-repository.js';
import {
  listHistoricalProfileHistory,
  type StoredHistoricalProfile,
} from './historical-profile-repository.js';
import { listFactCandidates, type StoredFactCandidate } from './fact-repository.js';
import {
  historicalUpdateFactsHash,
  prepareHistoricalUpdate,
  type LockedHistoricalUpdate,
  type HistoricalUpdateDecisionSnapshot,
  type HistoricalUpdateReaders,
} from './historical-update.js';
import {
  getFactDecisionAtVersion,
  getLatestFactDecision,
  type StoredFactDecision,
} from './fact-decision-repository.js';
import type { StageContext } from './run-pipeline.js';
import type { ProductionRulePackPin } from '@bondbuddy/rule-pack-registry';
import {
  loadHistoricalRuleGuidance,
  type HistoricalRuleGuidance,
  type HistoricalRuleResolver,
} from './historical-rule-context.js';
import {
  historicalFactMatchesBaseline,
  historicalFactMatchesMaterial,
  isHistoricalFactMaterial,
  projectHistoricalFact,
} from './historical-fact-policy.js';
import type { HistoricalCandidateRuleGuidance } from './historical-candidate-rule-context.js';
import { loadAuthorizedHistoricalTestRuleGuidance } from './historical-test-rule-authorization.js';
import { HISTORICAL_TEST_BASELINE_POLICY } from './historical-baseline-warnings.js';
import {
  readHistoricalFactReviews,
  historicalReviewAllowsExistingFact,
  type HistoricalFactReviews,
} from './historical-fact-reviews.js';
import {
  isTestIssuerCandidate,
  testIssuerCandidateMatches,
} from '@bondbuddy/api/test-issuer-candidate';

export const GENERATION_INPUT_CHECKPOINT = 'historical_generation_input';
const detailsValidator = new Ajv({ strict: false }).compile(UpdateDetailsSchema);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export class HistoricalGenerationUnavailable extends Error {}
function unavailable(reason: string): never {
  throw new HistoricalGenerationUnavailable(reason);
}
export interface HistoricalGenerationInput {
  locked: Omit<LockedHistoricalUpdate, 'bindings' | 'occurrences' | 'columns' | 'coverage'>;
  snapshot: StoredParseSnapshot;
  profile: StoredHistoricalProfile;
  /** Includes every candidate, including conflicts and uncertainty, in the frozen material set. */
  facts: readonly StoredFactCandidate[];
  decisions: HistoricalUpdateDecisionSnapshot[];
  evidenceReviews?: HistoricalFactReviews;
  revalidateEvidenceReviews?: () => Promise<void>;
  planReaders: HistoricalUpdateReaders;
  reportingCutoffBasis?: WorkingDraftReportingCutoff;
  details: UpdateDetails;
  issuerName: string;
  issuerIdentityPending: boolean;
  preparationHash: string;
  ruleGuidance: HistoricalRuleGuidance | HistoricalCandidateRuleGuidance;
}
export interface WorkingDraftReportingCutoff {
  source: 'locked_financial_fact_period';
  status: 'needs_confirmation';
  cutoff: string;
  candidate_ids: string[];
  /** Period evidence only: no candidate values or verification effect. */
  candidate_provenance: {
    candidate_id: string;
    status: StoredFactCandidate['provenance']['status'];
    candidate_uncertainty: string | null;
    uncertainty: readonly string[];
    evidence: StoredFactCandidate['provenance']['evidence'];
  }[];
}
const validDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** A draft boundary from owned financial evidence, never a confirmed user target or arbitrary calendar date. */
export function deriveWorkingDraftReportingCutoff(
  owner: string,
  entity: string,
  materials: LockedHistoricalUpdate['materials'],
  facts: readonly StoredFactCandidate[],
): WorkingDraftReportingCutoff | undefined {
  const eligible = facts.flatMap((f) => {
    const material = materials.find(
      (m) =>
        m.materialId === f.provenance.materialId &&
        m.materialVersion === f.provenance.materialVersion,
    );
    const period = f.candidate.identity.period;
    const cutoff = period.asOf ?? period.end;
    if (
      f.candidate.identity.accountId !== owner ||
      f.candidate.identity.entityId !== entity ||
      !material ||
      !['audit', 'financial', 'interimFinancial', 'notes'].includes(material.role) ||
      !historicalFactMatchesMaterial(f, material) ||
      !['audited', 'external'].includes(f.candidate.source.kind) ||
      !['extracted', 'verified', 'needs_confirmation', 'conflicted'].includes(
        f.provenance.status,
      ) ||
      !f.provenance.evidence.every(
        (a) =>
          a.evidence_id.trim() &&
          a.locator_type.trim() &&
          a.locator &&
          !Array.isArray(a.locator) &&
          Object.keys(a.locator).length > 0 &&
          a.literal_quote.trim() &&
          a.extraction_method.trim() &&
          a.extraction_version.trim(),
      ) ||
      !validDay(cutoff) ||
      (period.start !== undefined && (!validDay(period.start) || period.start > cutoff)) ||
      (period.asOf !== undefined && period.end !== undefined && period.asOf !== period.end)
    )
      return [];
    return [
      {
        cutoff,
        id: f.candidate.candidateId,
        provenance: {
          candidate_id: f.candidate.candidateId,
          status: f.provenance.status,
          candidate_uncertainty: f.candidate.uncertainty ?? null,
          uncertainty: f.provenance.uncertainty,
          evidence: f.provenance.evidence,
        },
      },
    ];
  });
  const cutoffs = new Set(eligible.map((f) => f.cutoff));
  if (cutoffs.size > 1) unavailable('historical_target_period_ambiguous');
  const cutoff = eligible[0]?.cutoff;
  return cutoff
    ? structuredClone({
        source: 'locked_financial_fact_period' as const,
        status: 'needs_confirmation' as const,
        cutoff,
        candidate_ids: [...new Set(eligible.map((f) => f.id))].sort(),
        candidate_provenance: eligible
          .sort((a, b) => a.id.localeCompare(b.id, 'en'))
          .map((f) => f.provenance),
      })
    : undefined;
}

interface PreparationPin {
  version: 'historical-generation-input-v1';
  input_hash: string;
  baseline_policy?: typeof HISTORICAL_TEST_BASELINE_POLICY;
  reporting_cutoff_basis?: WorkingDraftReportingCutoff;
  snapshot_id: string;
  profile_version: number;
  profile_hash: string;
  parser_version: string;
  parse_hash: string;
  issuer_entity_id: string;
  fact_ids: string[];
  facts_hash: string;
  fact_evidence_reviews?: HistoricalFactReviews;
  decisions: {
    identity_hash: string;
    version: number;
    decision_id: string | null;
    content_hash: string | null;
  }[];
}
const frozenFactsHash = (facts: readonly StoredFactCandidate[]) =>
  updateContentHash(
    [...facts].sort((a, b) => a.candidate.candidateId.localeCompare(b.candidate.candidateId, 'en')),
  );
export interface GenerationInputReaders {
  snapshot: typeof getParseSnapshot;
  profiles: typeof listHistoricalProfileHistory;
  facts: typeof listFactCandidates;
  prepare: typeof prepareHistoricalUpdate;
  decision: (
    ctx: StageContext,
    identity: FactIdentity,
    version?: number,
  ) => Promise<StoredFactDecision | null>;
  checkpoint: (ctx: StageContext, pin: Record<string, unknown>) => Promise<void>;
  rules?: HistoricalRuleResolver;
  evidenceReviews?: typeof readHistoricalFactReviews;
}

/** Freeze derived parse/profile/candidate references before the first provider intent, then reread exact IDs on recovery. */
export async function loadHistoricalGenerationInput(
  ctx: StageContext,
  readers: Partial<GenerationInputReaders> = {},
): Promise<HistoricalGenerationInput> {
  const { pool, run } = ctx;
  const input = (
    await pool.query(
      `SELECT i.input_hash,i.draft_revision,i.manifest,i.rule_pack_version,i.template_version,i.material_versions FROM bb_input_revisions i
    JOIN bb_projects p ON p.id=i.project_id AND p.owner_user_id=i.owner_user_id AND p.deleted_at IS NULL
    WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`,
      [run.owner_user_id, run.project_id, run.input_revision],
    )
  ).rows[0];
  if (!input || String(input.input_hash).trim() !== run.input_hash.trim())
    throw new Error('UPDATE_INPUT_LOCK_MISMATCH');
  const manifest = input.manifest;
  if (!manifest || typeof manifest !== 'object' || !detailsValidator(manifest.update_details))
    throw new Error('UPDATE_INVALID_INPUT_MANIFEST');
  let details = manifest.update_details as UpdateDetails;
  const deriveCutoff = run.channel === 'non_production_test' && details.reporting_cutoff === null;
  if (details.has_historical !== true) unavailable('historical_update_requires_history');
  if (manifest.market !== 'sse' || manifest.offering !== 'private')
    unavailable('historical_update_scope_not_installed');
  if (!deriveCutoff && !validDay(details.reporting_cutoff))
    unavailable('historical_target_period_required');
  let rule: { packId: string; version: string; contentHash: string };
  let ruleGuidance: HistoricalGenerationInput['ruleGuidance'];
  if (run.channel === 'non_production_test') {
    ruleGuidance = await loadAuthorizedHistoricalTestRuleGuidance(ctx, input);
    rule = {
      packId: ruleGuidance.pack_id,
      version: ruleGuidance.pack_version,
      contentHash: ruleGuidance.pack_hash,
    };
  } else {
    const productionRule = manifest.rule_pack_pin as ProductionRulePackPin | undefined;
    // Production retains the exact release revalidator; no fallback to a local candidate.
    if (
      !productionRule ||
      typeof productionRule.packId !== 'string' ||
      !productionRule.packId ||
      productionRule.version !== input.rule_pack_version ||
      !hash(productionRule.contentHash)
    )
      unavailable('rule_pack_pin_missing');
    ruleGuidance = await loadHistoricalRuleGuidance(
      pool,
      productionRule,
      manifest.rule_pack_context,
      readers.rules,
    );
    rule = productionRule;
  }
  const testCandidate =
    run.channel === 'non_production_test' && isTestIssuerCandidate(manifest.test_issuer_candidate)
      ? manifest.test_issuer_candidate
      : null;
  if (
    testCandidate &&
    !(await testIssuerCandidateMatches(
      pool,
      { ownerUserId: run.owner_user_id, projectId: run.project_id },
      testCandidate,
    ))
  )
    unavailable('historical_issuer_candidate_stale');
  const issuerName = testCandidate?.issuer_display_name ?? manifest.issuer_name;
  if (typeof issuerName !== 'string' || !issuerName.trim())
    unavailable('historical_issuer_required');
  const materials: LockedHistoricalUpdate['materials'] = Array.isArray(manifest.materials)
    ? manifest.materials.map((m: Record<string, unknown>) => ({
        materialId: m.material_id,
        materialVersion: m.material_version,
        contentHash: m.sha256,
        role: m.role,
      }))
    : [];
  if (
    !materials.length ||
    new Set(materials.map((m) => m.materialId)).size !== materials.length ||
    materials.some(
      (m) =>
        typeof m.materialId !== 'string' ||
        !Number.isSafeInteger(m.materialVersion) ||
        m.materialVersion < 1 ||
        !hash(m.contentHash),
    )
  )
    throw new Error('UPDATE_INVALID_MATERIAL_MANIFEST');
  const refs = input.material_versions as { material_id: string; material_version: number }[];
  if (
    !Array.isArray(refs) ||
    refs.length !== materials.length ||
    refs.some(
      (r) =>
        !materials.some(
          (m) => m.materialId === r.material_id && m.materialVersion === r.material_version,
        ),
    )
  )
    throw new Error('UPDATE_INVALID_MATERIAL_MANIFEST');
  const historical = materials.filter((m) => m.role === 'historical');
  if (historical.length !== 1) unavailable('historical_baseline_selection_required');
  const baseline = historical[0]!;
  const scope = {
    ownerUserId: run.owner_user_id,
    projectId: run.project_id,
    materialId: baseline.materialId,
    materialVersion: baseline.materialVersion,
  };
  const previous = ctx.checkpoint[GENERATION_INPUT_CHECKPOINT] as unknown as
    PreparationPin | undefined;
  const baselinePolicy =
    run.channel === 'non_production_test' ? HISTORICAL_TEST_BASELINE_POLICY : undefined;
  if (previous && previous.baseline_policy !== baselinePolicy)
    throw new Error('UPDATE_BASELINE_POLICY_CHANGED');
  if (
    previous &&
    (previous.version !== 'historical-generation-input-v1' ||
      previous.input_hash !== run.input_hash.trim() ||
      !Array.isArray(previous.fact_ids) ||
      new Set(previous.fact_ids).size !== previous.fact_ids.length ||
      !hash(previous.facts_hash) ||
      !hash(previous.profile_hash) ||
      !hash(previous.parse_hash) ||
      !Array.isArray(previous.decisions))
  )
    throw new Error('UPDATE_PREPARATION_CHECKPOINT_INVALID');
  let snapshotId = previous?.snapshot_id;
  if (!snapshotId) {
    const job = (
      await pool.query(
        `SELECT checkpoint FROM bb_jobs WHERE job_type=$1 AND owner_user_id=$2 AND project_id=$3
      AND material_id=$4 AND material_version=$5 AND subtype='material_parse' AND parser_version=$6 AND state='succeeded'`,
        [
          MATERIAL_PARSE_JOB_TYPE,
          run.owner_user_id,
          run.project_id,
          baseline.materialId,
          baseline.materialVersion,
          documentParserVersion(),
        ],
      )
    ).rows[0];
    snapshotId = job?.checkpoint?.stages?.parse_evidence?.snapshot_id;
  }
  if (!snapshotId) unavailable('historical_parse_snapshot_missing');
  const snapshot = await (readers.snapshot ?? getParseSnapshot)({ pool }, scope, snapshotId);
  if (
    !snapshot ||
    snapshot.contentSha256 !== baseline.contentHash ||
    (previous &&
      (snapshot.parserVersion !== previous.parser_version ||
        snapshot.responseSha256 !== previous.parse_hash))
  )
    throw new Error('UPDATE_BASELINE_LOCK_MISMATCH');
  if (
    snapshot.response.material?.media_type !==
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    unavailable('historical_pdf_reconstruction_required');
  const profiles = await (readers.profiles ?? listHistoricalProfileHistory)({ pool }, scope);
  const profile = previous
    ? profiles.find((p) => p.profileVersion === previous.profile_version)
    : profiles.at(-1);
  if (!profile || (previous && updateContentHash(profile.recognition) !== previous.profile_hash))
    unavailable('historical_profile_snapshot_missing');
  if (
    profile.recognition.source_market.value !== 'sse' ||
    profile.recognition.source_offering.value !== 'private'
  )
    unavailable('historical_structure_mapping_required');
  const materialMap = new Map(materials.map((m) => [`${m.materialId}:${m.materialVersion}`, m]));
  const candidates = (await (readers.facts ?? listFactCandidates)({ pool }, scope)).filter((f) => {
    const m = materialMap.get(`${f.provenance.materialId}:${f.provenance.materialVersion}`);
    return (
      m &&
      isHistoricalFactMaterial(m, {
        materialId: baseline.materialId,
        materialVersion: baseline.materialVersion,
      })
    );
  });
  const ids = previous ? new Set(previous.fact_ids) : null;
  const facts = ids ? candidates.filter((f) => ids.has(f.candidate.candidateId)) : candidates;
  if (previous && (facts.length !== ids!.size || frozenFactsHash(facts) !== previous.facts_hash))
    throw new Error('UPDATE_FACT_SNAPSHOT_CHANGED');
  if (!facts.length) unavailable('historical_fact_inventory_missing');
  // Project facts may contain subsidiaries. Do not guess which entity is the issuer.
  // The trusted extraction pipeline must use the project issuer's exact identity.
  const entities = new Set(facts.map((f) => f.candidate.identity.entityId));
  const entity =
    previous?.issuer_entity_id ?? testCandidate?.candidate_key ?? manifest.issuer_entity_id;
  if (typeof entity !== 'string' || !entity.trim() || !entities.has(entity))
    unavailable('historical_issuer_identity_not_bound');
  if (
    facts.some(
      (f) =>
        f.candidate.identity.accountId !== run.owner_user_id ||
        f.provenance.evidence.some((a) => {
          const m = materialMap.get(`${a.material_id}:${a.material_version}`);
          return !m || a.content_hash !== m.contentHash;
        }),
    )
  )
    throw new Error('UPDATE_FACT_MATERIAL_MISMATCH');
  const identities = [
    ...new Map(
      facts
        .filter((f) => f.candidate.identity.entityId === entity)
        .map((f) => [factIdentityKey(f.candidate.identity), f.candidate.identity]),
    ).values(),
  ];
  const decisions: HistoricalUpdateDecisionSnapshot[] = [];
  const decisionPins: PreparationPin['decisions'] = [];
  if (previous && previous.decisions.length !== identities.length)
    throw new Error('UPDATE_FACT_DECISION_SNAPSHOT_CHANGED');
  for (const identity of identities) {
    const identityHash = updateContentHash(identity);
    const prior = previous?.decisions.filter((d) => d.identity_hash === identityHash);
    if (previous && prior?.length !== 1) throw new Error('UPDATE_FACT_DECISION_SNAPSHOT_CHANGED');
    const pin = prior?.[0];
    if (pin && (!Number.isSafeInteger(pin.version) || pin.version < 0))
      throw new Error('UPDATE_FACT_DECISION_SNAPSHOT_CHANGED');
    const decision =
      pin?.version === 0
        ? null
        : readers.decision
          ? await readers.decision(ctx, identity, pin?.version)
          : pin
            ? await getFactDecisionAtVersion({ pool }, scope, identity, pin.version)
            : await getLatestFactDecision({ pool }, scope, identity);
    if (
      decision &&
      (decision.ownerUserId !== run.owner_user_id ||
        decision.projectId !== run.project_id ||
        factIdentityKey(decision.identity) !== factIdentityKey(identity))
    )
      throw new Error('UPDATE_FACT_DECISION_SCOPE_MISMATCH');
    const current = {
      identity_hash: identityHash,
      version: decision?.version ?? 0,
      decision_id: decision?.decisionId ?? null,
      content_hash: decision ? updateContentHash(decision) : null,
    };
    if (pin && updateContentHash(pin) !== updateContentHash(current))
      throw new Error('UPDATE_FACT_DECISION_SNAPSHOT_CHANGED');
    decisions.push({ identity, decision });
    decisionPins.push(current);
  }
  const reviewScope = {
    ownerUserId: run.owner_user_id,
    projectId: run.project_id,
    inputRevision: run.input_revision,
    inputHash: run.input_hash.trim(),
  };
  const readReviews = readers.evidenceReviews ?? readHistoricalFactReviews;
  // Do not retrofit an old run with a new model/input binding. New preparations always pin absence too.
  const evidenceReviews =
    previous && previous.fact_evidence_reviews === undefined
      ? undefined
      : await readReviews({ pool }, reviewScope, facts, previous?.fact_evidence_reviews);
  const reportingCutoffBasis = deriveCutoff
    ? deriveWorkingDraftReportingCutoff(
        run.owner_user_id,
        entity,
        materials,
        facts.filter((f) =>
          historicalReviewAllowsExistingFact(evidenceReviews, f.candidate.candidateId),
        ),
      )
    : undefined;
  if (deriveCutoff) {
    if (!reportingCutoffBasis) unavailable('historical_target_period_required');
    details = { ...details, reporting_cutoff: reportingCutoffBasis.cutoff };
  }
  if (
    previous &&
    updateContentHash(previous.reporting_cutoff_basis ?? null) !==
      updateContentHash(reportingCutoffBasis ?? null)
  )
    throw new Error('UPDATE_REPORTING_CUTOFF_SNAPSHOT_CHANGED');
  const revalidateEvidenceReviews = evidenceReviews
    ? async () => {
        const current = await readReviews({ pool }, reviewScope, facts, evidenceReviews);
        if (updateContentHash(current) !== updateContentHash(evidenceReviews))
          throw new Error('UPDATE_FACT_EVIDENCE_REVIEW_CHANGED');
      }
    : undefined;
  const pin: PreparationPin = previous ?? {
    version: 'historical-generation-input-v1',
    input_hash: run.input_hash.trim(),
    ...(baselinePolicy ? { baseline_policy: baselinePolicy } : {}),
    snapshot_id: snapshot.snapshotId,
    profile_version: profile.profileVersion,
    profile_hash: updateContentHash(profile.recognition),
    parser_version: snapshot.parserVersion,
    parse_hash: snapshot.responseSha256,
    issuer_entity_id: entity,
    fact_ids: facts.map((f) => f.candidate.candidateId).sort(),
    facts_hash: frozenFactsHash(facts),
    decisions: decisionPins,
    fact_evidence_reviews: evidenceReviews,
    ...(reportingCutoffBasis ? { reporting_cutoff_basis: reportingCutoffBasis } : {}),
  };
  const locked: HistoricalGenerationInput['locked'] = {
    context: {
      ownerUserId: run.owner_user_id,
      projectId: run.project_id,
      issuerEntityId: entity,
      inputRevision: run.input_revision,
      inputHash: run.input_hash.trim(),
      targetMarket: manifest.market,
      ...(baselinePolicy ? { baselineUse: 'non_production_working_draft' as const } : {}),
      targetOffering: manifest.offering,
      ruleSnapshot: { packId: rule.packId, version: rule.version, contentHash: rule.contentHash },
    },
    materials,
    baseline: {
      materialId: baseline.materialId,
      materialVersion: baseline.materialVersion,
      snapshotId: snapshot.snapshotId,
      profileVersion: profile.profileVersion,
    },
    factCandidateIds: [],
    factsHash: historicalUpdateFactsHash([]),
  };
  // Reuse the #31 material, effective-baseline, parser and profile integrity gates before any model call.
  const baselineReview = await (readers.prepare ?? prepareHistoricalUpdate)(
    { pool },
    { ...locked, bindings: [], occurrences: [], columns: [], coverage: [] },
  );
  const pendingProfileCandidate = baselineReview.findings.some(
    (f) => f.code === 'UPDATE_PROFILE_CANDIDATE_PENDING',
  );
  if (
    (pendingProfileCandidate && !baselinePolicy) ||
    baselineReview.findings.some((f) =>
      [
        'UPDATE_BASELINE_UNCERTAIN',
        'UPDATE_PROFILE_UNCONFIRMED',
        'UPDATE_PDF_RECONSTRUCTION_REQUIRED',
        'UPDATE_STRUCTURE_MAPPING_REQUIRED',
      ].includes(f.code),
    )
  )
    unavailable('historical_baseline_needs_confirmation');
  if (!previous) {
    if (readers.checkpoint) await readers.checkpoint(ctx, { ...pin });
    else await checkpointStage(pool, ctx.lease, GENERATION_INPUT_CHECKPOINT, { ...pin });
    ctx.checkpoint[GENERATION_INPUT_CHECKPOINT] = { ...pin };
  }
  const planReaders: HistoricalUpdateReaders = {
    snapshot: (s, id) => (readers.snapshot ?? getParseSnapshot)({ pool }, s, id),
    profiles: (s) => (readers.profiles ?? listHistoricalProfileHistory)({ pool }, s),
    facts: (s, identity) =>
      (readers.facts ?? listFactCandidates)({ pool }, s, identity).then((rows) =>
        rows.filter((f) => factIdentityKey(f.candidate.identity) === factIdentityKey(identity)),
      ),
    decision: async (s, identity) => {
      if (s.ownerUserId !== run.owner_user_id || s.projectId !== run.project_id)
        throw new Error('UPDATE_FACT_DECISION_SCOPE_MISMATCH');
      const found = decisions.find(
        (d) => factIdentityKey(d.identity) === factIdentityKey(identity),
      );
      if (!found) throw new Error('UPDATE_FACT_DECISION_SNAPSHOT_CHANGED');
      return found.decision;
    },
  };
  return {
    locked,
    snapshot,
    profile,
    facts,
    decisions,
    evidenceReviews,
    revalidateEvidenceReviews,
    planReaders,
    details,
    ruleGuidance,
    issuerName,
    issuerIdentityPending: !!testCandidate,
    ...(reportingCutoffBasis ? { reportingCutoffBasis } : {}),
    preparationHash: updateContentHash(pin),
  };
}

/** Never offer one clean member of a conflicted/uncertain identity while concealing the other candidates. */
export function offerableFacts(input: HistoricalGenerationInput): StoredFactCandidate[] {
  const groups = new Map<string, StoredFactCandidate[]>();
  for (const f of input.facts) {
    if (
      f.candidate.identity.accountId !== input.locked.context.ownerUserId ||
      f.candidate.identity.entityId !== input.locked.context.issuerEntityId
    )
      continue;
    const key = factIdentityKey(f.candidate.identity);
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) =>
      group.every((f) => {
        const material = input.locked.materials.find(
          (m) =>
            m.materialId === f.provenance.materialId &&
            m.materialVersion === f.provenance.materialVersion,
        );
        return (
          material &&
          historicalReviewAllowsExistingFact(input.evidenceReviews, f.candidate.candidateId) &&
          isHistoricalFactMaterial(material, input.locked.baseline) &&
          historicalFactMatchesMaterial(f, material) &&
          f.provenance.uncertainty.length === 0 &&
          (material.role !== 'historical' || historicalFactMatchesBaseline(f, input.snapshot)) &&
          isUsableHistoricalFact(projectHistoricalFact(f))
        );
      }),
    )
    .flat();
}
