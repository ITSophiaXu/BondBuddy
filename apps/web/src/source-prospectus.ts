import { MARKET_LABELS, MARKET_OFFERINGS, MARKETS, OFFERING_LABELS, SOURCE_RELATIONS, type SourceProspectus, type TargetReportingPeriod } from '@bondbuddy/contracts';
import type { Dto } from './api.js';
import { esc } from './ui.js';

const option = (value: string, label: string, active: unknown) => `<option value="${esc(value)}"${value === active ? ' selected' : ''}>${esc(label)}</option>`;
export const annualYears = (periods: readonly TargetReportingPeriod[] = []) => periods.filter(p => p.period_kind === 'annual').map(p => p.end?.slice(0, 4)).filter(Boolean).join('、');
export const interimEnd = (periods: readonly TargetReportingPeriod[] = []) => periods.find(p => p.period_kind === 'interim')?.end ?? '';
/** Never invent a rolling window from a cutoff: years are explicitly provided by the user. */
export function enteredPeriods(years: string, interim: string): TargetReportingPeriod[] {
  const entries = years.split(/[,，、;；\s]+/).filter(Boolean);
  const periods: TargetReportingPeriod[] = entries.map(year => ({ start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }));
  if (interim) periods.push({ start: `${interim.slice(0, 4)}-01-01`, end: interim, period_kind: 'interim', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] });
  return periods;
}
export function sourceFields(material: Dto<'MaterialResponse'>, sources: readonly SourceProspectus[] = []) {
  if (!['historical', 'reference'].includes(material.role)) return '';
  const source = sources.find(s => s.material_id === material.material_id && s.material_version === material.material_version && s.sha256 === material.sha256);
  return `<fieldset class="source-prospectus update-grid" data-source-material="${esc(material.material_id)}"><legend>原稿信息（与本次目标分开保存）</legend>
    <label>原发行人名称<input data-source-field="issuer_name" maxlength="200" value="${esc(source?.issuer_name ?? '')}"></label>
    <label>与目标发行人的关系<select aria-label="与目标发行人的关系" data-source-field="relation"><option value="">请选择</option>${Object.entries(SOURCE_RELATIONS).map(([key, label]) => option(key, label, source?.relation)).join('')}</select></label>
    <label>原发行市场<select aria-label="原发行市场" data-source-field="market"><option value="">请选择</option>${MARKETS.map(key => option(key, MARKET_LABELS[key], source?.market)).join('')}</select></label>
    <label>原品种<select aria-label="原品种" data-source-field="offering"><option value="">请选择</option>${(source?.market ? MARKET_OFFERINGS[source.market] : []).map(key => option(key, OFFERING_LABELS[key], source?.offering)).join('')}</select></label>
    <label>原报告年度<input data-source-field="years" value="${esc(annualYears(source?.reporting_periods))}" placeholder="例如：2022、2023、2024"></label>
    <label>原一期截止日（无则留空）<input type="date" data-source-field="interim" value="${esc(interimEnd(source?.reporting_periods))}"></label>
    <small>按原稿合并报表覆盖期间填写，非债券发行期次；关系以本次目标发行人为参照。</small></fieldset>`;
}
export function readSourceFields(element: HTMLElement, material: Dto<'MaterialResponse'>): SourceProspectus {
  const value = (name: string) => element.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-source-field="${name}"]`)!.value.trim();
  const market = value('market') as SourceProspectus['market'];
  const offering = value('offering') as SourceProspectus['offering'];
  return { material_id: material.material_id, material_version: material.material_version, sha256: material.sha256,
    issuer_name: value('issuer_name') || null, relation: value('relation') as SourceProspectus['relation'] || null,
    market: market || null, offering: market && offering && (MARKET_OFFERINGS[market] as readonly string[]).includes(offering) ? offering : null,
    reporting_periods: enteredPeriods(value('years'), value('interim')), status: 'user_asserted' };
}
