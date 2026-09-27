import type { CheckEvidence } from './sse-private-checks.js';
import { enumOf, nonempty, stringSet, type CheckContext } from './sse-private-check-context.js';

/** These handlers collect evidence and catch misuse. They never decide legal eligibility. */
export const MANUAL_RULES = ['issuer-governance', 'related-contingent', 'sse-focus-2025',
  'special-overlays-sse', 'private-negative-list', 'optimized-review-version'] as const;
type E<T> = CheckEvidence<T>;
export const CONTINGENT_AREAS = ['related_parties','guarantees','litigation_arbitration','restricted_assets','subsequent_events'] as const;
export interface ManualCheckInput {
  governanceReview?: { corporateEvents: E<readonly string[]>; controlAndAppointmentsEvidence: E<string>;
    currentCompanyLawEvidence: E<string>; currentReorganizationDefinition: E<string>; reorganizationAssessment: E<string> };
  contingentReview?: { completeInventory: E<boolean>; checkedThrough: E<string>; signingDate: E<string>;
    areas: readonly { area: E<typeof CONTINGENT_AREAS[number]>;
      observation: E<'not_searched'|'no_hits'|'reviewed_absent'|'present'>; publishedAsAbsent: E<boolean>;
      assessment?: E<string> }[] };
  focusReview?: { completeFeatureReview: E<boolean>; triggeredProfiles: E<readonly string[]>;
    assessment?: E<string>; blanketIssuanceBanClaimed: E<boolean> };
  specialReview?: { completeFeatureReview: E<boolean>; features: E<readonly string[]>; ordinaryPackOnly: E<boolean>;
    overlayEvidence?: E<string> };
  negativeListReview?: { currentOfficialList: E<string>; issuerAssessment: E<string>;
    simultaneousSameInstrumentApplication: E<boolean>; unusedPreviousSameInstrumentQuota: E<boolean>;
    publicProfitThresholdUsedToReject: E<boolean> };
  optimizedReview?: { requested: E<boolean>; citedEdition?: E<string>; eligibilityAssessment?: E<string> };
}

