import { reportDocument, reportBlockText, type ReportBlock, type ReportItem } from './review-report-document.js';

export const reviewDimensions = [
  { id: 'financial', title: '财务核对', description: '金额、期间、口径与财务分析是否一致' },
  { id: 'compliance', title: '合规与披露', description: '披露是否完整，条款与表述是否适当' },
  { id: 'public', title: '公开信息核验', description: '公开事实与募集书披露是否一致' },
] as const;
type Dimension = typeof reviewDimensions[number]['id'];
export type BusinessSection = { id: string; title: string; description: string; blocks: ReportBlock[]; items: ReportItem[] };
export type BusinessReport = { dimensions: BusinessSection[]; other: BusinessSection; actions: ReportBlock[] };

// This is a presentation filter, not evidence validation or a change to the saved report.
const metadata = /(?:input\.json|input_hash|输入锁|输入哈希|SHA[- ]?256|\b(?:run_id|call_id|receipt_id|full_review|differential_review)\b|哈希(?:值|一致)|校验(?:输入|通过)|(?:scratch|output)\/)/i;
export function businessText(value: string): string {
  return value.split(/(?<=[。；;\n])/).filter(part => !metadata.test(part))
    .join('').replace(/`?(?:materials|knowledge)\/[\w./-]+`?/g, '所提供材料')
    .replace(/\b[a-f0-9]{64}\b/gi, '')
    .replace(/\bweb[_ -]?search\b/gi, '公开信息检索')
    .replace(/\b(?:Codex CLI|Codex|worker|provider)\b/gi, '系统')
    .replace(/\b(?:P[0-9]{4,}|paragraph_[\w-]+|receipt_[\w-]+)\b/g, '')
    .replace(/`?(?:docx|pdf)\/(?:p|t|page)\/[\w/.-]+`?/g, '')
    .replace(/^\s*[；;，,。]+/, '').trim();
}
function cleanBlock(block: ReportBlock): ReportBlock | undefined {
  if (block.kind === 'rule') return undefined;
  if ('text' in block) {
    if (block.kind === 'code' && /(?:import |require\(|python|node |input\.|\.json|sha256|SELECT )/i.test(block.text)) return undefined;
    const text = businessText(block.text); return text ? { ...block, text } : undefined;
  }
  if (block.kind === 'list') { const items = block.items.map(businessText).filter(Boolean); return items.length ? { ...block, items } : undefined; }
  const headers = block.headers.map(businessText), rows = block.rows.map(row => row.map(businessText)).filter(row => row.some(Boolean));
  return rows.length ? { ...block, headers, rows } : undefined;
}
const clean = (blocks: ReportBlock[]) => blocks.map(cleanBlock).filter((b): b is ReportBlock => !!b);
function explicitDimension(text: string): Dimension | undefined {
  if (/公开信息|公开核验|外部信息|公开来源|工商[与及、/]|舆情|公共信息/.test(text)) return 'public';
  if (/合规|披露|格式核对|条款核对/.test(text)) return 'compliance';
  if (/财务|报表|勾稽/.test(text)) return 'financial';
  return undefined;
}
function itemDimension(item: ReportItem, sectionTitle: string): Dimension | undefined {
  const label = item.blocks.map(reportBlockText).join('\n').match(/(?:复核维度|问题维度|所属维度|维度|分类|类别)[：:、/\s*]*([^\n。；;]{1,60})/);
  if (label) { const named = explicitDimension(label[1]); if (named) return named; }
  const section = explicitDimension(sectionTitle); if (section) return section;
  // Legacy prose has no required machine schema. Only use clear business subjects.
  if (/公开信息|公开来源|公开检索|工商核验|新闻|舆情|网页|网站/.test(item.title)) return 'public';
  if (/现金|资产|负债|营业收入|净利润|盈利|毛利率|财务|报表|附注|勾稽|应收|应付|利润表|金额|单位|审计|到期|Excel/i.test(item.title)) return 'financial';
  if (/披露|条款|募集资金|用途|拟偿|受托|持有人|偿债保障|发行安排|投资者|声明|签章|格式|目录|释义|封面|签署|风险提示|法定代表人|实际控制人|担保|评级/.test(item.title)) return 'compliance';
  if (/工商|诉讼|处罚|失信/.test(item.title)) return 'public';
  return undefined;
}

/** Three business dimensions. Missing findings never mean a dimension passed. */
export function businessReport(markdown: string): BusinessReport {
  // Legacy reports define A/B/C in a technical inventory. Use their business names
  // throughout findings without showing that inventory or inventing source locations.
  const sources = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    const source = /\*\*([A-Z])[,，]\s*(审阅对象|财务比对|中期附注)[：:]\*\*/.exec(line);
    if (source) { const filename = /(?:上传名|文件名)[^《\n]*《([^》]+)》/.exec(line);
      sources.set(source[1], filename?.[1] ?? ({审阅对象:'待复核募集书',财务比对:'财务报表',中期附注:'财务附注'}[source[2]]!));
    }
  }
  if (sources.size) markdown = markdown.replace(/(?<![A-Za-z0-9])([A-Z])(?=[^A-Za-z0-9]|$)/g, (value, key, offset: number) => {
    const before = markdown.slice(Math.max(0, offset - 16), offset), after = markdown.slice(offset + 1, offset + 25);
    // A/B may also be credit grades, share classes or options. Only expand an
    // explicit document reference; leave other business facts byte-for-byte.
    if (/评级|等级|级别|类别|选项|股权|份额/.test(before)) return value;
    const reference = /^\s*(?:[`「《]|docx\/|pdf\/|已经注明|关键|有期间|写|载明|注明|披露|列示|记载|显示|所列|对应)/.test(after)
      || /(?:材料|源稿|附件|参见|对照文件)[：:\s]*$/.test(before);
    return reference ? sources.get(key) ?? value : value;
  });
  const document = reportDocument(markdown);
  const dimensions: BusinessSection[] = reviewDimensions.map(d => ({ ...d, blocks: [], items: [] }));
  const other: BusinessSection = { id: 'other', title: '其他需确认事项', description: '', blocks: [], items: [] };
  const actions: ReportBlock[] = [];
  for (const section of document.sections) {
    const dim = explicitDimension(section.title);
    if (dim) dimensions.find(d => d.id === dim)!.blocks.push(...clean(section.blocks));
    else if (/未覆盖|待补充|待确认/.test(section.title)) {
      for (const block of clean(section.blocks)) {
        const parts = block.kind === 'list' ? block.items.map(text => ({kind:'paragraph' as const,text})) : [block];
        for (const part of parts) { const target = explicitDimension(reportBlockText(part));
          if (target) dimensions.find(d => d.id === target)!.blocks.push(part);
          else actions.push(part);
        }
      }
    } else if (/处理顺序|行动建议|下一步|优先处理/.test(section.title) && !section.items.length) actions.push(...clean(section.blocks));
    else if (!/概览|结论|范围|依据|材料|说明|发现|具体差异|问题清单|问题列表|覆盖/.test(section.title)) other.blocks.push(...clean(section.blocks));
    for (const item of section.items) {
      const target = itemDimension(item, section.title);
      const rendered = { ...item, title: businessText(item.title), blocks: clean(item.blocks) };
      if (rendered.title || rendered.blocks.length) (dimensions.find(d => d.id === target) ?? other).items.push(rendered);
    }
  }
  // Unstructured legacy reports must remain visible, without a fabricated all-clear.
  if (!dimensions.some(d => d.items.length || d.blocks.length) && !other.items.length && !other.blocks.length)
    other.blocks = clean(document.sections.flatMap(s => s.blocks));
  // A legacy report may describe unperformed public verification in its general
  // limitations instead of giving it a separate section. Preserve that limitation.
  const publicSection = dimensions.find(d => d.id === 'public')!;
  if (!publicSection.blocks.length) {
    const statements = markdown.split(/\n|(?<=[。；])/).filter(text => /公开|联网|检索|web.?search/i.test(text)
      && /未|无法|没有|不能|不具备|不可用|关闭/.test(text)
      && !/不提供未经|不得编造|不以模型记忆/.test(text));
    publicSection.blocks.push(...clean(statements.map(text => ({ kind:'paragraph' as const, text }))));
  }
  return { dimensions, other, actions };
}

export function dimensionStatus(section: BusinessSection): string {
  const text = section.blocks.map(reportBlockText).join('\n');
  if (/未(?:执行|开展|完成|进行|核实|覆盖|启用)|无法(?:检索|核验)|不具备.*检索|没有.*检索工具/.test(text)) return '有待核实事项';
  if (section.items.length) return `${section.items.length} 项需关注`;
  return section.blocks.length ? '查看核对结论' : '暂无明确核验结论';
}
