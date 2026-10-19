import type { WordParagraph } from './word-export.js';
export type ReviewIssue = { id: string; group: string; title: string; location: string; original: string; replacement?: string; reason: string; evidence: string; missing?: string; uncertain?: boolean };
export type ReviewSnapshot = { market: string; issues: ReviewIssue[] };
export type ReviewDecision = { mode: 'suggested' | 'original' | 'manual'; text?: string };
export type ReviewDecisions = Record<string, ReviewDecision>;
export const REVIEW_SCOPE = [
  ['财务数据一致性', '核对不同章节、表格、正文的金额、期间、单位和口径，定位前后差异。'],
  ['勾稽关系', '复算合计、占比、增长率，以及报表与附注间的对应关系。'],
  ['政策要求与重点提示', '按市场、品种和规则版本匹配具体条款，标明触发条件、缺失披露及风险提示。'],
  ['格式与标点', '检查标题、编号和排版；英文与数字语境使用英文标点，中文语境使用中文标点。'],
] as const;
export function reviewExample(market: string): ReviewSnapshot {
  return { market, issues: [
    { id: 'consistency', group: '财务数据一致性', title: '同一期间的营业收入前后不一致', location: '第三节 · 发行人概况 / 示例段落 1', original: '2025 年度，发行人实现营业收入 12.0 亿元。', replacement: '2025 年度，发行人实现营业收入 12.6 亿元。', reason: '示例财务表的同期间、同口径营业收入为 12.6 亿元，统一正文表述。', evidence: '合成示例财务表 A / 营业收入，非上传文件数据。' },
    { id: 'reconciliation', group: '勾稽关系', title: '有息负债合计与明细不符', location: '第六节 · 财务信息 / 示例段落 2', original: '短期借款 3.2 亿元，长期借款 5.6 亿元，合计 8.3 亿元。', replacement: '短期借款 3.2 亿元，长期借款 5.6 亿元，合计 8.8 亿元。', reason: '合成示例中 3.2 + 5.6 = 8.8，修正合计数；真实复核需同时确认科目范围。', evidence: '合成示例借款明细 B。' },
    { id: 'policy', group: '政策要求与重点提示', title: '非经营性往来占款披露与重点提示待确认', location: '重大事项提示 / 示例段落 3', original: '发行人存在非经营性往来占款，相关款项回收风险较小。', reason: market.includes('上交所') ? '参考上交所适用指引第 3 号第十一条，需确认是否触及总资产 3% 的披露条件，并补充风险或重大事项提示。现有示例材料不足，不直接改写结论。' : '上交所第 3 号仅用于展示条款定位方式，不能套用于本项目。需按本项目市场与品种核对适用规则后再判断触发条件。', evidence: '条款定位示例：上交所《公司债券发行上市审核规则适用指引第3号——审核重点关注事项（2025年修订）》第十一条 / EX006 P00030；仓库来源现行效力与专业验收仍待核验。', missing: '非经营性往来占款及资金拆借明细、最近一年经审计总资产、回款安排与可回收性说明；本项目适用的现行规则版本。', uncertain: true },
    { id: 'english', group: '格式与标点', title: '英文与数字语境标点统一', location: '释义及财务信息 / 示例段落 4', original: 'EBITDA（RMB million）：1，234．56', replacement: 'EBITDA (RMB million): 1,234.56', reason: '英文括号、英文冒号和数字千分位、十进制小数点统一使用英文形式；保留原数值。', evidence: '本项目标点规则；混排内容按局部语境判断，不全局替换。' },
    { id: 'chinese', group: '格式与标点', title: '中文句子使用中文标点', location: '募集资金运用 / 示例段落 5', original: '募集资金用于偿还借款,补充流动资金.', replacement: '募集资金用于偿还借款，补充流动资金。', reason: '中文句内分隔和句末标点采用中文逗号、句号。', evidence: '本项目标点规则。' },
  ] };
}
export function reviewText(issue: ReviewIssue, decisions: ReviewDecisions = {}) {
  const d = decisions[issue.id];
  return d?.mode === 'original' ? issue.original : d?.mode === 'manual' ? d.text ?? issue.original : issue.replacement ?? issue.original;
}
export function reviewParagraphs(snapshot: ReviewSnapshot, decisions: ReviewDecisions = {}): WordParagraph[] {
  return snapshot.issues.flatMap(i => [
    { text: i.location, heading: true },
    { text: reviewText(i, decisions), before: i.original, comment: `${i.reason}\n依据：${i.evidence}${i.missing ? '\n待补材料：' + i.missing : ''}${decisions[i.id]?.mode === 'manual' ? '\n用户手动修改，仍需核实依据。' : decisions[i.id]?.mode === 'original' ? '\n用户选择保留原文，本条建议未采用。' : ''}` },
    ...(i.uncertain ? [{ text: `【待人工确认】${i.title}。待补材料：${i.missing}` }] : []),
  ]);
}
