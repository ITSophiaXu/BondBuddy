// Lightweight prototype counterpart of apps/web/src/reporting-period-hints.ts.
// Filename cues are unverified and never change a date or block submission.
export function financialFilenameCutoff(filename) {
  const name = filename.normalize('NFKC').replace(/\s+/g, '');
  if (!/财务|财报|报表|审计|年报|半年报|季度报告/.test(name)) return;
  const ends = new Set();
  for (const match of name.matchAll(/(?<!\d)((?:19|20)\d{2})年(半年度?|上半年|中期|第?[一1]季度|第?[三3]季度|前三季度|1[-—–至~～](?:3|6|9|12)月|(?:3|6|9|12)月末|度|末)/g)) {
    const term = match[2];
    const month = /半|中期/.test(term) ? 6 : /[一1]季度/.test(term) ? 3 : /[三3]季度/.test(term) ? 9
      : /^(度|末)$/.test(term) ? 12 : Number(term.match(/(?:^|[-—–至~～])(3|6|9|12)月/)?.[1]);
    if ([3, 6, 9, 12].includes(month)) ends.add(`${match[1]}-${String(month).padStart(2, '0')}-${month === 3 || month === 12 ? '31' : '30'}`);
  }
  return ends.size === 1 ? [...ends][0] : undefined;
}
const valid = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const label = date => `${date.slice(0, 4)}年${({ '03-31': '3月末', '06-30': '6月末', '09-30': '9月末', '12-31': '末' })[date.slice(5)]}`;
export function periodHint(file, source, target, esc, showFilename = false) {
  if (!valid(target)) return '';
  const isSource = ['historical', 'userReference'].includes(file.role);
  const cutoff = isSource ? `${source?.year}-${source?.quarter}` : ['audit', 'financial', 'interimFinancial', 'notes'].includes(file.role) ? financialFilenameCutoff(file.file.name) : null;
  if (!valid(cutoff) || cutoff <= target) return '';
  const text = isSource
    ? `原稿报告期填写为${label(cutoff)}，晚于本次目标${label(target)}。请核对两个期间是否填反，或是否需要调整本次报告期。`
    : `文件名显示财务期间可能截至${label(cutoff)}，晚于本次目标${label(target)}。请结合报表正文核对是否需要更新本次报告期。`;
  return `<div class="reporting-period-hint" data-reporting-period-hint="${isSource ? 'source' : 'material'}"><p>${showFilename ? `<strong>${esc(file.file.name)}</strong>` : ''}${esc(text)}</p></div>`;
}
