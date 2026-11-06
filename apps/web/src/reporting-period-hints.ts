import type { SourceProspectus } from '@bondbuddy/contracts';
import type { Dto } from './api.js';
import { esc } from './ui.js';

type Material = Pick<Dto<'MaterialResponse'>, 'material_id' | 'material_version' | 'sha256' | 'filename' | 'role'>;
export type PeriodHint = { kind: 'source' | 'material'; materialId: string; filename: string; text: string };

function validDate(value: string | null | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}
export function periodLabel(value: string) {
  const suffix: Record<string, string> = { '03-31': '3月末', '06-30': '6月末', '09-30': '9月末', '12-31': '末' };
  return `${value.slice(0, 4)}年${suffix[value.slice(5)] ?? `${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`}`;
}

/** A filename is a cue to check, never evidence that a financial period was read. */
export function financialFilenameCutoff(filename: string): string | undefined {
  const name = filename.normalize('NFKC').replace(/\s+/g, '');
  if (!/财务|财报|报表|审计|年报|半年报|季度报告/.test(name)) return;
  // Deliberately exclude download dates (2026-10-12), issue years and bare years.
  const ends = new Set<string>();
  for (const match of name.matchAll(/(?<!\d)((?:19|20)\d{2})年(半年度?|上半年|中期|第?[一1]季度|第?[三3]季度|前三季度|1[-—–至~～](?:3|6|9|12)月|(?:3|6|9|12)月末|度|末)/g)) {
    const term = match[2];
    const month = /半|中期/.test(term) ? 6 : /[一1]季度/.test(term) ? 3 : /[三3]季度/.test(term) ? 9
      : /^(度|末)$/.test(term) ? 12 : Number(term.match(/(?:^|[-—–至~～])(3|6|9|12)月/)?.[1]);
    if ([3, 6, 9, 12].includes(month)) ends.add(`${match[1]}-${String(month).padStart(2, '0')}-${month === 3 || month === 12 ? '31' : '30'}`);
  }
  // Multiple explicitly named periods are ambiguous; do not choose one for the user.
  return ends.size === 1 ? [...ends][0] : undefined;
}

export function sourcePeriodHint(material: Material, sources: readonly SourceProspectus[], target: string | null): PeriodHint | undefined {
  if (!validDate(target) || !['historical', 'reference'].includes(material.role)) return;
  const source = sources.find(s => s.material_id === material.material_id && s.material_version === material.material_version && s.sha256 === material.sha256);
  const cutoff = source?.reporting_periods.map(p => p.end).filter(validDate).sort().at(-1);
  if (!cutoff || cutoff <= target) return;
  return { kind: 'source', materialId: material.material_id, filename: material.filename,
    text: `原稿报告期填写为${periodLabel(cutoff)}，晚于本次目标${periodLabel(target)}。请核对两个期间是否填反，或是否需要调整本次报告期。` };
}

export function materialPeriodHint(material: Material, target: string | null): PeriodHint | undefined {
  if (!validDate(target) || !['audit', 'financial', 'interimFinancial', 'notes'].includes(material.role)) return;
  const cutoff = financialFilenameCutoff(material.filename);
  if (!cutoff || cutoff <= target) return;
  return { kind: 'material', materialId: material.material_id, filename: material.filename,
    text: `文件名显示财务期间可能截至${periodLabel(cutoff)}，晚于本次目标${periodLabel(target)}。请结合报表正文核对是否需要更新本次报告期。` };
}

export function reportingPeriodHints(materials: readonly Material[], sources: readonly SourceProspectus[], target: string | null): PeriodHint[] {
  return materials.flatMap(m => { const hint = sourcePeriodHint(m, sources, target) ?? materialPeriodHint(m, target); return hint ? [hint] : []; });
}

export function renderPeriodHint(hint?: PeriodHint, showFilename = false): string {
  return hint ? `<div class="reporting-period-hint" data-reporting-period-hint="${hint.kind}"><p>${showFilename ? `<strong>${esc(hint.filename)}</strong>` : ''}${esc(hint.text)}</p></div>` : '';
}

export function materialPeriodHintSlot(material: Material, target: string | null): string {
  return `<div data-material-period-check="${esc(material.material_id)}" data-period-version="${material.material_version}" data-period-sha="${esc(material.sha256)}" role="status" aria-live="polite">${renderPeriodHint(materialPeriodHint(material, target))}</div>`;
}

/** Updates only warning containers, preserving focus and all date controls. */
export function syncReportingPeriodHints(host: ParentNode, materials: readonly Material[], sources: readonly SourceProspectus[], target: string | null) {
  for (const slot of host.querySelectorAll<HTMLElement>('[data-material-period-check]')) {
    const material = materials.find(m => m.material_id === slot.dataset.materialPeriodCheck && String(m.material_version) === slot.dataset.periodVersion && m.sha256 === slot.dataset.periodSha);
    const html = material ? renderPeriodHint(materialPeriodHint(material, target)) : '';
    if (slot.innerHTML !== html) slot.innerHTML = html;
  }
  for (const row of host.querySelectorAll<HTMLElement>('[data-source-material]')) {
    const material = materials.find(m => m.material_id === row.dataset.sourceMaterial && String(m.material_version) === row.dataset.sourceMaterialVersion && m.sha256 === row.dataset.sourceSha256);
    const slot = row.querySelector<HTMLElement>('[data-source-period-check]');
    const html = material ? renderPeriodHint(sourcePeriodHint(material, sources, target)) : '';
    if (slot && slot.innerHTML !== html) slot.innerHTML = html;
  }
  const targetSlot = host.querySelector<HTMLElement>('[data-target-period-check]');
  const html = reportingPeriodHints(materials, sources, target).map(hint => renderPeriodHint(hint, true)).join('');
  if (targetSlot && targetSlot.innerHTML !== html) targetSlot.innerHTML = html;
}
