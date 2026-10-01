import { updateContentHash } from '@bondbuddy/domain/historical-update';
import { loadSsePrivateCandidateAssets, SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT } from './sse-private-candidate-assets.js';
import { HistoricalRulesUnavailable } from './historical-rule-context.js';

export interface HistoricalCandidateTarget {
  market: 'sse'; offering: 'private'; documentStage: 'registration' | 'issuance'; asOf: string;
}

/** Reference projection only. The caller MUST separately validate the run's effective test grant. */
export async function loadHistoricalCandidateRuleGuidance(target: HistoricalCandidateTarget,
  expected: { taxonomyHash: string; rulePackHash: string }, root = SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT) {
  if (target.market !== 'sse' || target.offering !== 'private' ||
      !['registration', 'issuance'].includes(target.documentStage))
    throw new HistoricalRulesUnavailable('historical_test_rule_scope_not_installed');
  const date = new Date(`${target.asOf}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target.asOf) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== target.asOf)
    throw new HistoricalRulesUnavailable('historical_test_rule_date_required');
  const { bundle, pack } = await loadSsePrivateCandidateAssets(root);
  if (expected.taxonomyHash !== bundle.taxonomy.contentSha256 || expected.rulePackHash !== bundle.rulePack.contentSha256)
    throw new HistoricalRulesUnavailable('historical_test_rule_pin_mismatch');
  // This candidate describes a current research snapshot, not historical regulatory coverage.
  if (target.asOf < pack.validity.effective_from || (pack.validity.effective_to && target.asOf > pack.validity.effective_to))
    throw new HistoricalRulesUnavailable('historical_test_rule_date_outside_candidate_window');
  const rules = pack.rules.map(rule => ({ rule_id: rule.rule_id, version: rule.version, title: rule.title,
    enabled: rule.enabled, enforcement: rule.enforcement, applicability: rule.applicability,
    applicability_review: 'pending' as const, required_inputs: rule.required_inputs,
    boundaries: rule.boundaries, exceptions: rule.exceptions, evidence_requirements: rule.evidence_requirements,
    source_ref_ids: rule.source_ref_ids }));
  const ids = new Set(rules.flatMap(rule => rule.source_ref_ids));
  // Normalise repeated document metadata without truncating any quote/locator/boundary.
  // This keeps the 179 citations below the existing 180 KB reference limit.
  const documents = new Map<string, Record<string, unknown>>();
  const sources = pack.sources.filter(source => ids.has(source.source_id)).map(source => {
    const document = { kind: source.kind, authority: source.authority, document_title: source.document_title,
      source_version: source.source_version, document_hash: source.document_hash, official_url: source.official_url,
      published_on: source.published_on, effective_from: source.effective_from, effective_to: source.effective_to,
      verified_by: source.verified_by, verified_at: source.verified_at };
    const document_ref = updateContentHash(document);
    documents.set(document_ref, document);
    return { source_id: source.source_id, document_ref, clause_locator: source.clause_locator,
      exact_quote: source.exact_quote,
      date_status: (source.effective_from && target.asOf < source.effective_from) ||
        (source.effective_to && target.asOf > source.effective_to) ? 'outside_declared_interval' : 'needs_review' };
  });
  const content = { version: 'historical-candidate-rule-guidance-v1' as const,
    status: 'research_reference_only' as const, channel: 'non_production_test' as const,
    pack_id: bundle.rulePack.id, pack_version: bundle.rulePack.version, pack_hash: bundle.rulePack.contentSha256,
    taxonomy: bundle.taxonomy, chapter_template: bundle.chapterTemplate,
    as_of: target.asOf, document_stage: target.documentStage,
    applicability_review: 'pending' as const, rules, sources,
    source_documents: Object.fromEntries(documents), coverage: bundle.coverage,
    limitations: ['候选规则未经过生产发布或本项目适用性审核，所有规则与来源保持待核。',
      'source_documents 保存来源效力与授权核验信息，sources 通过 document_ref 引用；不得省略引文或猜测适用。',
      '研究快照日期不是法规生效日期；outside_declared_interval 的来源不得据以新增本期义务。',
      'coverage 中 not_applicable 保留为范围排除记录，不是用户待补法规；无显式映射不得用覆盖项 ID 代替 rule_id。'],
    constitutes_compliance_result: false as const };
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 180_000)
    throw new HistoricalRulesUnavailable('historical_rule_context_exceeds_limit');
  return { ...content, content_hash: updateContentHash(content) };
}

export type HistoricalCandidateRuleGuidance = Awaited<ReturnType<typeof loadHistoricalCandidateRuleGuidance>>;
