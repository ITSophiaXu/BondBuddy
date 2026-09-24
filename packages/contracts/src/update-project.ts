import { Type, type Static } from '@sinclair/typebox';

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
export const UpdateDetailsSchema = Type.Object({
  has_historical: nullable(Type.Boolean()),
  reporting_cutoff: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  registration_amount: Type.Union([MoneySchema, Type.Null()]),
  issuance_amount: Type.Union([MoneySchema, Type.Null()]),
  bond_terms: note(), underwriting: note(), other_agencies: note(), rating_enhancement: note(),
  funding_uses: Type.Array(Type.Object({
    purpose: Type.Union([...FUNDING_PURPOSES.map(purpose => Type.Literal(purpose.code)), Type.Null()]),
    amount: Type.Union([MoneySchema, Type.Null()]),
    details: note(), target: note()
  }, { additionalProperties: false }), { maxItems: PROJECT_FIELD_LIMITS.fundingUses }),
  other_information: note(), supplementary_notes: note()
}, { additionalProperties: false, description: 'User-provided update draft, not extracted or audited facts. PATCH replaces this complete object; omission preserves it.' });
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
  if (details.reporting_cutoff) {
    const parsed = new Date(`${details.reporting_cutoff}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== details.reporting_cutoff) {
      errors.push({ field: 'update_details.reporting_cutoff', code: 'invalid_date', message: '请填写有效的财务截止日。' });
    }
  }
  if (details.registration_amount && details.issuance_amount && moneyInMicroYuan(details.issuance_amount) > moneyInMicroYuan(details.registration_amount)) {
    errors.push({ field: 'update_details.issuance_amount', code: 'exceeds_registration', message: '本期发行金额超过申报／注册总额，请核对金额和单位；未确定的金额可留空。' });
  }
  return errors;
}
