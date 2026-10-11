import { MARKET_LABELS, MARKET_OFFERINGS, MARKETS, OFFERING_LABELS, SOURCE_RELATIONS, reportingWindow, sourceProspectusMissingFields, type SourceProspectus, type TargetReportingPeriod } from '@bondbuddy/contracts';
import type { Dto } from './api.js';
import { esc } from './ui.js';
import { cutoffSelection, quarterCutoff, QUARTER_ENDS } from './reporting-cutoff.js';

const option = (value: string, label: string, active: unknown) => `<option value="${esc(value)}"${value === active ? ' selected' : ''}>${esc(label)}</option>`;
const key = (m: Dto<'MaterialResponse'>) => `${m.material_id}/${m.material_version}/${m.sha256}`;
const selections = new Map<string, { signature: string; year: string; quarter: string }>();
export const clearSourceSelections = () => selections.clear();
export const sourcePeriodSummary = (periods: readonly TargetReportingPeriod[] = []) => periods.length
  ? `原稿报告期：${periods.map(p => p.period_kind === 'annual' && p.end?.endsWith('12-31') && p.start === `${p.end.slice(0,4)}-01-01` ? `${p.end.slice(0, 4)}年` : `${p.start ?? '?'} 至 ${p.end ?? '?'}`).join('、')}`
  : '请选择原稿最新报告期的年份和期末。';
export const sourceRequiredMessage = (source?: SourceProspectus) => {
  const missing = sourceProspectusMissingFields(source);
  return missing.length ? `请补齐${missing.join('、')}后继续。` : '原稿信息已填写完整。';
};
export function sourceFields(material: Dto<'MaterialResponse'>, sources: readonly SourceProspectus[] = []) {
  if (!['historical', 'reference'].includes(material.role)) return '';
  const source = sources.find(s => s.material_id === material.material_id && s.material_version === material.material_version && s.sha256 === material.sha256);
  const cutoff = source?.reporting_periods.map(p => p.end).filter((end): end is string => !!end).sort().at(-1) ?? null;
  const saved = cutoffSelection(cutoff), transient = selections.get(key(material));
  const selection = transient?.signature === JSON.stringify(source?.reporting_periods ?? []) ? transient : saved;
  return `<fieldset class="source-prospectus" data-source-material="${esc(material.material_id)}"><legend>原稿信息（上传后必填）</legend><div class="source-fields">
    <label>与目标发行人的关系<select aria-label="与目标发行人的关系" data-source-field="relation" required><option value="">请选择</option>${Object.entries(SOURCE_RELATIONS).map(([key, label]) => option(key, label, source?.relation)).join('')}</select></label>
    <label>原发行市场<select aria-label="原发行市场" data-source-field="market" required><option value="">请选择</option>${MARKETS.map(key => option(key, MARKET_LABELS[key], source?.market)).join('')}</select></label>
    <label>原品种<select aria-label="原品种" data-source-field="offering" required><option value="">请选择</option>${(source?.market ? MARKET_OFFERINGS[source.market] : []).map(key => option(key, OFFERING_LABELS[key], source?.offering)).join('')}</select></label>
    </div><div class="source-period"><label>原稿最新报告期<select aria-label="原稿最新报告期年份" data-source-field="year">${saved.years.map(y => option(y, `${y} 年`, selection.year)).join('')}</select></label><div class="quarter-grid" role="radiogroup" aria-label="原稿最新报告期期末">${QUARTER_ENDS.map(([v,l]) => `<label class="quarter"><input type="radio" data-source-field="quarter" name="source-quarter-${esc(material.material_id)}" value="${v}"${selection.quarter === v ? ' checked' : ''}>${l}</label>`).join('')}</div><small data-source-period-summary>${esc(sourcePeriodSummary(source?.reporting_periods))}</small>${saved.legacy ? '<small>已保留原稿的实际报告期；选择新的期末后才会调整。</small>' : ''}</div>
    <div class="source-footer"><small>每份已上传的历史／参考募集书都需填写以上信息，用于选择知识和计算积分；原稿与本次目标分开保存。</small><p data-source-required-message role="status">${esc(sourceRequiredMessage(source))}</p></div></fieldset>`;
}
export function readSourceFields(element: HTMLElement, material: Dto<'MaterialResponse'>, previous?: SourceProspectus, changedField?: string): SourceProspectus {
  const value = (name: string) => element.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-source-field="${name}"]`)!.value.trim();
  const market = value('market') as SourceProspectus['market'];
  const offering = value('offering') as SourceProspectus['offering'];
  const selectedOffering = market && offering && (MARKET_OFFERINGS[market] as readonly string[]).includes(offering) ? offering : null;
  const year = value('year'), quarter = element.querySelector<HTMLInputElement>('[data-source-field="quarter"]:checked')?.value ?? '';
  const cutoff = quarterCutoff(year, quarter);
  let periods = previous?.reporting_periods ?? [];
  // Only an explicit period/type edit changes the saved coverage; unrelated edits preserve evidence and scope.
  if (['year','quarter','market','offering'].includes(changedField ?? '') && cutoff) {
    periods = reportingWindow(market || null, selectedOffering, cutoff);
    if (!periods.length) periods = [{ start: `${year}-01-01`, end: cutoff, period_kind: quarter === '12-31' ? 'annual' : 'interim', scope: null, status: 'needs_confirmation', evidence_refs: [] }];
  }
  selections.set(key(material), { signature: JSON.stringify(periods), year, quarter });
  return { material_id: material.material_id, material_version: material.material_version, sha256: material.sha256,
    issuer_name: previous?.issuer_name ?? null, relation: value('relation') as SourceProspectus['relation'] || null,
    market: market || null, offering: selectedOffering,
    reporting_periods: structuredClone(periods), status: 'user_asserted' };
}
