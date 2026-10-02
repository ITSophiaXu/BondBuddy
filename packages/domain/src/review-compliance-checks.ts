import type { ReviewCheckCoverage, ReviewEvidenceRef, ReviewRuleRef } from '../../contracts/dist/review-results.js';
import { evaluateRulePackCapability, rulePackContentHash, type RuleContext, type RulePack } from './index.js';
import { validateReviewEvidence, validateReviewRule, uniqueEvidence, type ReviewEvidenceContext } from './review-evidence.js';
import { normalizeReviewFindings, reviewCoverage, type ReviewEvaluation } from './review-finding-normalization.js';

export interface ReviewRuleAssessment {
  check_id: string; rule_id: string; pack_id: string;
  outcome: ReviewCheckCoverage['outcome']; title: string; description: string;
  target_refs: ReviewEvidenceRef[]; evidence_refs: ReviewEvidenceRef[]; rule_refs: ReviewRuleRef[];
  /** The worker supplies checker provenance, not an arbitrary property from model JSON. */
  evaluation_method: 'structured_checker' | 'model';
  /** An excerpt search cannot establish that a disclosure is absent from the document. */
  claims_document_absence: boolean; complete_document_examined: boolean;
  suggested_change?: string;
}
export interface ReviewFormattingRequirement {
  check_id: string; record_ids: string[]; rule_ref: ReviewRuleRef;
  property: 'latin_font' | 'east_asia_font' | 'half_points' | 'rendered_layout';
  expected: string;
}
/** Taken from the actual parser record after its response/hash is verified. */
export interface ReviewFormattedRecord { ref: ReviewEvidenceRef; formatting: Record<string, unknown> }
export interface ReviewComplianceInput {
  context: RuleContext | null; packs: RulePack[]; assessments: ReviewRuleAssessment[];
  formatting_requirements: ReviewFormattingRequirement[]; formatted_records: ReviewFormattedRecord[];
}

function ruleBelongsToPack(ref: ReviewRuleRef, pack: RulePack | undefined): boolean {
  if (!pack || ref.pack_version !== pack.version || ref.pack_sha256 !== rulePackContentHash(pack)) return false;
  const rule = pack.rules.find(rule => rule.rule_id === ref.rule_id && rule.version === ref.rule_version);
  const source = pack.sources.find(source => source.source_id === ref.source_id && rule?.source_ref_ids.includes(source.source_id));
  return !!source && source.source_version === ref.source_version && source.document_hash === ref.source_sha256
    && source.exact_quote.includes(ref.quote) && source.clause_locator === ref.locator
    && source.effective_from === ref.effective_from && source.effective_to === ref.effective_to;
}

