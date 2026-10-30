import { isUnifiedInput, reportingWindow, type BillingTask, type Market, type Offering, type SourceProspectus, type UpdateDetails } from '@bondbuddy/contracts';

export type Classification = { task: BillingTask; reason: string; annualPeriods?:number } | { task: null; reason: string };
/** Uses only the locked user declarations; never infers company identity from a filename. */
export function classifyFixedPrice(manifest: any): Classification {
  if (!isUnifiedInput(manifest)) return { task: null, reason: '此输入仍为旧版，请保存当前项目信息后重新获取报价。' };
  const details = manifest.update_details as UpdateDetails;
  const edit = manifest.authoring.edit_baseline;
  const sources:SourceProspectus[] = edit && manifest.authoring.previous_output ? [{material_id:'selected-output',material_version:1,
    sha256:manifest.authoring.previous_output.sha256,issuer_name:String(manifest.issuer_name),relation:'same_issuer',market:edit.market,
    offering:edit.offering,reporting_periods:edit.reporting_periods,status:'user_asserted'}] : manifest.authoring.source_prospectuses;
  const sourceMaterials = (manifest.materials as { material_id: string; role: string }[] ?? [])
    .filter(m => m.role === 'historical' || m.role === 'reference');
  if (!edit && (sourceMaterials.some(m => !sources.some(s => s.material_id === m.material_id)) || sources.some(s => !s.relation)))
    return { task: null, reason: '原稿企业关系尚不明确，暂未定价；不会按最高档自动收费。' };
  const own = sources.filter(s => s.relation === 'same_issuer');
  if (!own.length) return { task: 'new_authoring', reason: '没有可直接复用的同企业原稿，依据发行人材料编制。' };
  const target = details.target_reporting_periods?.length ? details.target_reporting_periods :
    reportingWindow(manifest.market as Market, manifest.offering as Offering, details.reporting_cutoff);
  if (!manifest.market || !manifest.offering || !target.length)
    return { task: null, reason: '目标市场、品种或报告期尚不能确定报价。' };
  const complete = own.filter(s => s.market && s.offering && s.reporting_periods.length && s.reporting_periods.every(p => p.end && p.period_kind));
  if (complete.length !== own.length) return { task: null, reason: '同企业原稿的市场、品种或报告期尚不能确定报价。' };
  // Prefer a reusable matching template, then the most recent source. Do not combine
  // unrelated templates/periods to invent a cheaper source that never existed.
  const source = [...complete].sort((a, b) =>
    Number(sameTemplate(b)) - Number(sameTemplate(a)) || latest(b).localeCompare(latest(a)))[0];
  function sameTemplate(s: SourceProspectus) { return s.market === manifest.market && s.offering === manifest.offering; }
  function latest(s: SourceProspectus) { return s.reporting_periods.map(p => p.end!).sort().at(-1)!; }
  const covered = new Set(source.reporting_periods.filter(p => p.period_kind === 'annual').map(p => p.end));
  const years = new Set(target.filter(p => p.period_kind === 'annual' && !covered.has(p.end)).map(p => p.end)).size;
  const migration = !sameTemplate(source);
  // 2026-10-03 user decision: annual includes latest interim; content-only uses
  // interim; over three annual periods is capped at the corresponding three-year tier.
  const task: BillingTask = migration ? years <= 1 ? 'migration' : years === 2 ? 'migration_two_years' : 'migration_three_years' :
    years === 0 ? 'interim' : years === 1 ? 'annual' : years === 2 ? 'two_years' : 'three_years';
  return { task, annualPeriods:years, reason: `${migration ? '同企业原稿需迁移市场或主要模板，' : '复用同企业原稿，'}${years ? `新增${years}个完整年度${years>3?'，按三年档封顶':''}，含最新一期。` : '最新一期或纯内容更新。'}` };
}
