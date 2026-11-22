import type { Pool } from 'pg';
import { evaluateRulePackCapability, rulePackContentHash } from '@bondbuddy/domain';
import {
  revalidateProductionRulePackPin,
  type ProductionRulePackPin,
  type ProductionRulePackApplicabilityContext,
} from '@bondbuddy/rule-pack-registry';
import { updateContentHash } from '@bondbuddy/domain/historical-update';

export class HistoricalRulesUnavailable extends Error {}
export type HistoricalRuleResolver = typeof revalidateProductionRulePackPin;

/** Read the exact persisted release, including revoked grants/evidence checks. Never load latest or a local research file. */
export async function loadHistoricalRuleGuidance(
  db: Pick<Pool, 'query'>,
  pin: ProductionRulePackPin,
  context: ProductionRulePackApplicabilityContext,
  resolve: HistoricalRuleResolver = revalidateProductionRulePackPin,
) {
  if (
    !pin ||
    !context ||
    pin.market !== 'sse' ||
    pin.offering !== 'private' ||
    pin.instrument !== 'ordinary-company-bond'
  )
    throw new HistoricalRulesUnavailable('historical_rule_scope_not_installed');
  const selected = await resolve(db, pin, context);
  if (selected.status === 'blocked')
    throw new HistoricalRulesUnavailable(selected.reasons[0] ?? 'historical_rules_not_ready');
  if (
    updateContentHash(selected.pin) !== updateContentHash(pin) ||
    selected.pack.pack_id !== pin.packId ||
    selected.pack.version !== pin.version ||
    rulePackContentHash(selected.pack) !== pin.contentHash
  )
    throw new Error('UPDATE_RULE_CONTENT_MISMATCH');
  const decision = evaluateRulePackCapability(selected.pack, {
    market: pin.market,
    offering: pin.offering,
    document_stage: pin.documentStage,
    instrument: pin.instrument,
    issuer_scope: context.issuerScope,
    investor_scope: context.investorScope,
    industry: context.industry,
    special_features: context.specialFeatures == null ? null : [...context.specialFeatures],
    as_of: pin.asOf,
  });
  if (decision.decision !== 'eligible_for_evaluation')
    throw new HistoricalRulesUnavailable('historical_rules_not_eligible');
  const ids = new Set(decision.applicable_rule_ids);
  const rules = selected.pack.rules
    .filter((rule) => ids.has(rule.rule_id))
    .map((rule) => ({
      rule_id: rule.rule_id,
      version: rule.version,
      title: rule.title,
      enforcement: rule.enforcement,
      required_inputs: rule.required_inputs,
      boundaries: rule.boundaries,
      exceptions: rule.exceptions,
      evidence_requirements: rule.evidence_requirements,
      source_ref_ids: rule.source_ref_ids,
    }));
  const sourceIds = new Set(rules.flatMap((rule) => rule.source_ref_ids));
  const sources = selected.pack.sources
    .filter((source) => sourceIds.has(source.source_id))
    .map((source) => ({
      source_id: source.source_id,
      kind: source.kind,
      document_title: source.document_title,
      source_version: source.source_version,
      document_hash: source.document_hash,
      official_url: source.official_url,
      clause_locator: source.clause_locator,
      exact_quote: source.exact_quote,
      effective_from: source.effective_from,
      effective_to: source.effective_to,
    }));
  const content = {
    version: 'historical-rule-guidance-v1' as const,
    release_event_id: pin.releaseEventId,
    pack_id: pin.packId,
    pack_version: pin.version,
    pack_hash: pin.contentHash,
    as_of: pin.asOf,
    document_stage: pin.documentStage,
    applicability: context,
    rules,
    sources,
    // Source quotes are reference data, never instructions that grant tools or confirm issuer facts.
    constitutes_compliance_result: false as const,
  };
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 180_000)
    throw new HistoricalRulesUnavailable('historical_rule_context_exceeds_limit');
  return { ...content, content_hash: updateContentHash(content) };
}
export type HistoricalRuleGuidance = Awaited<ReturnType<typeof loadHistoricalRuleGuidance>>;
