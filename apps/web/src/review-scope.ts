import { MARKET_LABELS, OFFERING_LABELS, type Market, type Offering } from '@bondbuddy/contracts';
import { esc } from './ui';
import './review-scope.css';

/** Scope guidance for the current file-review flow; never a claim of completed checks. */
export function reviewRuleScope(market: Market | null, offering: Offering | null): string {
  if (!market || !offering) return '<p class="review-scope-note">选择发行市场和品种后，这里会显示对应的规范范围。未确定时可先保存项目。</p>';
  const label = `${MARKET_LABELS[market]} · ${OFFERING_LABELS[offering]}`;
  const exchange = market === 'sse' ? '上海证券交易所' : '深圳证券交易所';
  const rules = market === 'nafmii'
    ? ['《银行间债券市场非金融企业债务融资工具管理办法》',
      offering === 'ppn' ? '非公开定向发行规则及定向发行协议的披露要求' : offering === 'dfi' ? '分层分类管理、统一注册及具体发行工具的披露要求' : `《银行间债券市场非金融企业债务融资工具信息披露规则》及${OFFERING_LABELS[offering]}相关指引`,
      '注册文件、募集资金用途、持有人保护及存续期信息披露要求']
    : ['《公司债券发行与交易管理办法》',
      `${exchange}${offering === 'private' ? '非公开发行公司债券挂牌' : '公司债券发行上市审核及上市'}规则`,
      `${exchange}募集说明书编制／参考文本、申请文件及信息披露指引`,
      '募集资金管理、受托管理与债券持有人会议等配套规范'];
  return `<p class="review-scope-market">${esc(label)}</p><ul>${rules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ul><p class="review-scope-note">依据本次材料和已载入的规则资料逐项核对。具体条款、版本与适用性在报告中列明；尚未确认的规则或缺少证据的事项标为待核实。</p>`;
}

export function reviewScope(market: Market | null = null, offering: Offering | null = null): string {
  const row = (id: string, number: string, title: string, description: string, content: string, status = '') =>
    `<details class="review-scope-item" data-scope="${id}"><summary><span class="review-scope-number" aria-hidden="true">${number}</span><span class="review-scope-copy"><strong>${title}${status ? `<small class="review-scope-status">${status}</small>` : ''}</strong><span>${description}</span></span><span class="review-scope-toggle" aria-hidden="true"><span class="scope-show">查看详情</span><span class="scope-hide">收起详情</span><svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"/></svg></span></summary><div class="review-scope-body">${content}</div></details>`;
  return `<section class="review-scope-guide" aria-label="复核范围说明"><div class="review-scope-heading"><h3>本次会复核什么</h3><span>展开查看检查项与依据</span></div>
    ${row('financial', '01', '财务数据核对', '对照报表、审计报告和附注，找出数字与口径差异。', `<div><h4>检查哪些信息</h4><ul><li>金额、单位、币种、报告期及合并／母公司口径是否一致。</li><li>报表合计、跨表勾稽、财务指标与分析文字是否相符。</li><li>募集书不同章节中的同一数据是否一致，是否有缺项或识别疑义。</li></ul></div><div><h4>使用哪些依据</h4><p>你上传的审计报告、年度及最近一期财务报表、附注等材料。</p><p class="review-scope-note">结果列出原文位置、对照值与计算依据；缺少材料的项目会说明无法核对的原因。</p></div>`)}
    ${row('compliance', '02', '合规与披露', '按发行市场和品种，检查披露完整性、条款与前后一致性。', `<div><h4>检查哪些信息</h4><ul><li>发行条件与条款、募集资金用途、偿债安排和投资者保护。</li><li>发行人及控制关系、业务与财务、重大事项和风险因素的必要披露。</li><li>章节、引用、声明签章及可识别的文档格式是否存在缺漏或矛盾。</li></ul></div><div><h4>核对哪些规范</h4><div data-review-rule-scope>${reviewRuleScope(market, offering)}</div></div>`)}
    ${row('public', '03', '公开信息核验', '对照你上传的公开资料，核实主体、信用及重大事项的披露。', `<div><h4>需要核验哪些信息</h4><ul><li>工商与控制关系：企业名称、信用代码、登记状态、股东及实际控制人变动。</li><li>债券与信用：存续债券、评级变动、兑付及违约公告。</li><li>诉讼与处罚：重大诉讼、被执行、失信及行政处罚记录。</li><li>重大事项：重组、担保及其他可能影响偿债能力的公开公告。</li></ul></div><div><h4>目前如何核验</h4><p>当前复核不会自动访问工商网站或查询商业数据库。请在下一步上传查询报告、公告正文或带来源与日期的截图，供募集书交叉核对。</p><p class="review-scope-note">可补充国家企业信用信息公示系统、信用中国、中国执行信息公开网、交易所及发行人公告等来源。核对同一主体与事实时点；没有材料或未检索的事项保留为“未核实”，不据此认定无风险。</p></div>`, '暂未自动联网核验')}
  </section>`;
}
