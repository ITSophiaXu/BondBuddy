import { reportingWindow, type Market, type Offering } from '@bondbuddy/contracts';
import { esc } from './ui.js';

/** Preparation guidance uses the same standard window as the project form. */
export function financialUploadGuidance(market: Market | null, offering: Offering | null, cutoff: string | null) {
  const missing = [!market && '发行市场', !offering && '品种／发行方式', !cutoff && '财务截止日'].filter(Boolean);
  if (missing.length) return { items: [], note: `请先在项目信息中填写${missing.join('、')}，即可查看需要准备的财务期间。` };
  const periods = reportingWindow(market, offering, cutoff);
  if (!periods.length) return { items: [], note: '暂无法确定所需财务期间，请核对项目信息中的市场、品种和财务截止日。' };
  return {
    items: periods.map(period => period.period_kind === 'annual'
      ? `${period.end!.slice(0, 4)}年度审计报告（含财务报表及附注）`
      : `${period.end!.slice(0, 4)}年1—${Number(period.end!.slice(5, 7))}月财务报表`),
    note: '按当前品种和财务截止日的通常口径准备；报告已包含的报表及附注无需重复上传。成立不足年限、特殊披露或期间调整，请在补充说明中注明。'
  };
}

export function renderFinancialUploadGuidance(market: Market | null, offering: Offering | null, cutoff: string | null) {
  const { items, note } = financialUploadGuidance(market, offering, cutoff);
  return `<aside class="financial-upload-guidance" data-financial-upload-guidance aria-label="需要准备的财务材料" aria-live="polite"><strong>需要准备的财务材料</strong>${items.length ? `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}<p>${esc(note)}</p></aside>`;
}
