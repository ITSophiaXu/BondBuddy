import type { Job, Project } from './model';
import type { WordParagraph } from './word-export';

export function updateParagraphs(job: Job): WordParagraph[] {
  return [
    { text: '第三节 · 发行人概况 / 合成段落', heading: true },
    { text: '2025 年度，发行人实现营业收入 12.6 亿元。', before: '2025 年度，发行人实现营业收入 11.8 亿元。', comment: '以合成示例的本期财务信息更新，正式编制需核对项目原始依据。' },
    { text: '第六节 · 财务信息 / 合成段落', heading: true },
    { text: '短期借款 3.2 亿元，长期借款 5.6 亿元，合计 8.8 亿元。', before: '短期借款 3.2 亿元，长期借款 5.6 亿元，合计 8.3 亿元。', comment: '示例展示借款合计及正文同步更新。' },
    { text: '募集资金运用 / 合成段落', heading: true },
    { text: '募集资金用于偿还借款，补充流动资金。', before: '募集资金全部用于补充流动资金。', comment: '示例展示本期用途调整。' },
    { text: '【待补充】请补充本期债务明细、财务报表及募集资金使用安排，以确认正式更新内容。' },
    { text: '本轮补充要求：' + (job.input?.draft.requirements || '未填写') },
  ];
}
export function updateDelivery(p: Project, job: Job) {
  return `<div class="pd-review-delivery"><div><strong>更新后的募集说明书</strong><small>修订版保留增删与批注，清洁版保留待补提示。</small></div><div class="pd-actions"><button class="btn primary" data-update-download="tracked">下载修订版</button><button class="btn secondary" data-update-download="clean">下载清洁版</button><button class="btn secondary" data-consistency-start data-project="${p.id}" data-from-job="${job.id}">检查文件一致性</button></div></div><p class="pd-note">可下载合成 Word 示例；没有解析、更新上传的募集书正文。</p>`;
}