export function evaluateManualCheck(ruleId: string, input: ManualCheckInput, asOf: string, ctx: CheckContext): void {
  const { add, read, bool, day, expect } = ctx;
  switch (ruleId.replace(/^sse-private-/, '')) {
    case 'issuer-governance': {
      const d = input.governanceReview;
      read('governance_events',d?.corporateEvents,stringSet);
      read('governance_control_appointments',d?.controlAndAppointmentsEvidence,nonempty);
      read('governance_company_law',d?.currentCompanyLawEvidence,nonempty);
      read('governance_reorganization_definition',d?.currentReorganizationDefinition,nonempty);
      read('governance_reorganization_assessment',d?.reorganizationAssessment,nonempty);
      add('governance_manual_scope','needs_judgement','核控制链、任职及公司法当期规则，重组按现行定义和独立回溯；不以单个50%或企业名称作重大重组/城建判定。',d?.reorganizationAssessment);
      return;
    }
    case 'related-contingent': {
      const d = input.contingentReview;
      expect('contingent_inventory_complete',d?.completeInventory,true,'需完整排查关联方、担保、诉讼仲裁、受限资产及期后事项。');
      const through = day('contingent_checked_through',d?.checkedThrough), signing = day('contingent_signing_date',d?.signingDate);
      if (through && signing) add('contingent_cutoff',through > asOf ? 'issue' : through >= signing ? 'pass' : 'needs_evidence','检索须覆盖签署日且不能声称查完尚未来临的日期；仅财务截止日不能覆盖重大后续事项。',d?.checkedThrough,d?.signingDate);
      if (!Array.isArray(d?.areas) || !d.areas.length || d.areas.length > 1000) { add('contingent_areas_missing','needs_evidence','缺少逐类排查结果。'); return; }
      const seen = new Set<string>();
      for (const [i,row] of d.areas.entries()) {
        const area = read(`contingent_${i}_area`,row.area,enumOf(CONTINGENT_AREAS));
        if (area && seen.has(area)) add(`contingent_${i}_duplicate`,'issue','同类排查重复，不能掩盖其他类别缺失。',row.area);
        if (area) seen.add(area);
        const status = read(`contingent_${i}_observation`,row.observation,enumOf(['not_searched','no_hits','reviewed_absent','present']));
        const absent = bool(`contingent_${i}_published_absent`,row.publishedAsAbsent);
        if (status === 'not_searched' || status === 'no_hits') add(`contingent_${i}_insufficient`,absent === true ? 'issue' : 'needs_evidence','未检索或无命中不是确认不存在，保留材料/查询范围和待确认状态。',row.observation,row.publishedAsAbsent);
        if (status === 'present' && absent === true) add(`contingent_${i}_contradiction`,'issue','已识别事项不能披露为不存在。',row.observation,row.publishedAsAbsent);
        if (status === 'present' || status === 'reviewed_absent') read(`contingent_${i}_assessment`,row.assessment,nonempty);
      }
      if (CONTINGENT_AREAS.some(area=>!seen.has(area))) add('contingent_area_gap','needs_evidence','五类排查未齐全，不以部分无事项形成全量否定结论。');
      add('contingent_manual_scope','needs_judgement','金额、重大性、关联关系、损失估计及偿债影响需专业核验；公开信息供应商未接入不能标全网核验通过。'); return;
    }
    case 'sse-focus-2025': {
      const d = input.focusReview;
      const complete = bool('focus_complete',d?.completeFeatureReview);
      const profiles = read('focus_profiles',d?.triggeredProfiles,stringSet);
      expect('focus_blanket_ban',d?.blanketIssuanceBanClaimed,false,'城建/房地产/集团及量化重点情形可并存；审慎论证不一律等于禁止发行。');
      if (profiles?.length) read('focus_assessment',d?.assessment,nonempty);
      if (complete !== true) add('focus_inventory_unknown','needs_evidence','须完整核第十一/十五条及主体、业务、债务等各项重点，不能仅按行业一个标签排除。',d?.completeFeatureReview);
      add('focus_manual_scope','needs_judgement','本包不完成重点关注规则全条自动判定；逐触发项的披露/用途/规模限制、原则要求与例外保留专业结论。',d?.triggeredProfiles,d?.assessment); return;
    }
    case 'special-overlays-sse': {
      const d = input.specialReview;
      const complete = bool('special_complete',d?.completeFeatureReview), features = read('special_features',d?.features,stringSet);
      if (complete !== true || features === undefined) { add('special_scope_unknown','needs_judgement','专项特征未知不能当普通债，先取得完整否定/肯定证据。',d?.completeFeatureReview,d?.features); return; }
      if (!features.length) { add('special_none','not_applicable','完整核查确认无专项特征；只说明本次不需专项增量，不豁免普通私募规则。',d?.completeFeatureReview,d?.features); return; }
      const ordinaryOnly = bool('special_ordinary_only',d?.ordinaryPackOnly);
      if (ordinaryOnly !== undefined) add('special_overlay_required',ordinaryOnly ? 'issue' : 'needs_judgement','有专项特征须单独有效规则/模板及审核，普通包不能兜底；不因存在增量引用而自动批准。',d?.features,d?.ordinaryPackOnly);
      read('special_overlay_evidence',d?.overlayEvidence,nonempty); return;
    }
    case 'private-negative-list': {
      const d = input.negativeListReview;
      read('negative_list_current_source',d?.currentOfficialList,nonempty);
      read('negative_list_issuer_assessment',d?.issuerAssessment,nonempty);
      expect('negative_parallel_application',d?.simultaneousSameInstrumentApplication,false,'核同品种其他交易场所申请；命中8.3.2不得自动接受再次申请。');
      expect('negative_unused_quota',d?.unusedPreviousSameInstrumentQuota,false,'核前次相同品种获准额度未募足情形，不能用无公募财务门槛放行。');
      expect('negative_public_profit_gate',d?.publicProfitThresholdUsedToReject,false,'不以公募利润覆盖等门槛直接拒绝普通私募。');
      add('negative_manual_scope','needs_judgement','协会现行负面清单全文/效力与发行人逐项判断仍需审核；没有财务指标限制不等于无条件可发行。',d?.currentOfficialList,d?.issuerAssessment); return;
    }
    case 'optimized-review-version': {
      const d = input.optimizedReview;
      const requested = bool('optimized_requested',d?.requested);
      if (requested === false) { add('optimized_not_requested','not_applicable','已核实本项目未使用优化审核，按普通路径核验。',d?.requested); return; }
      if (requested !== true) return;
      const edition = read('optimized_cited_edition',d?.citedEdition,nonempty);
      if (edition) add('optimized_edition',edition === '2026-09-04' ? 'needs_judgement' : 'issue','本研究日须核2026-09-04版；2023旧版已废止，当前版也不自动证明资格或豁免。',d?.citedEdition);
      read('optimized_eligibility_assessment',d?.eligibilityAssessment,nonempty);
      add('optimized_manual_scope','needs_judgement','知名成熟资格、简明披露及减免条件需独立当前版本增量包和专业审核。',d?.eligibilityAssessment); return;
    }
    default: throw new Error(`SSE_PRIVATE_MANUAL_RULE_UNKNOWN:${ruleId}`);
  }
}
