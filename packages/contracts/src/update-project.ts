import { Type, type Static } from '@sinclair/typebox';
import { MARKETS, OFFERINGS, MARKET_OFFERINGS } from './public-enums.js';
import type { ProjectMessageSetPin } from './project-message-set-pin.js';

export type UnifiedAuthoringInput = {
  review_result?: import('./review-update.js').ReviewResultPin;
  review_revision?: import('./review-revision.js').ReviewRevisionPin;
  version: 'unified_v1'; source_prospectuses: SourceProspectus[];
  requirements: ProjectMessageSetPin['members'];
  knowledge: { path: string; sha256: string; markdown: string }[];
  knowledge_status: 'authoring_reference_not_compliance_approval';
  previous_output?: { artifact_id: string; version: number; sha256: string; run_id: string; input_revision: number };
};
export function isUnifiedInput(manifest: unknown): manifest is Record<string, unknown> & { authoring: UnifiedAuthoringInput } {
  return !!manifest && typeof manifest === 'object' && (manifest as { authoring?: { version?: unknown } }).authoring?.version === 'unified_v1';
}

// One definition for the form, API, and immutable input manifest (spec 05/16).
export const PROJECT_FIELD_LIMITS = { name: 120, issuer: 200, notes: 6000, fundingUses: 30 } as const;
export const MONEY_UNITS = [
  { code: 'yuan', label: '元', multiplier: 1n },
  { code: 'ten_thousand', label: '万元', multiplier: 10000n },
  { code: 'hundred_million', label: '亿元', multiplier: 100000000n }
] as const;
export const FUNDING_PURPOSES = [
  { code: 'refinance_bonds', label: '借新还旧', materials: '可提供拟偿还债券清单、余额、到期日及兑付安排。' },
  { code: 'repay_debt', label: '偿还有息负债', materials: '可提供债务明细、借款合同、余额和拟偿还金额。' },
  { code: 'working_capital', label: '补充流动资金', materials: '可补充业务需求、拟使用金额及测算依据。' },
  { code: 'construction', label: '项目建设', materials: '建议提供项目可研报告，以及实际适用的备案、土地和建设许可等文件。' },
  { code: 'equity_investment', label: '用于投资股权', materials: '建议提供投资方案、标的资料、相关协议及批准文件。' },
  { code: 'fund_contribution', label: '用于基金出资', materials: '建议提供基金备案、出资承诺或协议及相关投向说明。' }
] as const;
const nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Boolean>>(schema: T) => Type.Union([schema, Type.Null()]);
const note = () => nullable(Type.String({ maxLength: PROJECT_FIELD_LIMITS.notes }));
export const MoneySchema = Type.Object({
  value: Type.String({ maxLength: 40, pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$' }),
  unit: Type.Union(MONEY_UNITS.map(unit => Type.Literal(unit.code)))
}, { additionalProperties: false });
/** A user-entered target period is not a recognized or audited financial fact. */
export const TargetReportingPeriodSchema = Type.Object({
  start: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  end: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  period_kind: Type.Union([Type.Literal('annual'), Type.Literal('interim'), Type.Null()]),
  scope: Type.Union([Type.Literal('consolidated'), Type.Literal('parent'), Type.Null()]),
  status: Type.Union([Type.Literal('user_asserted'), Type.Literal('needs_confirmation')]),
  // Evidence references are reserved until this project input can validate them against owned materials.
  evidence_refs: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 0 })
}, { additionalProperties: false, description: 'User-entered target period; never evidence-verified by the project draft API.' });
export const SOURCE_RELATIONS = { same_issuer: '同企业', parent: '目标发行人的母公司', subsidiary: '目标发行人的子公司', similar_business: '相似业务企业' } as const;
export const SourceProspectusSchema = Type.Object({
  material_id: Type.String({ minLength: 1, maxLength: 128 }),
  material_version: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  issuer_name: nullable(Type.String({ maxLength: PROJECT_FIELD_LIMITS.issuer })),
  relation: Type.Union([...Object.keys(SOURCE_RELATIONS).map(v => Type.Literal(v as keyof typeof SOURCE_RELATIONS)), Type.Null()]),
  market: Type.Union([...MARKETS.map(v => Type.Literal(v)), Type.Null()]),
  offering: Type.Union([...OFFERINGS.map(v => Type.Literal(v)), Type.Null()]),
  reporting_periods: Type.Array(TargetReportingPeriodSchema, { maxItems: 30 }),
  status: Type.Literal('user_asserted')
}, { additionalProperties: false });
export type SourceProspectus = Static<typeof SourceProspectusSchema>;
export type SourceMaterialPin = { material_id: string; material_version: number; sha256: string; role: string };
/** Draft fields stay nullable while editing. New authoring submissions require a declaration for every selected source. */
export function sourceProspectusMissingFields(source?: SourceProspectus): string[] {
  const missing: string[] = [];
  if (!source?.issuer_name?.trim()) missing.push('原发行人名称');
  if (!source?.relation || !Object.hasOwn(SOURCE_RELATIONS, source.relation)) missing.push('企业关系');
  if (!source?.market || !MARKETS.includes(source.market)) missing.push('原发行市场');
  if (!source?.offering || !source.market || !(MARKET_OFFERINGS[source.market] as readonly string[] | undefined)?.includes(source.offering)) missing.push('原品种');
  const validDate = (value: string | null) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  // Financial statement scope and audit evidence are not input requirements.
  if (!source?.reporting_periods.length || source.reporting_periods.some(p =>
    !validDate(p.start) || !validDate(p.end) || p.start! > p.end! || !['annual', 'interim'].includes(p.period_kind ?? '')))
    missing.push('原稿最新报告期');
  return missing;
}
export function sourceProspectusInputGaps(materials: readonly SourceMaterialPin[], sources: readonly SourceProspectus[] = []) {
  return materials.filter(m => m.role === 'historical' || m.role === 'reference').flatMap(material => {
    const matches = sources.filter(s => s.material_id === material.material_id && s.material_version === material.material_version && s.sha256 === material.sha256);
    const missing = sourceProspectusMissingFields(matches.length === 1 ? matches[0] : undefined);
    return missing.length ? [{ material_id: material.material_id, missing }] : [];
  });
}
export const UpdateDetailsSchema = Type.Object({
  authoring_mode: Type.Optional(Type.Literal('unified_v1')),
  source_prospectuses: Type.Optional(Type.Array(SourceProspectusSchema, { maxItems: 60 })),
  has_historical: nullable(Type.Boolean()),
  reporting_cutoff: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  // Optional for older clients. On PATCH, omission preserves the saved period set; [] explicitly clears it.
  target_reporting_periods: Type.Optional(Type.Array(TargetReportingPeriodSchema, { maxItems: 30 })),
  registration_amount: Type.Union([MoneySchema, Type.Null()]),
  issuance_amount: Type.Union([MoneySchema, Type.Null()]),
  bond_terms: note(), underwriting: note(), other_agencies: note(), rating_enhancement: note(),
  funding_uses: Type.Array(Type.Object({
    purpose: Type.Union([...FUNDING_PURPOSES.map(purpose => Type.Literal(purpose.code)), Type.Null()]),
    amount: Type.Union([MoneySchema, Type.Null()]),
    details: note(), target: note()
  }, { additionalProperties: false }), { maxItems: PROJECT_FIELD_LIMITS.fundingUses }),
  other_information: note(), supplementary_notes: note()
}, { additionalProperties: false, description: 'User-provided update draft, not extracted or audited facts. PATCH replaces legacy fields in this object; omitted target_reporting_periods preserves the saved list for older clients, while [] explicitly clears it.' });
export type TargetReportingPeriod = Static<typeof TargetReportingPeriodSchema>;
export type UpdateDetails = Static<typeof UpdateDetailsSchema>;
export type Money = Static<typeof MoneySchema>;
export function emptyUpdateDetails(): UpdateDetails {
  return { has_historical: null, reporting_cutoff: null, registration_amount: null, issuance_amount: null,
    bond_terms: null, underwriting: null, other_agencies: null, rating_enhancement: null,
    funding_uses: [], other_information: null, supplementary_notes: null };
}
export function moneyInMicroYuan(amount: Money): bigint {
  const [whole, fraction = ''] = amount.value.split('.');
  const multiplier = MONEY_UNITS.find(unit => unit.code === amount.unit)!.multiplier;
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * multiplier;
}
export function updateDetailsErrors(details: UpdateDetails): Array<{ field: string; code: string; message: string }> {
  const errors = [];
  const sourceIds = new Set<string>();
  for (const [index, source] of (details.source_prospectuses ?? []).entries()) {
    const field = `update_details.source_prospectuses.${index}`;
    if (sourceIds.has(source.material_id)) errors.push({ field, code: 'duplicate_source', message: '每份原稿只能保存一组信息。' });
    sourceIds.add(source.material_id);
    if (source.offering && (!source.market || !(MARKET_OFFERINGS[source.market] as readonly string[]).includes(source.offering)))
      errors.push({ field, code: 'invalid_source_scope', message: '原稿市场与品种不匹配。' });
    errors.push(...updateDetailsErrors({ ...emptyUpdateDetails(), target_reporting_periods: source.reporting_periods }).map(e => ({ ...e, field: `${field}.${e.field}` })));
  }
  if (details.reporting_cutoff) {
    const parsed = new Date(`${details.reporting_cutoff}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== details.reporting_cutoff) {
      errors.push({ field: 'update_details.reporting_cutoff', code: 'invalid_date', message: '请填写有效的财务截止日。' });
    }
  }
  const seenPeriods = new Set<string>();
  for (const [index, period] of (details.target_reporting_periods ?? []).entries()) {
    const dates = [period.start, period.end];
    for (const [name, value] of [['start', period.start], ['end', period.end]] as const) {
      if (value) {
        const parsed = new Date(`${value}T00:00:00Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
          errors.push({ field: `update_details.target_reporting_periods.${index}.${name}`, code: 'invalid_date', message: '请填写有效的目标报告期日期。' });
        }
      }
    }
    if (period.start && period.end && period.start > period.end) {
      errors.push({ field: `update_details.target_reporting_periods.${index}`, code: 'invalid_range', message: '目标报告期起始日不能晚于截止日。' });
    }
    if ((!period.start || !period.end || !period.period_kind || !period.scope) && period.status !== 'needs_confirmation') {
      errors.push({ field: `update_details.target_reporting_periods.${index}.status`, code: 'confirmation_required', message: '日期、期间类型或报表口径不完整的目标报告期必须标为待确认。' });
    }
    if (period.evidence_refs.length > 0) {
      errors.push({ field: `update_details.target_reporting_periods.${index}.evidence_refs`, code: 'evidence_unavailable', message: '目标报告期证据引用尚未接入校验，不能保存为已核验证据。' });
    }
    const key = JSON.stringify([period.period_kind, ...dates, period.scope]);
    if (seenPeriods.has(key)) {
      errors.push({ field: `update_details.target_reporting_periods.${index}`, code: 'duplicate_period', message: '目标报告期中存在完全重复的期间、类型和报表口径。' });
    }
    seenPeriods.add(key);
  }
  if (details.registration_amount && details.issuance_amount && moneyInMicroYuan(details.issuance_amount) > moneyInMicroYuan(details.registration_amount)) {
    errors.push({ field: 'update_details.issuance_amount', code: 'exceeds_registration', message: '本期发行金额超过申报／注册总额，请核对金额和单位；未确定的金额可留空。' });
  }
  return errors;
}
