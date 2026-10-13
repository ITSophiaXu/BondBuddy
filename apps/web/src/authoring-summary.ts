import { reportBlocks, reportBlockHtml, reportInline } from './review-report-document.js';

const sectionNames: Record<string, string> = {
  '交付文件': '生成的文件', '基线与范围': '本次更新范围', '已经更新': '已更新的内容',
  '保留而无需机械改动': '保留的原有内容', '缺材料未更新或尚待核实': '需要补充或确认的事项',
  '知识、核对与局限': '使用依据与核对范围'
};

/** Presentation of saved notes only: preserve qualifications and never infer completed work. */
export function authoringSummary(items: string[]): string {
  const text = items.join('\n\n').replace(/\r\n?/g, '\n')
    .replace(/\*\*([^*\n]{1,24})[。：:]\*\*\s*/g, (original, title: string) =>
      sectionNames[title] ? `\n\n## ${sectionNames[title]}\n\n` : original)
    .replace(/`?tracked\.docx`?/g, '修订版 Word')
    .replace(/`?clean\.docx`?/g, '清洁版 Word')
    .replace(/`?baseline\.docx`?/g, '编制前的对照稿')
    .replace(/DOCX包/g, 'Word 文件').replace(/DOCX/g, 'Word')
    .replace(/有效基线|原稿基线|编制基线|编辑基线/g, '编制前的对照稿')
    .replace(/原稿与基线文件哈希/g, '原稿与对照稿的文件一致性')
    .replace(/拒绝本轮新增修订后可回还原基线/g, '撤销本轮修改后能恢复编制前的内容');
  return reportBlocks(text).flatMap((block, index) => {
    if (block.kind === 'heading') {
      if (index === 0 && block.level === 1 && /(?:募集|交付|编制).*说明/.test(block.text)) return [];
      const title = block.text.replace(/[。：:]$/, '');
      return [`<h3>${reportInline(sectionNames[title] ?? title)}</h3>`];
    }
    // Long prose remains complete, with sentence boundaries supplying readable paragraphs.
    if (block.kind === 'paragraph') {
      const paragraphs: string[] = []; let current = '';
      for (const sentence of block.text.match(/[^。！？]+[。！？]?|[。！？]/g) ?? []) {
        current += sentence;
        if (current.length >= 140) { paragraphs.push(current); current = ''; }
      }
      if (current) paragraphs.push(current);
      return paragraphs.map(text => reportBlockHtml({kind:'paragraph', text}));
    }
    return [reportBlockHtml(block)];
  }).join('');
}