export function reviewComplianceEvidence(input: ReviewComplianceInput, ctx: ReviewEvidenceContext): ReviewEvaluation {
  if (input.assessments.length > 10000 || input.formatting_requirements.length > 10000) throw new Error('REVIEW_COMPLIANCE_INPUT_LIMIT');
  if (new Set([...input.assessments,...input.formatting_requirements].map(c => c.check_id)).size !== input.assessments.length + input.formatting_requirements.length)
    throw new Error('REVIEW_COMPLIANCE_DUPLICATE_CHECK');
  const result: ReviewEvaluation = { findings:[],coverage:[],limitations:[] };
  const eligible = new Map<string, Set<string>>();
  const gatedPacks = new Map<string, string>();
  if (!input.context) result.coverage.push(reviewCoverage(ctx,'rules:context-missing','compliance','uncovered',
    '市场、品种、适用日期或发行阶段缺失，不能推测规则适用性。',[]));
  for (const pack of input.packs) {
    if (eligible.has(pack.pack_id) || gatedPacks.has(pack.pack_id)) throw new Error('REVIEW_RULE_PACK_AMBIGUOUS');
    try {
      if (!input.context) { gatedPacks.set(pack.pack_id,'rule_context_missing'); continue; }
      const decision = evaluateRulePackCapability(pack,input.context);
      if (decision.decision === 'eligible_for_evaluation') eligible.set(pack.pack_id,new Set(decision.applicable_rule_ids));
      else {
        const reason = decision.reason_codes.join('；'); gatedPacks.set(pack.pack_id,reason);
        // A mismatched supplied pack is a coverage gap for the requested scope, not proof that all legal checks are inapplicable.
        result.coverage.push(reviewCoverage(ctx,`rules:${pack.pack_id}:applicability`,'compliance',
          decision.decision === 'needs_evidence' ? 'manual' : 'uncovered',`本项目适用规则不可用：${reason}`,[]));
      }
    } catch { gatedPacks.set(pack.pack_id,'rule_pack_invalid');
      result.coverage.push(reviewCoverage(ctx,`rules:${pack.pack_id}:applicability`,'compliance','uncovered','规则包结构或来源校验未通过，不能生成正式合规结论。',[])); }
  }
  if (!input.packs.length) result.coverage.push(reviewCoverage(ctx,'rules:missing','compliance','uncovered',
    '没有针对当前市场、品种及阶段的有效规则包，不套用其他市场或小公募规则。',[]));
  const assessed = new Set<string>();
  for (const assessment of input.assessments) {
    const ids = eligible.get(assessment.pack_id);
    if (!ids?.has(assessment.rule_id)) {
      // A persisted source may be supplied as reading material while project applicability is
      // unknown. Keep the model's cited observation as manual, never as a legal pass or error.
      const referenceOnly = assessment.evaluation_method === 'model' && assessment.rule_refs.length > 0
        && assessment.rule_refs.every(rule => rule.rule_id === assessment.rule_id && rule.pack_id === assessment.pack_id
          && rule.applicability === 'unknown' && !validateReviewRule(rule,ctx).length
          && ruleBelongsToPack(rule,input.packs.find(pack => pack.pack_id === assessment.pack_id)));
      if (referenceOnly) {
        const findings = normalizeReviewFindings([{stable_key:`reference-rule:${assessment.check_id}`,dimension:'compliance',conclusion:'manual',severity:'P2',
          title:assessment.title,description:`${assessment.description} 本条来源的项目适用性尚未核实，不构成正式合规结论。`,
          target_refs:assessment.target_refs,evidence_refs:assessment.evidence_refs,rule_refs:assessment.rule_refs,
          limitations:['rule_applicability_unverified'],verification:'model_only',can_revise:false}],ctx);
        result.findings.push(...findings);result.coverage.push(reviewCoverage(ctx,assessment.check_id,'compliance','manual',
          '保留受信发布来源的语义观察，适用性与结论待人工核对。',findings.flatMap(f=>f.evidence_refs),findings,assessment.rule_refs));continue;
      }
      result.coverage.push(reviewCoverage(ctx,assessment.check_id,'compliance','uncovered','规则没有通过本次项目的市场、品种、阶段及效力校验。',[])); continue;
    }
    assessed.add(`${assessment.pack_id}:${assessment.rule_id}`);
    const refs = uniqueEvidence([...assessment.target_refs,...assessment.evidence_refs]);
    const errors = [...assessment.target_refs.flatMap(ref => validateReviewEvidence(ref,ctx,true)),
      ...assessment.evidence_refs.flatMap(ref => validateReviewEvidence(ref,ctx)),
      ...assessment.rule_refs.flatMap(ref => validateReviewRule(ref,ctx))];
    if (!assessment.rule_refs.length || assessment.rule_refs.some(rule => rule.rule_id !== assessment.rule_id || rule.pack_id !== assessment.pack_id
      || rule.applicability !== 'applicable' || !ruleBelongsToPack(rule,input.packs.find(pack => pack.pack_id === assessment.pack_id)))) errors.push('rule_source_or_applicability_missing');
    if (!refs.length || refs.some(ref => ref.uncertainty.length > 0)) errors.push('source_evidence_missing_or_uncertain');
    if (assessment.claims_document_absence && !assessment.complete_document_examined) errors.push('excerpt_cannot_prove_document_absence');
    if (assessment.evaluation_method === 'model' && ['pass','issue','not_applicable'].includes(assessment.outcome)) errors.push('semantic_check_requires_independent_judgement');
    const outcome: ReviewCheckCoverage['outcome'] = errors.length ? 'manual' : assessment.outcome;
    const findings = outcome === 'pass' || outcome === 'not_applicable' ? [] : normalizeReviewFindings([{
      stable_key:`rule:${assessment.pack_id}:${assessment.rule_id}:${assessment.check_id}`,dimension:'compliance',
      conclusion:outcome === 'issue' ? 'error' : outcome,severity:'P2',title:assessment.title,description:assessment.description,
      target_refs:assessment.target_refs,evidence_refs:assessment.evidence_refs,rule_refs:assessment.rule_refs,
      suggested_change:assessment.suggested_change,limitations:errors,
      verification:assessment.evaluation_method === 'structured_checker' ? 'deterministic' : 'model_only',
      can_revise:outcome === 'issue' && !!assessment.suggested_change,
    }],ctx);
    result.findings.push(...findings);
    const normalizedOutcome = outcome === 'issue' && findings.some(finding => finding.conclusion !== 'error') ? 'manual' : outcome;
    result.coverage.push(reviewCoverage(ctx,assessment.check_id,'compliance',normalizedOutcome,errors.length
      ? `${assessment.description} 限制：${errors.join('；')}` : assessment.description,
      refs.filter(ref => validateReviewEvidence(ref,ctx).length === 0),findings,
      assessment.rule_refs.filter(ref => validateReviewRule(ref,ctx).length === 0)));
  }
  for (const [packId,ids] of eligible) for (const ruleId of ids) if (!assessed.has(`${packId}:${ruleId}`)) {
    result.coverage.push(reviewCoverage(ctx,`rules:${packId}:${ruleId}:not-run`,'compliance','uncovered',
      '该适用规则没有实际检查记录，不能因无 finding 视为通过。',[],[],ctx.rules.filter(rule => rule.pack_id === packId && rule.rule_id === ruleId)));
  }
  if (!input.formatting_requirements.length) result.coverage.push(reviewCoverage(ctx,'formatting:requirements-missing','compliance','uncovered',
    '尚未提供明确的适用格式或模板要求，本轮不声称字体、字号、间距、分页或视觉版式已检查。',[]));
  for (const requirement of input.formatting_requirements) {
    const ruleErrors = validateReviewRule(requirement.rule_ref,ctx);
    const applicable = requirement.rule_ref.applicability === 'applicable' && (requirement.rule_ref.authority !== 'regulatory'
      || eligible.get(requirement.rule_ref.pack_id)?.has(requirement.rule_ref.rule_id)
        && ruleBelongsToPack(requirement.rule_ref,input.packs.find(pack => pack.pack_id === requirement.rule_ref.pack_id)));
    if (ruleErrors.length || !applicable || !requirement.record_ids.length || !requirement.expected.trim()) {
      result.coverage.push(reviewCoverage(ctx,requirement.check_id,'compliance','uncovered','格式要求缺少有效来源、明确范围或适用性。',[])); continue;
    }
    const records = input.formatted_records.filter(record => requirement.record_ids.includes(record.ref.record_id));
    const unique = new Set(records.map(record => record.ref.record_id));
    const refs = records.map(record => record.ref);
    if (unique.size !== requirement.record_ids.length || records.length !== unique.size || refs.some(ref => validateReviewEvidence(ref,ctx,true).length || ref.uncertainty.length)
      || refs.some(ref => ref.locator_type !== 'docx_block') || requirement.property === 'rendered_layout') {
      result.coverage.push(reviewCoverage(ctx,requirement.check_id,'compliance','uncovered',
        '没有足够的原生 DOCX 属性或实际渲染依据；PDF/OCR、缺记录和视觉分页不能由模型猜测通过。',
        refs.filter(ref => validateReviewEvidence(ref,ctx,true).length === 0),[],[requirement.rule_ref])); continue;
    }
    const bad: ReviewEvidenceRef[] = [], unknown: ReviewEvidenceRef[] = [];
    for (const record of records) {
      const runs = record.formatting.runs;
      if (!Array.isArray(runs) || !runs.length) { unknown.push(record.ref); continue; }
      for (const run of runs) {
        if (!run || typeof run !== 'object') { unknown.push(record.ref); continue; }
        const value = (run as Record<string,unknown>)[requirement.property];
        const theme = requirement.property === 'latin_font' ? run.latin_theme : requirement.property === 'east_asia_font' ? run.east_asia_theme : null;
        if (theme || typeof value !== 'string' || !value.trim() || requirement.property === 'half_points' && !/^\d+$/.test(value)) unknown.push(record.ref);
        else if (value !== requirement.expected) bad.push(record.ref);
      }
    }
    const findings = bad.length ? normalizeReviewFindings([{
      stable_key:`format:${requirement.check_id}`,dimension:'compliance',conclusion:'error',severity:'P3',
      title:requirement.rule_ref.authority === 'regulatory' ? '文档格式与适用规则不一致' : '文档格式与指定模板要求不一致',
      description:`实际继承后的 ${requirement.property} 不符合要求 ${requirement.expected}；仅核对文档属性，不表示实际字体环境或视觉分页已验证。`,
      target_refs:uniqueEvidence(bad),evidence_refs:uniqueEvidence(bad),rule_refs:[requirement.rule_ref],
      suggested_change:`将已定位范围的 ${requirement.property} 调整为 ${requirement.expected}。`,
      verification:'deterministic',can_revise:true,
    }],ctx) : [];
    result.findings.push(...findings);
    result.coverage.push(reviewCoverage(ctx,requirement.check_id,'compliance',unknown.length ? 'uncovered' : bad.length ? 'issue' : 'pass',
      unknown.length ? '部分 run 为主题字体或属性缺失；已确认差异仍保留，不能声称全范围格式已核。'
        : bad.length ? '已定位真实 DOCX 属性差异。' : '指定范围的已解析 DOCX 属性与明确要求一致；不包含视觉渲染检查。',refs,findings,[requirement.rule_ref]));
  }
  result.limitations = [...new Set(result.findings.flatMap(f => f.limitations).concat(result.coverage.filter(c => ['uncovered','manual','needs_evidence'].includes(c.outcome)).map(c => c.reason)))];
  return result;
}
