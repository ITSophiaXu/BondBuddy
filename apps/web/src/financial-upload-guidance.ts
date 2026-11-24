import { reportingWindow, type Market, type Offering, type SourceMaterialPin, type SourceProspectus } from '@bondbuddy/contracts';
import { esc } from './ui.js';

/** Compare the target window with periods declared for current, same-issuer historical drafts. */
export function financialUploadGuidance(
  market: Market | null, offering: Offering | null, cutoff: string | null,
  sources: readonly SourceProspectus[] = [], materials: readonly SourceMaterialPin[] = []
) {
  const missing = [!market && '发行市场', !offering && '品种／发行方式', !cutoff && '财务截止日'].filter(Boolean);
  if (missing.length) return { items: [], note: `请先在项目信息中填写${missing.join('、')}，即可查看需要准备的财务期间。` };
  const periods = reportingWindow(market, offering, cutoff);
  if (!periods.length) return { items: [], note: '暂无法确定所需财务期间，请核对项目信息中的市场、品种和财务截止日。' };
  const historical = sources.filter(source => source.relation === 'same_issuer' && materials.some(material =>
    material.role === 'historical' && material.material_id === source.material_id &&
    material.material_version === source.material_version && material.sha256 === source.sha256));
  const covered = (period: typeof periods[number]) => historical.some(source => source.reporting_periods.some(original =>
    original.start === period.start && original.end === period.end && original.period_kind === period.period_kind));
  const needed = periods.filter(period => !covered(period));
  return {
    items: needed.map(period => period.period_kind === 'annual'
      ? `${period.end!.slice(0, 4)}年度审计报告（含财务报表及附注）`
      : `${period.end!.slice(0, 4)}年1—${Number(period.end!.slice(5, 7))}月财务报表`),
    note: historical.length
      ? `${needed.length ? '以上为按当前品种、财务截止日和已填写的本发行人历史募集书报告期计算的待补充期次。' : '按当前品种和财务截止日计算的期次，已由本发行人历史募集书报告期覆盖。'}原稿实际包含完整报表及附注的期间无需重复上传；如原稿缺少报表或附注，仍请补充对应材料。成立不足年限、特殊披露或期间调整，请在补充说明中注明。`
      : '按当前品种和财务截止日的通常口径准备；填写本发行人历史募集书的原稿信息后，将按其报告期更新待补充期次。报告已包含的报表及附注无需重复上传。成立不足年限、特殊披露或期间调整，请在补充说明中注明。'
  };
}

export function renderFinancialUploadGuidance(
  market: Market | null, offering: Offering | null, cutoff: string | null,
  sources: readonly SourceProspectus[] = [], materials: readonly SourceMaterialPin[] = []
) {
  const { items, note } = financialUploadGuidance(market, offering, cutoff, sources, materials);
  return `<aside class="financial-upload-guidance" data-financial-upload-guidance aria-label="需要准备的财务材料" aria-live="polite"><strong>需要准备的财务材料</strong>${items.length ? `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}<p>${esc(note)}</p></aside>`;
}
