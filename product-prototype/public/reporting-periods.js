import { EXCHANGE_OFFERINGS, BANK_OFFERINGS, annualCountFor } from './markets.js';
// Shared by the form and the server so the displayed and processed periods agree.
export function reportingPeriods(latest, offering) {
  const match = /^(20\d{2})-(03-31|06-30|09-30|12-31)$/.exec(latest || '');
  if (!match || ![...EXCHANGE_OFFERINGS,...BANK_OFFERINGS].some(([id])=>id===offering)) throw new Error('请选择有效的报告期和发行方式。');
  const year = Number(match[1]), month = Number(match[2].slice(0, 2));
  const annualCount = annualCountFor(offering);
  const lastAnnualYear = month === 12 ? year : year - 1;
  const periods = Array.from({length: annualCount}, (_, index) => {
    const y = lastAnnualYear - annualCount + index + 1;
    return {label: `${y}年度`, start: `${y}-01-01`, end: `${y}-12-31`, type: 'annual'};
  });
  if (month !== 12) periods.push({label: `${year}年1—${month}月`, start: `${year}-01-01`, end: latest, type: 'interim'});
  const years = annualCount === 2 ? '两年' : '三年';
  return {
    latest, annualCount, hasInterim: month !== 12,
    basis: `${years}${month === 12 ? '（完整年度）' : '一期'}`,
    periods, label: periods.map(p => p.label).join('、'),
    note: month === 12 ? '已选年末，最近一期已并入完整年度，不重复列示。' : '最近一期按年初至所选月末累计，不是单个季度。'
  };
}
